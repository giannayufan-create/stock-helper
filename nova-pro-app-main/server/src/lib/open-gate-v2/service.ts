// server/src/lib/open-gate-v2/service.ts — A pool → B cadence (MarketRuntime-backed)

import type { MarketManager } from '../../providers/manager.ts';
import type { MarketRuntime } from '../market-runtime/index.ts';
import {
    loadShadowConfig,
    ShadowEvaluationService,
} from '../shadow/index.ts';
import {
    hashConfig,
    type StrategySignalBridge,
} from '../strategy-signal/index.ts';
import type { ACandidateRaw } from './a-candidate-adapter.ts';
import { ACandidateRepository } from './a-candidate-repository.ts';
import { ACandidateStore } from './a-candidate-store.ts';
import { loadOpenGateConfig, type OpenGateConfig } from './config.ts';
import { OpenConfirmRepository } from './open-confirm-repository.ts';
import {
    evaluateOpenGate,
    resolvePhase,
} from './open-gate-evaluator.ts';
import type { ACandidate, OpenConfirmResult } from './types.ts';
import type { MarketCalendarService } from '../market-calendar/index.ts';

export interface OpenConfirmBatchResult {
    phase: ReturnType<typeof resolvePhase>['phase'];
    as_of: string;
    session_minutes: number;
    count: number;
    pass: number;
    watch: number;
    reject: number;
    early_pass: number;
    provisional: number;
    tradeable_count: number;
    items: OpenConfirmResult[];
    market_regime: string;
    market_score: number;
    warnings: string[];
    evaluate_interval_sec: number;
    a_pool_updated_at: string | null;
}

/**
 * OPEN GATE v2 — B layer.
 * Live cadence unchanged. Market data owned by MarketRuntime (not this service).
 */
export class OpenGateV2Service {
    readonly repo: OpenConfirmRepository;
    readonly candidates: ACandidateRepository;
    private cfg: OpenGateConfig;
    private lastResults = new Map<string, OpenConfirmResult>();
    private lastValid = new Map<string, OpenConfirmResult>();
    private lastEvalAt = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private evaluating = false;
    private lastBatch: OpenConfirmBatchResult | null = null;
    private started = false;
    /** Soft shadow A/B — never affects production return / bridge. */
    private shadow: ShadowEvaluationService | null = null;
    /** Read-only calendar for ex-div gap reference — never mutates weights. */
    private calendar: MarketCalendarService | null = null;
    private aStore: ACandidateStore | null = null;
    private lastHydrateAt: string | null = null;
    private lastHydrateSource: string | null = null;

    constructor(
        private market: MarketManager,
        private runtime: MarketRuntime,
        private signalBridge?: StrategySignalBridge,
        dataDir?: string,
    ) {
        this.cfg = loadOpenGateConfig();
        this.repo = new OpenConfirmRepository();
        this.candidates = new ACandidateRepository();
        if (dataDir) this.aStore = new ACandidateStore(dataDir);
    }

    setDataDir(dataDir: string): void {
        this.aStore = new ACandidateStore(dataDir);
    }

    setMarketCalendar(calendar: MarketCalendarService | null): void {
        this.calendar = calendar;
    }

    private getShadow(): ShadowEvaluationService | null {
        if (!loadShadowConfig().enabled) return null;
        if (!this.shadow) {
            this.shadow = new ShadowEvaluationService(this.runtime);
        }
        return this.shadow;
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        this.cfg = loadOpenGateConfig();
        this.runtime.setProviderName(this.market.name());
        void this.runtime.bootstrap();
        const ms = Math.max(1, this.cfg.evaluate_interval_sec) * 1000;
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => {
            void this.evaluatePool();
        }, ms);
        // Headless: hydrate A pool without waiting for frontend POST
        void this.ensureAPoolHeadless('boot');
        console.log(
            `open-gate-v2: cadence ${this.cfg.evaluate_interval_sec}s (decision support only; A pool headless)`,
        );
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.started = false;
        void this.runtime.syncStocks([], 'OPEN_GATE');
    }

    reloadConfig(): void {
        this.cfg = loadOpenGateConfig(true);
    }

    getLastBatch(): OpenConfirmBatchResult | null {
        return this.lastBatch;
    }

    getResult(symbol: string): OpenConfirmResult | null {
        let r = this.lastResults.get(symbol) ?? null;
        if (!r) return null;

        const now = this.runtime.now().getTime();
        if (
            this.lastEvalAt > 0 &&
            now - this.lastEvalAt > this.cfg.fresh_ttl_sec * 1000
        ) {
            r = { ...r, evaluation_stale: true };
        }

        if (
            (r.open_confirm === 'pass' || r.open_confirm === 'early_pass') &&
            new Date(r.signal_valid_until).getTime() < now
        ) {
            return {
                ...r,
                open_confirm: 'watch',
                tradeable: false,
                tradeable_candidate: false,
                signal_status: 'expired',
                signal_expired: true,
                risks: [...r.risks, '訊號已過期 — 需重新評估'],
            };
        }

        if (r.data_blocked) {
            const valid = this.lastValid.get(symbol);
            if (valid) {
                return {
                    ...valid,
                    data_blocked: true,
                    data_health: r.data_health,
                    tradeable: false,
                    tradeable_candidate: false,
                    risks: [
                        ...new Set([
                            ...valid.risks,
                            `DATA ${r.data_health.toUpperCase()}`,
                        ]),
                    ],
                };
            }
        }
        return r;
    }

    /**
     * Admin/debug only — frontend POST is NOT required for production headless.
     * Prefer ensureAPoolHeadless / applyServerPool.
     */
    async setCandidates(raws: ACandidateRaw[]): Promise<ACandidate[]> {
        const list = this.candidates.replaceFromFrontend(raws);
        this.persistPool(list, 'legacy_frontend');
        await this.activatePool(list);
        this.lastHydrateSource = 'legacy_frontend_post';
        this.lastHydrateAt = new Date().toISOString();
        return list;
    }

    /** Server-owned A pool — never requires POST /open-confirm. */
    async applyServerPool(candidates: ACandidate[]): Promise<ACandidate[]> {
        const list = this.candidates.replaceFromServer(candidates);
        this.persistPool(list, 'server');
        await this.activatePool(list);
        this.lastHydrateSource = 'server_pool';
        this.lastHydrateAt = new Date().toISOString();
        return list;
    }

    /**
     * Headless hydrate: disk EOD snapshot first; optional screener seed if empty.
     * Does not change A/B score formulas or thresholds.
     */
    async ensureAPoolHeadless(
        reason: 'boot' | 'preopen' | 'premarket' | 'restart' | 'manual',
    ): Promise<{
        count: number;
        source: string;
        hydrated: boolean;
    }> {
        if (this.candidates.list().length > 0) {
            if (reason === 'restart' || reason === 'boot') {
                await this.activatePool(this.candidates.list());
            }
            return {
                count: this.candidates.list().length,
                source: this.lastHydrateSource ?? 'memory',
                hydrated: true,
            };
        }

        const fromDisk = await this.hydrateFromPersistence();
        if (fromDisk.count > 0) return fromDisk;

        return this.seedFromServerScreener();
    }

    async hydrateFromPersistence(): Promise<{
        count: number;
        source: string;
        hydrated: boolean;
    }> {
        const snap = this.aStore?.loadLatest() ?? null;
        if (!snap?.candidates?.length) {
            return { count: 0, source: 'none', hydrated: false };
        }
        const list = this.candidates.replaceFromServer(
            snap.candidates.map((c) => ({
                ...c,
                a_score_source: 'server' as const,
            })),
        );
        this.persistPool(list, 'hydrated');
        await this.activatePool(list);
        this.lastHydrateSource = `persistence:${snap.session_date}`;
        this.lastHydrateAt = new Date().toISOString();
        return {
            count: list.length,
            source: this.lastHydrateSource,
            hydrated: true,
        };
    }

    /**
     * Soft EOD seed when no persisted A file — server-owned screener ranking
     * as B-input a_score (a_score_source=server). Does not modify A formula module.
     */
    async seedFromServerScreener(limit = 80): Promise<{
        count: number;
        source: string;
        hydrated: boolean;
    }> {
        try {
            const { runFullScreener } = await import('../tw-full-screener.ts');
            const result = await runFullScreener({
                techLimit: 80,
                tdccLimit: 20,
            });
            const items = (result.items ?? []).slice(0, limit);
            if (!items.length) {
                return { count: 0, source: 'screener_empty', hydrated: false };
            }
            const mapped: ACandidate[] = items
                .map((it, idx) => {
                    const rankScore = Math.max(
                        0,
                        Math.min(
                            100,
                            Math.round(
                                55 +
                                    (it.tech_delta ?? 0) +
                                    (it.streak_delta ?? 0) +
                                    (it.openapi_delta ?? 0) +
                                    Math.max(0, 20 - idx * 0.15),
                            ),
                        ),
                    );
                    const close =
                        typeof it.close === 'number' ? it.close : null;
                    const chg =
                        typeof it.change_price === 'number'
                            ? it.change_price
                            : null;
                    return {
                        symbol: String(it.code ?? '').trim(),
                        name: String(it.name ?? it.code ?? ''),
                        exchange:
                            String(it.market ?? '').toLowerCase() === 'otc'
                                ? ('otc' as const)
                                : ('tse' as const),
                        a_score: rankScore,
                        a_score_source: 'server' as const,
                        prev_close:
                            close != null && chg != null ? close - chg : null,
                        avg_volume_20d: null,
                        avg_amount_20d: null,
                        sector: null,
                        warning_status: false,
                        disposition_status: false,
                        source: 'eod_a' as const,
                        lite: true,
                    };
                })
                .filter((c) => c.symbol.length > 0);

            if (!mapped.length) {
                return { count: 0, source: 'screener_empty', hydrated: false };
            }
            await this.applyServerPool(mapped);
            this.lastHydrateSource = 'server_screener_eod';
            return {
                count: mapped.length,
                source: this.lastHydrateSource,
                hydrated: true,
            };
        } catch (e) {
            console.warn(
                `[open-gate] seedFromServerScreener failed: ${e instanceof Error ? e.message : e}`,
            );
            return { count: 0, source: 'screener_error', hydrated: false };
        }
    }

    getAPoolMeta() {
        return {
            count: this.candidates.list().length,
            updated_at: this.candidates.lastUpdatedAt(),
            hydrate_at: this.lastHydrateAt,
            hydrate_source: this.lastHydrateSource,
            post_required: false as const,
            ui_required: false as const,
        };
    }

    private persistPool(
        list: ACandidate[],
        source: 'server' | 'legacy_frontend' | 'hydrated',
    ): void {
        try {
            this.aStore?.save(list, source);
        } catch (e) {
            console.warn(
                `[open-gate] a-candidate persist failed: ${e instanceof Error ? e.message : e}`,
            );
        }
    }

    private async activatePool(list: ACandidate[]): Promise<void> {
        const symbols = list.map((c) => c.symbol);
        await this.runtime.syncStocks(symbols, 'OPEN_GATE');
        await this.runtime.preloadProfiles(symbols);
        await this.evaluatePool();
    }

    async evaluatePool(): Promise<OpenConfirmBatchResult> {
        if (this.evaluating) {
            return (
                this.lastBatch ?? this.emptyBatch(['evaluate in progress'])
            );
        }
        this.evaluating = true;
        const warnings: string[] = [];
        try {
            this.cfg = loadOpenGateConfig();
            this.runtime.setProviderName(this.market.name());
            if (!this.runtime.profilesReady()) {
                warnings.push(
                    this.runtime.profilesError() ??
                        'historical profile not ready',
                );
            }

            const regime = await this.runtime.evaluateRegime(null);
            warnings.push(...regime.notes);

            const now = this.runtime.now();
            const { phase, sessionMinutes } = resolvePhase(this.cfg, now);
            const items: OpenConfirmResult[] = [];
            const pool = this.candidates.list();

            for (const candidate of pool) {
                const state = this.runtime.getState(candidate.symbol);
                const health = this.runtime.healthReport(candidate.symbol);
                const rvol = this.runtime.rvolSameTime(
                    candidate.symbol,
                    state?.total_volume ?? 0,
                    sessionMinutes,
                );
                const prev = this.lastResults.get(candidate.symbol) ?? null;
                const vwapInfo = this.runtime.vwap(candidate.symbol);

                const gapNorm = this.calendar
                    ? this.calendar.getGapNormalization({
                          symbol: candidate.symbol,
                          todayPrice: state?.last_price ?? 0,
                          openPrice: state?.open ?? null,
                          vendorPrevClose:
                              state?.prev_close && state.prev_close > 0
                                  ? state.prev_close
                                  : candidate.prev_close,
                      })
                    : null;

                const result = evaluateOpenGate({
                    cfg: this.cfg,
                    candidate,
                    state,
                    vwapInfo,
                    rvolSameTime: rvol,
                    regime,
                    health,
                    previous: prev,
                    now,
                    gapNorm,
                });

                if (!result.data_blocked) {
                    this.lastValid.set(candidate.symbol, result);
                }

                this.repo.maybeAppend(
                    prev,
                    result,
                    state?.last_price ?? null,
                    this.cfg,
                );

                this.signalBridge?.onBResult(
                    prev,
                    result,
                    this.runtime,
                    hashConfig(this.cfg),
                );

                // Shadow A/B soft hook — after production bridge; no return mutation
                this.getShadow()?.observeAfterProduction(result, null, {
                    aCandidate: candidate,
                    previousB: prev,
                });

                this.lastResults.set(candidate.symbol, result);
                items.push(result);
            }

            items.sort(
                (a, b) =>
                    Number(b.tradeable_candidate) -
                        Number(a.tradeable_candidate) ||
                    b.final_open_score - a.final_open_score ||
                    b.a_score - a.a_score,
            );

            this.lastEvalAt = this.runtime.now().getTime();
            const batch: OpenConfirmBatchResult = {
                phase,
                as_of: this.runtime.now().toISOString(),
                session_minutes: sessionMinutes,
                count: items.length,
                pass: items.filter((i) => i.open_confirm === 'pass').length,
                watch: items.filter((i) => i.open_confirm === 'watch').length,
                reject: items.filter((i) => i.open_confirm === 'reject')
                    .length,
                early_pass: items.filter(
                    (i) => i.open_confirm === 'early_pass',
                ).length,
                provisional: items.filter(
                    (i) => i.open_confirm === 'provisional',
                ).length,
                tradeable_count: items.filter((i) => i.tradeable_candidate)
                    .length,
                items,
                market_regime: regime.market_regime,
                market_score: regime.market_score,
                warnings,
                evaluate_interval_sec: this.cfg.evaluate_interval_sec,
                a_pool_updated_at: this.candidates.lastUpdatedAt(),
            };
            this.lastBatch = batch;
            return batch;
        } finally {
            this.evaluating = false;
        }
    }

    private emptyBatch(warnings: string[]): OpenConfirmBatchResult {
        return {
            phase: 'after',
            as_of: new Date().toISOString(),
            session_minutes: 0,
            count: 0,
            pass: 0,
            watch: 0,
            reject: 0,
            early_pass: 0,
            provisional: 0,
            tradeable_count: 0,
            items: [],
            market_regime: 'neutral',
            market_score: 50,
            warnings,
            evaluate_interval_sec: this.cfg.evaluate_interval_sec,
            a_pool_updated_at: this.candidates.lastUpdatedAt(),
        };
    }
}
