// server/src/lib/intraday-rank/service.ts
// C orchestrator: discovery + watch pool + rank cadence (MarketRuntime-backed)

import type { MarketManager } from '../../providers/manager.ts';
import type { MarketRuntime } from '../market-runtime/index.ts';
import type { OpenGateV2Service } from '../open-gate-v2/service.ts';
import {
    loadShadowConfig,
    ShadowEvaluationService,
} from '../shadow/index.ts';
import {
    hashConfig,
    type StrategySignalBridge,
} from '../strategy-signal/index.ts';
import { loadIntradayRankConfig, type IntradayRankConfig } from './config.ts';
import { DiscoveryEngine } from './discovery-engine.ts';
import { runDiscoveryGate } from './discovery-gate.ts';
import { EventEngine } from './event-engine.ts';
import {
    attachRanks,
    scoreIntradaySymbol,
} from './intraday-rank-engine.ts';
import { IntradayRankRepository } from './repository.ts';
import type {
    DiscoveryItem,
    IntradayEvent,
    IntradayRankBatch,
    IntradayRankItem,
} from './types.ts';

/**
 * INTRADAY RANK v1 — C layer.
 * Live 3s evaluate unchanged. Upstream quotes via MarketRuntime only.
 * openGate is used solely for A/B candidate seeding (not market subscriptions).
 */
export class IntradayRankService {
    private cfg: IntradayRankConfig;
    private discovery: DiscoveryEngine;
    private events: EventEngine;
    private repo: IntradayRankRepository;
    private activeWatch = new Map<string, DiscoveryItem>();
    private lastResults = new Map<string, IntradayRankItem>();
    private lastValid = new Map<string, IntradayRankItem>();
    private rankHistory = new Map<
        string,
        Array<{ t: number; rank: number }>
    >();
    private disposition = new Set<string>();
    private scanTimer: ReturnType<typeof setInterval> | null = null;
    private evalTimer: ReturnType<typeof setInterval> | null = null;
    private lastBatch: IntradayRankBatch | null = null;
    private evaluating = false;
    private started = false;
    private marketRetHint: number | null = null;
    private scannerReplayAvailable = true;
    private discoveryCapability:
        | 'live_scanner'
        | 'fixed_universe_only' = 'live_scanner';
    /** Soft shadow A/B — never affects production return / bridge. */
    private shadow: ShadowEvaluationService | null = null;

    constructor(
        private market: MarketManager,
        private runtime: MarketRuntime,
        openGate: OpenGateV2Service,
        private signalBridge?: StrategySignalBridge,
    ) {
        this.cfg = loadIntradayRankConfig();
        this.discovery = new DiscoveryEngine(market, openGate, this.cfg);
        this.events = new EventEngine(this.cfg, this.runtime.clock);
        this.repo = new IntradayRankRepository();
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
        this.cfg = loadIntradayRankConfig();
        this.runtime.setProviderName(this.market.name());
        void this.runtime.bootstrap();
        void this.refreshDisposition();
        void this.discoveryCycle();
        void this.evaluateCycle();
        this.scanTimer = setInterval(
            () => void this.discoveryCycle(),
            Math.max(5, this.cfg.scanner_interval_sec) * 1000,
        );
        this.evalTimer = setInterval(
            () => void this.evaluateCycle(),
            Math.max(1, this.cfg.evaluate_interval_sec) * 1000,
        );
        console.log(
            `intraday-rank: scan ${this.cfg.scanner_interval_sec}s / eval ${this.cfg.evaluate_interval_sec}s`,
        );
    }

    stop(): void {
        if (this.scanTimer) clearInterval(this.scanTimer);
        if (this.evalTimer) clearInterval(this.evalTimer);
        this.scanTimer = null;
        this.evalTimer = null;
        this.started = false;
        void this.runtime.syncStocks([], 'INTRADAY_RANK');
    }

    getLastBatch(): IntradayRankBatch | null {
        return this.lastBatch;
    }

    getDiscoveryPool(): DiscoveryItem[] {
        return this.discovery.getLastPool();
    }

    getEvents(limit = 50): IntradayEvent[] {
        return this.events.getRecent(limit);
    }

    getSymbol(symbol: string): IntradayRankItem | null {
        const r = this.lastResults.get(symbol) ?? null;
        if (!r) return null;
        if (r.data_blocked) {
            const v = this.lastValid.get(symbol);
            if (v) {
                return {
                    ...v,
                    data_blocked: true,
                    data_health: r.data_health,
                    risks: [...v.risks, `DATA ${r.data_health}`],
                };
            }
        }
        return r;
    }

    /**
     * Replay: fixed universe (no scanner).
     * scanner_replay_available=false — do NOT use for discovery success rate.
     */
    seedReplayUniverse(
        symbols: Array<{ symbol: string; name?: string | null }>,
    ): void {
        this.scannerReplayAvailable = false;
        this.discoveryCapability = 'fixed_universe_only';
        this.activeWatch.clear();
        this.rankHistory.clear();
        this.events.clear();
        for (const s of symbols) {
            this.activeWatch.set(s.symbol, {
                symbol: s.symbol,
                name: s.name ?? s.symbol,
                candidate_sources: ['A'],
                candidate_origin: 'eod_a',
                discovery_score: 50,
                a_score: null,
                open_score: null,
                open_gate_status: null,
                scanner_ranks: {},
                change_pct: null,
                total_amount: null,
                total_volume: null,
            });
        }
        void this.runtime.syncStocks(
            symbols.map((s) => s.symbol),
            'INTRADAY_RANK',
        );
    }

    getDiscoveryMeta(): {
        scanner_replay_available: boolean;
        discovery_capability: 'live_scanner' | 'fixed_universe_only';
    } {
        return {
            scanner_replay_available: this.scannerReplayAvailable,
            discovery_capability: this.discoveryCapability,
        };
    }

    /** Replay / tests: one evaluate without scanner cycle. */
    async evaluateOnce(): Promise<IntradayRankBatch | null> {
        await this.evaluateCycle();
        return this.lastBatch;
    }

    private async refreshDisposition(): Promise<void> {
        try {
            const reg = await this.market.regulatoryPunish();
            this.disposition = new Set(reg.code ?? []);
        } catch {
            /* keep previous */
        }
    }

    private async discoveryCycle(): Promise<void> {
        this.cfg = loadIntradayRankConfig();
        this.discovery.setConfig(this.cfg);
        const pool = await this.discovery.refresh(true);
        await this.buildActiveWatch(pool);
    }

    private async buildActiveWatch(pool: DiscoveryItem[]): Promise<void> {
        const top = pool.slice(0, this.cfg.max_active_watch_pool + 20);
        const topSymbols = top.map((t) => t.symbol);
        // Pre-acquire so discovery gate can see stream state
        await this.runtime.acquireStocks(topSymbols, 'INTRADAY_RANK');
        void this.runtime.preloadProfiles(topSymbols.slice(0, 40));

        const eligible: DiscoveryItem[] = [];
        for (const item of pool) {
            const gate = runDiscoveryGate({
                cfg: this.cfg,
                item,
                engine: this.runtime.engine,
                health: this.runtime.health,
                dispositionCodes: this.disposition,
                nowMs: this.runtime.now().getTime(),
            });
            if (gate.status === 'blocked') continue;
            eligible.push(item);
            if (eligible.length >= this.cfg.max_discovery_pool) break;
        }

        eligible.sort((a, b) => b.discovery_score - a.discovery_score);
        const keep = eligible.slice(0, this.cfg.max_active_watch_pool);
        this.activeWatch.clear();
        for (const k of keep) this.activeWatch.set(k.symbol, k);
        await this.runtime.syncStocks(
            keep.map((k) => k.symbol),
            'INTRADAY_RANK',
        );
        await this.runtime.preloadProfiles(keep.map((k) => k.symbol));
    }

    private async evaluateCycle(): Promise<void> {
        if (this.evaluating) return;
        this.evaluating = true;
        try {
            this.cfg = loadIntradayRankConfig();
            try {
                const regime = await this.runtime.evaluateRegime(null);
                this.marketRetHint =
                    regime.market_score != null
                        ? (regime.market_score - 50) / 50
                        : null;
            } catch {
                this.marketRetHint = null;
            }

            const prevRankMap = new Map<string, number>();
            for (const [sym, r] of this.lastResults) {
                prevRankMap.set(sym, r.rank);
            }

            const scored: IntradayRankItem[] = [];
            const clockNow = this.runtime.now();
            const replay = this.runtime.sourceInfo().source_mode === 'replay';
            for (const disc of this.activeWatch.values()) {
                const state = this.runtime.getState(disc.symbol);
                const health = this.runtime.healthReport(disc.symbol);
                const vwapInfo = this.runtime.vwap(disc.symbol);
                const sessionMin = (() => {
                    const parts = new Intl.DateTimeFormat('en-US', {
                        timeZone: 'Asia/Taipei',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                    }).formatToParts(clockNow);
                    const hh = Number(
                        parts.find((p) => p.type === 'hour')?.value ?? 0,
                    );
                    const mm = Number(
                        parts.find((p) => p.type === 'minute')?.value ?? 0,
                    );
                    return Math.max(0, hh * 60 + mm - 9 * 60);
                })();
                const rvol = this.runtime.rvolSameTime(
                    disc.symbol,
                    state?.total_volume ?? 0,
                    sessionMin,
                );
                const prev = this.lastResults.get(disc.symbol) ?? null;
                const item = scoreIntradaySymbol({
                    cfg: this.cfg,
                    discovery: disc,
                    state,
                    vwap: {
                        vwap: vwapInfo.vwap,
                        valid: vwapInfo.valid,
                        available: vwapInfo.available,
                        confidence: vwapInfo.confidence,
                    },
                    rvolSameTime: rvol,
                    health,
                    marketRetHint: this.marketRetHint,
                    previous: prev,
                    now: clockNow,
                    featureFlags: replay
                        ? { trade_aggression: false, bid_ask: false }
                        : undefined,
                });
                scored.push(item);
            }

            const ranked = attachRanks(
                scored,
                prevRankMap,
                this.rankHistory,
                this.cfg,
                clockNow.getTime(),
            ).slice(0, this.cfg.max_ranked_pool);

            for (const item of ranked) {
                const prev = this.lastResults.get(item.symbol) ?? null;
                const evTypes = this.events.evaluate(item, prev);
                item.events = evTypes;
                item.notification_candidate = evTypes.some(
                    (t) =>
                        t === 'SURGE' ||
                        t === 'BREAKOUT' ||
                        t === 'RANK_JUMP' ||
                        t === 'PULLBACK_READY',
                );
                for (const t of evTypes) {
                    const recent = this.events
                        .getRecent(5)
                        .find(
                            (e) =>
                                e.symbol === item.symbol &&
                                e.event_type === t,
                        );
                    if (recent) this.repo.logEvent(recent);
                }
                this.repo.maybeLogRank(prev, item, this.cfg);
                this.signalBridge?.onCResult(
                    prev,
                    item,
                    this.runtime,
                    hashConfig(this.cfg),
                    this.cfg.event_cooldowns_sec,
                );

                // Shadow A/B soft hook — after production bridge; no return mutation
                this.getShadow()?.observeAfterProduction(null, item, {
                    discovery: this.activeWatch.get(item.symbol),
                    previousC: prev,
                    marketRetHint: this.marketRetHint,
                });

                this.lastResults.set(item.symbol, item);
                if (!item.data_blocked) this.lastValid.set(item.symbol, item);
            }

            for (const sym of [...this.lastResults.keys()]) {
                if (!this.activeWatch.has(sym)) this.lastResults.delete(sym);
            }

            this.lastBatch = {
                as_of: this.runtime.now().toISOString(),
                phase_hint: 'intraday',
                count: ranked.length,
                strong: ranked.filter((i) => i.state === 'STRONG').length,
                heating: ranked.filter((i) => i.state === 'HEATING').length,
                emerging: ranked.filter((i) => i.state === 'EMERGING').length,
                items: ranked,
                warnings: this.runtime.profilesReady()
                    ? []
                    : ['歷史盤中基準尚未就緒'],
                evaluate_interval_sec: this.cfg.evaluate_interval_sec,
                scanner_interval_sec: this.cfg.scanner_interval_sec,
            };
        } finally {
            this.evaluating = false;
        }
    }
}
