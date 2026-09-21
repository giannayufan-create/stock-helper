// Shadow multi-experiment evaluation — same MarketRuntime, no extra subscriptions.
// NO acquireStocks. NO StrategySignalBridge. NO production yaml writes. NO auto_promote.

import { randomUUID } from 'node:crypto';
import type { MarketRuntime } from '../market-runtime/index.ts';
import {
    loadIntradayRankConfig,
    type IntradayRankConfig,
} from '../intraday-rank/config.ts';
import { scoreIntradaySymbol } from '../intraday-rank/intraday-rank-engine.ts';
import type {
    DiscoveryItem,
    IntradayRankItem,
} from '../intraday-rank/types.ts';
import {
    loadOpenGateConfig,
    type OpenGateConfig,
} from '../open-gate-v2/config.ts';
import { evaluateOpenGate } from '../open-gate-v2/open-gate-evaluator.ts';
import type {
    ACandidate,
    OpenConfirmResult,
    SymbolMarketState,
} from '../open-gate-v2/types.ts';
import {
    configHashOf,
    INTRADAY_RANK_VERSION,
    OPEN_GATE_VERSION,
    RUNTIME_VERSION,
    STRATEGY_VERSION,
} from '../strategy-signal/index.ts';
import {
    loadShadowConfig,
    mergeNumericOverlay,
    shadowConfigGeneration,
} from './config.ts';
import {
    JsonlShadowRepository,
    type ShadowRepository,
} from './repository.ts';
import { isShadowCashSession, sessionMinuteTaipei } from './session.ts';
import type {
    ShadowComparisonRow,
    ShadowConfig,
    ShadowExperimentDef,
    ShadowSideSnapshot,
    ShadowStrategySignal,
} from './types.ts';

export interface ShadowEvaluationOptions {
    repo?: ShadowRepository;
    shadowConfig?: ShadowConfig;
    persist?: boolean;
    emitShadowSignals?: boolean;
}

export interface EvaluatePairInput {
    symbol: string;
    now?: Date;
    productionB?: OpenConfirmResult | null;
    productionC?: IntradayRankItem | null;
    aCandidate?: ACandidate;
    discovery?: DiscoveryItem;
    previousB?: OpenConfirmResult | null;
    previousC?: IntradayRankItem | null;
    marketRetHint?: number | null;
    market_regime?: string | null;
    session_minute?: number | null;
    candidateB?: OpenConfirmResult | null;
    candidateC?: IntradayRankItem | null;
    persist?: boolean;
    emitShadowSignal?: boolean;
    /** If set, only run this experiment; otherwise all. */
    experiment_id?: string;
}

interface PreparedExperiment {
    def: ShadowExperimentDef;
    openGate: OpenGateConfig;
    intraday: IntradayRankConfig;
    candidateConfigHash: string;
}

function isBSignal(status: string | null | undefined): boolean {
    return status === 'pass' || status === 'early_pass';
}

function isCSignal(state: string | null | undefined): boolean {
    return state === 'STRONG';
}

/** Persist only when prod vs shadow actually diverges (safe for analytics). */
export function isMeaningfulShadowDiff(row: ShadowComparisonRow): boolean {
    const d = row.delta;
    if (d.state_changed) return true;
    if (d.signal_only_production || d.signal_only_shadow) return true;
    if (d.score_delta_b != null && Math.abs(d.score_delta_b) >= 0.01) {
        return true;
    }
    if (d.score_delta_c != null && Math.abs(d.score_delta_c) >= 0.01) {
        return true;
    }
    return false;
}

const C_EVENT_TYPES = new Set([
    'SURGE',
    'BREAKOUT',
    'REBREAK',
    'RANK_JUMP',
    'PULLBACK_READY',
]);

function sideFromB(
    r: OpenConfirmResult | null | undefined,
): ShadowSideSnapshot {
    if (!r) {
        return {
            b_score: null,
            b_status: null,
            c_score: null,
            c_state: null,
            signal_type: null,
            score_coverage_pct: null,
            score_confidence: null,
            learning_eligible: null,
        };
    }
    const learning =
        r.score_confidence !== 'low' &&
        (r.score_coverage_pct == null || r.score_coverage_pct >= 70);
    return {
        b_score: r.final_open_score,
        b_status: r.open_confirm,
        c_score: null,
        c_state: null,
        signal_type: isBSignal(r.open_confirm) ? 'OPEN_PASS' : null,
        score_coverage_pct: r.score_coverage_pct ?? null,
        score_confidence: r.score_confidence ?? null,
        learning_eligible: learning,
    };
}

function sideFromC(
    r: IntradayRankItem | null | undefined,
): ShadowSideSnapshot {
    if (!r) {
        return {
            b_score: null,
            b_status: null,
            c_score: null,
            c_state: null,
            signal_type: null,
            score_coverage_pct: null,
            score_confidence: null,
            learning_eligible: null,
        };
    }
    const eventType =
        r.events?.find((e) => C_EVENT_TYPES.has(String(e))) ?? null;
    let signal_type: string | null = null;
    if (eventType) signal_type = String(eventType);
    else if (isCSignal(r.state)) signal_type = 'STRONG_ENTER';

    const learning =
        r.score_confidence !== 'low' &&
        (r.score_coverage_pct == null || r.score_coverage_pct >= 70) &&
        r.data_health !== 'disconnected';

    return {
        b_score: null,
        b_status: null,
        c_score: r.intraday_score,
        c_state: r.state,
        signal_type,
        score_coverage_pct: r.score_coverage_pct ?? null,
        score_confidence: r.score_confidence ?? null,
        learning_eligible: learning,
    };
}

function mergeSides(
    b: ShadowSideSnapshot,
    c: ShadowSideSnapshot,
): ShadowSideSnapshot {
    const cov =
        b.score_coverage_pct != null && c.score_coverage_pct != null
            ? Math.min(b.score_coverage_pct, c.score_coverage_pct)
            : (b.score_coverage_pct ?? c.score_coverage_pct ?? null);
    const confRank = (x: string | null | undefined) =>
        x === 'low' ? 0 : x === 'medium' ? 1 : x === 'high' ? 2 : 3;
    const conf =
        confRank(b.score_confidence) <= confRank(c.score_confidence)
            ? (b.score_confidence ?? c.score_confidence ?? null)
            : (c.score_confidence ?? b.score_confidence ?? null);
    return {
        b_score: b.b_score,
        b_status: b.b_status,
        c_score: c.c_score,
        c_state: c.c_state,
        signal_type: b.signal_type ?? c.signal_type ?? null,
        score_coverage_pct: cov,
        score_confidence: conf,
        learning_eligible:
            b.learning_eligible === false || c.learning_eligible === false
                ? false
                : (b.learning_eligible ?? c.learning_eligible ?? null),
    };
}

function hasSignal(side: ShadowSideSnapshot): boolean {
    return (
        isBSignal(side.b_status) ||
        isCSignal(side.c_state) ||
        Boolean(side.signal_type)
    );
}

/**
 * Multi-experiment Shadow service.
 * All experiments share one MarketRuntime — never subscribeStocks.
 */
export class ShadowEvaluationService {
    readonly repo: ShadowRepository;
    private shadowCfg: ShadowConfig;
    private prodOpenGate: OpenGateConfig;
    private prodIntraday: IntradayRankConfig;
    private experiments: PreparedExperiment[] = [];
    private productionConfigHash: string;
    private persist: boolean;
    private emitShadowSignals: boolean;
    private shadowConfigOverride: ShadowConfig | null = null;
    private configGen = -1;

    constructor(
        private runtime: MarketRuntime,
        opts: ShadowEvaluationOptions = {},
    ) {
        this.repo = opts.repo ?? new JsonlShadowRepository();
        this.shadowConfigOverride = opts.shadowConfig ?? null;
        this.shadowCfg = opts.shadowConfig ?? loadShadowConfig();
        this.persist = opts.persist !== false;
        this.emitShadowSignals = opts.emitShadowSignals !== false;
        this.prodOpenGate = loadOpenGateConfig();
        this.prodIntraday = loadIntradayRankConfig();
        this.productionConfigHash = '';
        this.reloadConfigs();
    }

    private ensureFreshConfig(): void {
        if (this.shadowConfigOverride) return;
        const gen = shadowConfigGeneration();
        if (gen === this.configGen) return;
        this.reloadConfigs();
    }

    reloadConfigs(): void {
        this.shadowCfg =
            this.shadowConfigOverride ?? loadShadowConfig();
        this.shadowCfg.promotion.auto_promote = false;
        this.configGen = shadowConfigGeneration();

        this.prodOpenGate = loadOpenGateConfig();
        this.prodIntraday = loadIntradayRankConfig();

        this.productionConfigHash = configHashOf({
            open_gate: this.prodOpenGate,
            intraday_rank: this.prodIntraday,
        });

        this.experiments = this.shadowCfg.experiments.map((def) => {
            const openGate = mergeNumericOverlay(
                this.prodOpenGate as unknown as Record<string, unknown>,
                def.open_gate,
            ) as unknown as OpenGateConfig;
            const intraday = mergeNumericOverlay(
                this.prodIntraday as unknown as Record<string, unknown>,
                def.intraday_rank,
            ) as unknown as IntradayRankConfig;
            return {
                def,
                openGate,
                intraday,
                candidateConfigHash: configHashOf({
                    experiment_id: def.experiment_id,
                    open_gate: openGate,
                    intraday_rank: intraday,
                    overlay: {
                        open_gate: def.open_gate ?? {},
                        intraday_rank: def.intraday_rank ?? {},
                    },
                }),
            };
        });
    }

    enabled(): boolean {
        return this.shadowCfg.enabled;
    }

    getConfig(): ShadowConfig {
        return this.shadowCfg;
    }

    getExperiments(): ShadowExperimentDef[] {
        return this.experiments.map((e) => e.def);
    }

    getProductionConfigHash(): string {
        return this.productionConfigHash;
    }

    /** First experiment hash (compat); prefer getCandidateConfigHash(id). */
    getShadowConfigHash(): string {
        return this.experiments[0]?.candidateConfigHash ?? '';
    }

    getCandidateConfigHash(experimentId: string): string | undefined {
        return this.experiments.find((e) => e.def.experiment_id === experimentId)
            ?.candidateConfigHash;
    }

    getCandidateOpenGateConfig(experimentId?: string): OpenGateConfig {
        const ex =
            this.experiments.find(
                (e) => e.def.experiment_id === experimentId,
            ) ?? this.experiments[0];
        return ex?.openGate ?? this.prodOpenGate;
    }

    getCandidateIntradayConfig(experimentId?: string): IntradayRankConfig {
        const ex =
            this.experiments.find(
                (e) => e.def.experiment_id === experimentId,
            ) ?? this.experiments[0];
        return ex?.intraday ?? this.prodIntraday;
    }

    recordComparison(row: ShadowComparisonRow): void {
        this.repo.recordComparison(row);
    }

    /**
     * Soft hook after production eval — re-scores all experiments.
     * Never mutates production results / bridge / subscriptions.
     */
    observeAfterProduction(
        bResult?: OpenConfirmResult | null,
        cItem?: IntradayRankItem | null,
        opts: {
            aCandidate?: ACandidate;
            discovery?: DiscoveryItem;
            previousB?: OpenConfirmResult | null;
            previousC?: IntradayRankItem | null;
            marketRetHint?: number | null;
            session_minute?: number | null;
            now?: Date;
        } = {},
    ): ShadowComparisonRow[] {
        this.ensureFreshConfig();
        if (!this.shadowCfg.enabled) return [];
        const now = opts.now ?? this.runtime.now();
        if (
            this.shadowCfg.session_only !== false &&
            !isShadowCashSession(now)
        ) {
            return [];
        }
        const symbol = bResult?.symbol ?? cItem?.symbol;
        if (!symbol) return [];
        try {
            return this.evaluateAllExperiments({
                symbol,
                now,
                productionB: bResult,
                productionC: cItem,
                aCandidate: opts.aCandidate,
                discovery: opts.discovery,
                previousB: opts.previousB,
                previousC: opts.previousC,
                marketRetHint: opts.marketRetHint,
                market_regime: bResult?.market_regime ?? null,
                session_minute: opts.session_minute ?? sessionMinuteTaipei(now),
            });
        } catch (err) {
            console.warn(
                'shadow observeAfterProduction failed (ignored):',
                err instanceof Error ? err.message : err,
            );
            return [];
        }
    }

    compareSymbol(
        symbol: string,
        opts: Omit<EvaluatePairInput, 'symbol'> = {},
    ): ShadowComparisonRow[] {
        return this.evaluateAllExperiments({ symbol, ...opts });
    }

    /** Compat: run first matching / all experiments; return first row. */
    evaluatePair(input: EvaluatePairInput): ShadowComparisonRow {
        const rows = this.evaluateAllExperiments(input);
        if (!rows.length) {
            throw new Error('no shadow experiments configured');
        }
        return rows[0]!;
    }

    evaluateAllExperiments(input: EvaluatePairInput): ShadowComparisonRow[] {
        const targets = input.experiment_id
            ? this.experiments.filter(
                  (e) => e.def.experiment_id === input.experiment_id,
              )
            : this.experiments;
        return targets.map((ex) => this.evaluateOne(ex, input));
    }

    private evaluateOne(
        ex: PreparedExperiment,
        input: EvaluatePairInput,
    ): ShadowComparisonRow {
        const now = input.now ?? this.runtime.now();
        const state = this.runtime.getState(input.symbol);
        const health = this.runtime.healthReport(input.symbol);
        const vwapInfo = this.runtime.vwap(input.symbol);
        const session_minute =
            input.session_minute ?? sessionMinuteTaipei(now);
        const rvol = this.runtime.rvolSameTime(
            input.symbol,
            state?.total_volume ?? 0,
            session_minute,
        );

        let productionB = input.productionB ?? null;
        let productionC = input.productionC ?? null;
        let candidateB = input.candidateB ?? null;
        let candidateC = input.candidateC ?? null;

        if (!productionB && input.aCandidate) {
            productionB = this.evalB(
                this.prodOpenGate,
                input.aCandidate,
                state,
                vwapInfo,
                rvol,
                health,
                input.previousB ?? null,
                now,
            );
        }

        if (!candidateB && input.aCandidate) {
            candidateB = this.evalB(
                ex.openGate,
                input.aCandidate,
                state,
                vwapInfo,
                rvol,
                health,
                input.previousB ?? null,
                now,
            );
        } else if (!candidateB && productionB && input.aCandidate == null) {
            const stub = stubCandidateFromB(productionB);
            candidateB = this.evalB(
                ex.openGate,
                stub,
                state,
                vwapInfo,
                rvol,
                health,
                input.previousB ?? null,
                now,
            );
        }

        const discovery =
            input.discovery ??
            (productionC ? stubDiscoveryFromC(productionC) : undefined);

        if (!productionC && discovery) {
            productionC = this.evalC(
                this.prodIntraday,
                discovery,
                state,
                vwapInfo,
                rvol,
                health,
                input.marketRetHint ?? null,
                input.previousC ?? null,
                now,
            );
        }

        if (!candidateC && discovery) {
            candidateC = this.evalC(
                ex.intraday,
                discovery,
                state,
                vwapInfo,
                rvol,
                health,
                input.marketRetHint ?? null,
                input.previousC ?? null,
                now,
            );
        }

        const prodSide = mergeSides(
            sideFromB(productionB),
            sideFromC(productionC),
        );
        const shadowSide = mergeSides(
            sideFromB(candidateB),
            sideFromC(candidateC),
        );

        const prodSig = hasSignal(prodSide);
        const shadowSig = hasSignal(shadowSide);

        const score_delta_b =
            prodSide.b_score != null && shadowSide.b_score != null
                ? shadowSide.b_score - prodSide.b_score
                : null;
        const score_delta_c =
            prodSide.c_score != null && shadowSide.c_score != null
                ? shadowSide.c_score - prodSide.c_score
                : null;

        const state_changed =
            (prodSide.b_status ?? null) !== (shadowSide.b_status ?? null) ||
            (prodSide.c_state ?? null) !== (shadowSide.c_state ?? null);

        const row: ShadowComparisonRow = {
            experiment_id: ex.def.experiment_id,
            experiment_label: String(ex.def.label),
            symbol: input.symbol,
            timestamp: now.toISOString(),
            production: prodSide,
            shadow: shadowSide,
            delta: {
                score_delta_b,
                score_delta_c,
                state_changed,
                signal_only_production: prodSig && !shadowSig,
                signal_only_shadow: shadowSig && !prodSig,
            },
            production_config_hash: this.productionConfigHash,
            candidate_config_hash: ex.candidateConfigHash,
            shadow_config_hash: ex.candidateConfigHash,
            market_regime:
                input.market_regime ??
                productionB?.market_regime ??
                null,
            session_minute,
        };

        const shouldPersist = input.persist ?? this.persist;
        if (
            shouldPersist &&
            (!this.shadowCfg.record_diffs_only || isMeaningfulShadowDiff(row))
        ) {
            this.recordComparison(row);
        }

        const shouldEmit = input.emitShadowSignal ?? this.emitShadowSignals;
        if (shouldEmit && shadowSig) {
            const sig = this.buildShadowSignal({
                experiment: ex,
                symbol: input.symbol,
                now,
                candidateB,
                candidateC,
                state,
                market_regime: row.market_regime,
                session_minute,
                side: shadowSide,
            });
            if (sig) this.repo.saveShadowSignal(sig);
        }

        return row;
    }

    private evalB(
        cfg: OpenGateConfig,
        candidate: ACandidate,
        state: SymbolMarketState | undefined,
        vwapInfo: ReturnType<MarketRuntime['vwap']>,
        rvolSameTime: number | null,
        health: ReturnType<MarketRuntime['healthReport']>,
        previous: OpenConfirmResult | null,
        now: Date,
    ): OpenConfirmResult {
        const regime = {
            market_score: 50,
            market_regime: 'neutral' as const,
            market_adjustment: 0,
            components: {
                taiex: { available: false, value: null },
                tpex: { available: false, value: null },
                breadth: { available: false, value: null },
                us_overnight: { available: false, value: null },
            },
            notes: ['shadow-eval'],
        };
        return evaluateOpenGate({
            cfg,
            candidate,
            state,
            vwapInfo,
            rvolSameTime,
            regime,
            health,
            previous,
            now,
        });
    }

    private evalC(
        cfg: IntradayRankConfig,
        discovery: DiscoveryItem,
        state: SymbolMarketState | undefined,
        vwapInfo: ReturnType<MarketRuntime['vwap']>,
        rvolSameTime: number | null,
        health: ReturnType<MarketRuntime['healthReport']>,
        marketRetHint: number | null,
        previous: IntradayRankItem | null,
        now: Date,
    ): IntradayRankItem {
        return scoreIntradaySymbol({
            cfg,
            discovery,
            state,
            vwap: {
                vwap: vwapInfo.vwap,
                valid: vwapInfo.valid,
                available: vwapInfo.available,
                confidence: vwapInfo.confidence,
            },
            rvolSameTime,
            health,
            marketRetHint,
            previous,
            now,
        });
    }

    private buildShadowSignal(args: {
        experiment: PreparedExperiment;
        symbol: string;
        now: Date;
        candidateB: OpenConfirmResult | null;
        candidateC: IntradayRankItem | null;
        state: SymbolMarketState | undefined;
        market_regime?: string | null;
        session_minute?: number | null;
        side: ShadowSideSnapshot;
    }): ShadowStrategySignal | null {
        const b = args.candidateB;
        const c = args.candidateC;
        const fromB = b && isBSignal(b.open_confirm);
        const fromC =
            (c && isCSignal(c.state)) ||
            Boolean(args.side.signal_type && !fromB);
        if (!fromB && !fromC) return null;

        const signal_type = String(
            args.side.signal_type ??
                (fromB ? 'OPEN_PASS' : 'STRONG_ENTER'),
        );
        const score = fromB ? b!.final_open_score : c!.intraday_score;
        const ref =
            args.state?.last_price && args.state.last_price > 0
                ? args.state.last_price
                : 0;
        const info = this.runtime.sourceInfo();
        const learning =
            args.side.learning_eligible === true &&
            args.side.score_confidence !== 'low';

        const sig: ShadowStrategySignal = {
            signal_id: `shadow_${args.experiment.def.experiment_id}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
            symbol: args.symbol,
            name: b?.name ?? c?.name,
            signal_type: signal_type as ShadowStrategySignal['signal_type'],
            signal_time: args.now.toISOString(),
            session_minute: args.session_minute ?? undefined,
            reference_price: ref,
            reference_price_source: 'shadow_runtime_state',
            source: fromB ? 'B' : 'C',
            state: fromB ? b!.open_confirm : c!.state,
            score,
            heat_score: c?.heat_score,
            market_regime: args.market_regime ?? undefined,
            strategy_version: STRATEGY_VERSION,
            config_hash: args.experiment.candidateConfigHash,
            open_gate_version: OPEN_GATE_VERSION,
            intraday_rank_version: INTRADAY_RANK_VERSION,
            runtime_version: RUNTIME_VERSION,
            source_mode: info.source_mode,
            data_resolution:
                info.data_resolution === '1m' ? '1m' : 'tick',
            score_coverage_pct: args.side.score_coverage_pct ?? undefined,
            score_confidence:
                (args.side.score_confidence as
                    | 'high'
                    | 'medium'
                    | 'low'
                    | undefined) ?? undefined,
            learning_eligible: learning,
            universe_source: 'shadow_ab',
            feature_snapshot: {
                shadow: true,
                experiment_id: args.experiment.def.experiment_id,
                b_score: b?.final_open_score ?? null,
                c_score: c?.intraday_score ?? null,
            },
            metadata: {
                research_only: true,
                experiment_id: args.experiment.def.experiment_id,
            },
            shadow: true,
            experiment_id: args.experiment.def.experiment_id,
            experiment_label: String(args.experiment.def.label),
            production_config_hash: this.productionConfigHash,
            candidate_config_hash: args.experiment.candidateConfigHash,
        };
        return sig;
    }
}

function stubCandidateFromB(b: OpenConfirmResult): ACandidate {
    return {
        symbol: b.symbol,
        name: b.name ?? b.symbol,
        exchange: 'unknown',
        a_score: b.a_score,
        a_score_source: b.a_score_source,
        prev_close: null,
        avg_volume_20d: null,
        avg_amount_20d: null,
        sector: null,
        warning_status: false,
        disposition_status: false,
    };
}

function stubDiscoveryFromC(c: IntradayRankItem): DiscoveryItem {
    return {
        symbol: c.symbol,
        name: c.name ?? c.symbol,
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
    };
}
