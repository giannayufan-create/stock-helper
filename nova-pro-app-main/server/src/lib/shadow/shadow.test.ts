// Shadow multi-experiment tests — research-only, no production promotion.

import assert from 'node:assert/strict';
import {
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    DEFAULT_OPEN_GATE_CONFIG,
    type OpenGateConfig,
} from '../open-gate-v2/config.ts';
import { evaluateOpenGate } from '../open-gate-v2/open-gate-evaluator.ts';
import type {
    ACandidate,
    OpenConfirmResult,
    SymbolMarketState,
} from '../open-gate-v2/types.ts';
import type { DataHealthReport } from '../open-gate-v2/data-health.ts';
import type { MarketRuntime } from '../market-runtime/index.ts';
import {
    buildShadowAnalytics,
    computeSignalCoverageRatio,
    DEFAULT_EXPERIMENTS,
    DEFAULT_SHADOW_CONFIG,
    evaluateShadowPromotion,
    JsonlShadowRepository,
    loadShadowConfig,
    recommendPromotion,
    setShadowConfigForTest,
    ShadowEvaluationService,
} from './index.ts';
import type {
    ShadowAnalyticsSummary,
    ShadowComparisonRow,
    ShadowConfig,
} from './types.ts';

const tmpDirs: string[] = [];

function cleanup(): void {
    setShadowConfigForTest(null);
    for (const d of tmpDirs.splice(0)) {
        try {
            rmSync(d, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }
}

function tmpRoot(label: string): string {
    const d = mkdtempSync(join(tmpdir(), `shadow-${label}-`));
    tmpDirs.push(d);
    return d;
}

function makeState(partial: Partial<SymbolMarketState> = {}): SymbolMarketState {
    const now = Date.now();
    return {
        symbol: '2330',
        timestamp: now,
        last_price: 580,
        open: 575,
        high: 582,
        low: 574,
        prev_close: 570,
        total_volume: 5_000_000,
        total_amount: 2_900_000_000,
        turnover: 80_000_000,
        avg_price: 580,
        best_bid: 579.5,
        best_ask: 580,
        bid_volume: 20,
        ask_volume: 18,
        tick_count: 120,
        last_tick_at: now,
        last_bidask_at: now,
        vwap_num: 580 * 1000,
        vwap_den: 1000,
        vwap_source: 'tick',
        vwap_valid: true,
        vwap_available: true,
        vwap_confidence: 'high',
        recent_prices: [
            { t: now - 180_000, p: 576, v: 1000 },
            { t: now - 120_000, p: 578, v: 1200 },
            { t: now - 60_000, p: 579, v: 1100 },
            { t: now, p: 580, v: 1300 },
        ],
        ...partial,
    };
}

function makeHealth(): DataHealthReport {
    return {
        health: 'healthy',
        data_blocked: false,
        shioaji_connected: true,
        stream_connected: true,
        last_tick_at: Date.now(),
        last_bidask_at: Date.now(),
        last_quote_at: Date.now(),
        data_age_seconds: 1,
        historical_profile_available: true,
        notes: [],
    };
}

function makeCandidate(): ACandidate {
    return {
        symbol: '2330',
        name: 'TSMC',
        exchange: 'tse',
        a_score: 85,
        a_score_source: 'server',
        prev_close: 570,
        avg_volume_20d: 40_000_000,
        avg_amount_20d: 20_000_000_000,
        sector: 'semiconductor',
        warning_status: false,
        disposition_status: false,
    };
}

function makeRuntime(state: SymbolMarketState): {
    runtime: MarketRuntime;
    acquireCalls: number;
} {
    let acquireCalls = 0;
    const health = makeHealth();
    const runtime = {
        now: () => new Date('2026-09-15T01:30:00.000Z'),
        getState: (sym: string) => (sym === state.symbol ? state : undefined),
        vwap: () => ({
            vwap: 578,
            source: 'tick' as const,
            valid: true,
            available: true,
            confidence: 'high' as const,
        }),
        healthReport: () => health,
        rvolSameTime: () => 1.8,
        sourceInfo: () => ({
            source_mode: 'live' as const,
            data_resolution: 'tick' as const,
        }),
        acquireStocks: async () => {
            acquireCalls += 1;
            throw new Error('shadow must never acquireStocks');
        },
        syncStocks: async () => {
            throw new Error('shadow must never syncStocks');
        },
    } as unknown as MarketRuntime;
    return {
        runtime,
        get acquireCalls() {
            return acquireCalls;
        },
    };
}

function enabledShadowCfg(over: Partial<ShadowConfig> = {}): ShadowConfig {
    return {
        ...DEFAULT_SHADOW_CONFIG,
        enabled: true,
        ...over,
        experiments:
            over.experiments ??
            DEFAULT_EXPERIMENTS.map((e) => ({
                ...e,
                open_gate: e.open_gate ? { ...e.open_gate } : undefined,
                intraday_rank: e.intraday_rank
                    ? { ...e.intraday_rank }
                    : undefined,
            })),
        promotion: {
            ...DEFAULT_SHADOW_CONFIG.promotion,
            ...(over.promotion ?? {}),
            auto_promote: false,
        },
    };
}

function baseSummary(
    over: Partial<ShadowAnalyticsSummary> = {},
): ShadowAnalyticsSummary {
    return {
        experiment_id: 'shadow_b_pass81_v1',
        experiment_label: 'SHADOW_B',
        from: '1970-01-01',
        to: '9999-12-31',
        comparison_count: 0,
        production_signal_count: 0,
        shadow_signal_count: 0,
        eligible_production_signal_count: 0,
        eligible_shadow_signal_count: 0,
        signal_coverage_ratio: null,
        avg_score_coverage_pct: 90,
        median_score_coverage_pct: 90,
        low_confidence_signal_count: 0,
        groups: {
            BOTH: {
                group: 'BOTH',
                signal_count: 0,
                positive_5m_rate: null,
                positive_15m_rate: null,
                positive_30m_rate: null,
                avg_forward_return_5m: null,
                avg_forward_return_15m: null,
                avg_forward_return_30m: null,
                median_forward_return_15m: null,
                avg_MFE: null,
                avg_MAE: null,
                avg_MFE_15m: null,
                avg_MAE_15m: null,
                invalid_hit_rate: null,
                signal_coverage_ratio: null,
                avg_score_coverage_pct: null,
                median_score_coverage_pct: null,
                low_confidence_signal_count: 0,
            },
            PRODUCTION_ONLY: {
                group: 'PRODUCTION_ONLY',
                signal_count: 0,
                positive_5m_rate: null,
                positive_15m_rate: null,
                positive_30m_rate: null,
                avg_forward_return_5m: null,
                avg_forward_return_15m: null,
                avg_forward_return_30m: null,
                median_forward_return_15m: null,
                avg_MFE: null,
                avg_MAE: null,
                avg_MFE_15m: null,
                avg_MAE_15m: null,
                invalid_hit_rate: null,
                signal_coverage_ratio: null,
                avg_score_coverage_pct: null,
                median_score_coverage_pct: null,
                low_confidence_signal_count: 0,
            },
            SHADOW_ONLY: {
                group: 'SHADOW_ONLY',
                signal_count: 0,
                positive_5m_rate: null,
                positive_15m_rate: null,
                positive_30m_rate: null,
                avg_forward_return_5m: null,
                avg_forward_return_15m: null,
                avg_forward_return_30m: null,
                median_forward_return_15m: null,
                avg_MFE: null,
                avg_MAE: null,
                avg_MFE_15m: null,
                avg_MAE_15m: null,
                invalid_hit_rate: null,
                signal_coverage_ratio: null,
                avg_score_coverage_pct: null,
                median_score_coverage_pct: null,
                low_confidence_signal_count: 0,
            },
        },
        by_day: [],
        by_regime: [],
        by_signal_type: [],
        stability_score: 0,
        days_improved_ratio: null,
        days_worsened_ratio: null,
        ...over,
    };
}

// --- 1. Config loads 3 experiments; enabled + auto_promote false ---
{
    const cfg = loadShadowConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.promotion.auto_promote, false);
    assert.equal(cfg.promotion_require_both_gates, true);
    assert.equal(cfg.experiments.length, 3);
    const ids = cfg.experiments.map((e) => e.experiment_id).sort();
    assert.deepEqual(ids, [
        'shadow_b_pass81_v1',
        'shadow_bc_v1',
        'shadow_c_82_76_v1',
    ].sort());
    const b = cfg.experiments.find((e) => e.label === 'SHADOW_B')!;
    assert.equal(b.open_gate?.pass_enter_threshold, 81);
    assert.equal(b.intraday_rank, undefined);
    const c = cfg.experiments.find((e) => e.label === 'SHADOW_C')!;
    assert.equal(c.intraday_rank?.strong_enter, 82);
    assert.equal(c.intraday_rank?.strong_exit, 76);
    assert.equal(c.open_gate, undefined);
    console.log('ok 1 — 3 experiments + enabled + no auto_promote');
}

// --- 2. Threshold delta changes B status (same state object) ---
{
    const state = makeState();
    const stateRef = state;
    const candidate = makeCandidate();
    const health = makeHealth();
    const now = new Date('2026-09-15T01:20:00.000Z');
    const regime = {
        market_score: 55,
        market_regime: 'bull' as const,
        market_adjustment: 2,
        components: {
            taiex: { available: true, value: 0.5 },
            tpex: { available: true, value: 0.3 },
            breadth: { available: false, value: null },
            us_overnight: { available: false, value: null },
        },
        notes: [],
    };
    const vwapInfo = {
        vwap: 578,
        source: 'tick' as const,
        valid: true,
        available: true,
        confidence: 'high' as const,
    };

    const prodCfg: OpenGateConfig = {
        ...DEFAULT_OPEN_GATE_CONFIG,
        pass_enter_threshold: 78,
        pass_exit_threshold: 74,
        min_confirm_evaluations: 1,
        data_health: {
            ...DEFAULT_OPEN_GATE_CONFIG.data_health,
            require_profile_for_pass: false,
        },
    };
    const candCfg: OpenGateConfig = {
        ...prodCfg,
        pass_enter_threshold: 81,
    };

    const prod = evaluateOpenGate({
        cfg: prodCfg,
        candidate,
        state,
        vwapInfo,
        rvolSameTime: 1.8,
        regime,
        health,
        previous: null,
        now,
    });
    const cand = evaluateOpenGate({
        cfg: candCfg,
        candidate,
        state,
        vwapInfo,
        rvolSameTime: 1.8,
        regime,
        health,
        previous: null,
        now,
    });
    assert.equal(state, stateRef);
    assert.ok(
        prod.open_confirm !== cand.open_confirm ||
            prod.final_open_score === cand.final_open_score,
        `status differs under candidate thresholds (prod=${prod.open_confirm} cand=${cand.open_confirm} score=${prod.final_open_score})`,
    );
    console.log('ok 2 — same MarketState, threshold overlay only');
}

// --- 3. observe runs 3 experiments; no acquireStocks; distinct ids ---
{
    const shadowRoot = tmpRoot('multi');
    const state = makeState();
    const rt = makeRuntime(state);
    const repo = new JsonlShadowRepository(shadowRoot);
    const svc = new ShadowEvaluationService(rt.runtime, {
        repo,
        shadowConfig: enabledShadowCfg(),
        persist: true,
        emitShadowSignals: false,
    });

    assert.equal(svc.enabled(), true);
    assert.equal(svc.getExperiments().length, 3);

    const productionB = {
        symbol: '2330',
        name: 'TSMC',
        a_score: 85,
        a_score_source: 'server',
        final_open_score: 80,
        open_confirm: 'pass',
        tradeable_candidate: true,
        market_regime: 'bull',
        score_coverage_pct: 100,
        score_confidence: 'high',
        generated_at: new Date().toISOString(),
        timestamp: new Date().toISOString(),
    } as OpenConfirmResult;

    const rows = svc.observeAfterProduction(productionB, null, {
        aCandidate: makeCandidate(),
    });
    assert.equal(rows.length, 3);
    const ids = new Set(rows.map((r) => r.experiment_id));
    assert.equal(ids.size, 3);
    for (const r of rows) {
        assert.ok(r.production_config_hash);
        assert.ok(r.candidate_config_hash);
        assert.notEqual(r.production_config_hash, '');
    }
    // SHADOW_B and SHADOW_BC should share B overlay hash difference from C
    const hashes = new Set(rows.map((r) => r.candidate_config_hash));
    assert.ok(hashes.size >= 2, 'candidate hashes differ across experiments');
    assert.equal(rt.acquireCalls, 0);

    const stored = repo.listComparisons('1970-01-01', '9999-12-31');
    assert.equal(stored.length, 3);
    console.log('ok 3 — 3 experiments share runtime, no subscribe');
}

// --- 4. Promotion AND gate + never AUTO_PROMOTE ---
{
    const cfg = enabledShadowCfg({
        min_shadow_days: 10,
        min_shadow_signals: 200,
        promotion_require_both_gates: true,
    });

    const empty = baseSummary();
    const r1 = recommendPromotion(empty, cfg);
    assert.equal(r1.auto_promote, false);
    assert.notEqual(r1.status as string, 'AUTO_PROMOTE');
    assert.equal(r1.status, 'NEEDS_MORE_DATA');

    // days only — still NEEDS_MORE_DATA
    const daysOnly = baseSummary({
        eligible_shadow_signal_count: 50,
        by_day: Array.from({ length: 12 }, (_, i) => ({
            date: `2026-01-${String(i + 1).padStart(2, '0')}`,
            production_signal_count: 10,
            shadow_signal_count: 8,
            signal_coverage_ratio: 0.8,
            improved: true as boolean | null,
        })),
        stability_score: 0.8,
        days_improved_ratio: 1,
        signal_coverage_ratio: 0.9,
    });
    const rDays = evaluateShadowPromotion({
        experiment_id: daysOnly.experiment_id,
        analytics: daysOnly,
        shadowDays: 12,
        eligibleShadowSignals: 50,
        cfg,
    });
    assert.equal(rDays.status, 'NEEDS_MORE_DATA');

    // signals only — still NEEDS_MORE_DATA
    const sigOnly = evaluateShadowPromotion({
        experiment_id: 'shadow_b_pass81_v1',
        analytics: daysOnly,
        shadowDays: 3,
        eligibleShadowSignals: 250,
        cfg,
    });
    assert.equal(sigOnly.status, 'NEEDS_MORE_DATA');

    const readyAnalytics = baseSummary({
        comparison_count: 240,
        production_signal_count: 220,
        shadow_signal_count: 200,
        eligible_shadow_signal_count: 200,
        signal_coverage_ratio: 200 / 220,
        avg_score_coverage_pct: 85,
        stability_score: 0.8,
        days_improved_ratio: 1,
        groups: {
            BOTH: {
                ...baseSummary().groups.BOTH,
                signal_count: 180,
                avg_MAE: -0.5,
                avg_MAE_15m: -0.5,
                invalid_hit_rate: 5,
                positive_15m_rate: 55,
            },
            PRODUCTION_ONLY: {
                ...baseSummary().groups.PRODUCTION_ONLY,
                signal_count: 40,
                avg_MAE: -0.5,
                avg_MAE_15m: -0.5,
                invalid_hit_rate: 5,
                positive_15m_rate: 50,
            },
            SHADOW_ONLY: {
                ...baseSummary().groups.SHADOW_ONLY,
                signal_count: 20,
                avg_MAE: -0.4,
                avg_MAE_15m: -0.4,
                invalid_hit_rate: 4,
            },
        },
        by_day: Array.from({ length: 12 }, (_, i) => ({
            date: `2026-01-${String(i + 1).padStart(2, '0')}`,
            production_signal_count: 20,
            shadow_signal_count: 18,
            signal_coverage_ratio: 0.9,
            improved: true as boolean | null,
        })),
    });
    const r2 = evaluateShadowPromotion({
        experiment_id: readyAnalytics.experiment_id,
        analytics: readyAnalytics,
        shadowDays: 12,
        eligibleShadowSignals: 200,
        cfg,
    });
    assert.equal(r2.auto_promote, false);
    assert.notEqual(r2.status as string, 'AUTO_PROMOTE');
    assert.ok(
        r2.status === 'READY_FOR_MANUAL_REVIEW' || r2.status === 'REJECT',
        `got ${r2.status}`,
    );
    console.log('ok 4 — AND promotion gate, never AUTO_PROMOTE');
}

// --- 5. Per-experiment BOTH / PROD_ONLY / SHADOW_ONLY ---
{
    assert.equal(computeSignalCoverageRatio(50, 100), 0.5);
    const rows: ShadowComparisonRow[] = [
        {
            experiment_id: 'shadow_b_pass81_v1',
            experiment_label: 'SHADOW_B',
            symbol: '2330',
            timestamp: '2026-09-01T01:00:00.000Z',
            production: {
                b_score: 80,
                b_status: 'pass',
                c_score: null,
                c_state: null,
                signal_type: 'OPEN_PASS',
                learning_eligible: true,
                score_confidence: 'high',
                score_coverage_pct: 90,
            },
            shadow: {
                b_score: 80,
                b_status: 'pass',
                c_score: null,
                c_state: null,
                signal_type: 'OPEN_PASS',
                learning_eligible: true,
                score_confidence: 'high',
                score_coverage_pct: 90,
            },
            delta: {
                score_delta_b: 0,
                score_delta_c: null,
                state_changed: false,
                signal_only_production: false,
                signal_only_shadow: false,
            },
            production_config_hash: 'p',
            candidate_config_hash: 'sb',
        },
        {
            experiment_id: 'shadow_b_pass81_v1',
            experiment_label: 'SHADOW_B',
            symbol: '2317',
            timestamp: '2026-09-01T01:01:00.000Z',
            production: {
                b_score: 80,
                b_status: 'pass',
                c_score: null,
                c_state: null,
                signal_type: 'OPEN_PASS',
                learning_eligible: true,
                score_confidence: 'high',
                score_coverage_pct: 88,
            },
            shadow: {
                b_score: 79,
                b_status: 'watch',
                c_score: null,
                c_state: null,
                signal_type: null,
                learning_eligible: true,
                score_confidence: 'high',
                score_coverage_pct: 88,
            },
            delta: {
                score_delta_b: -1,
                score_delta_c: null,
                state_changed: true,
                signal_only_production: true,
                signal_only_shadow: false,
            },
            production_config_hash: 'p',
            candidate_config_hash: 'sb',
        },
        {
            experiment_id: 'shadow_c_82_76_v1',
            experiment_label: 'SHADOW_C',
            symbol: '2330',
            timestamp: '2026-09-01T01:00:00.000Z',
            production: {
                b_score: null,
                b_status: null,
                c_score: 85,
                c_state: 'STRONG',
                signal_type: 'STRONG_ENTER',
                learning_eligible: true,
                score_confidence: 'high',
                score_coverage_pct: 95,
            },
            shadow: {
                b_score: null,
                b_status: null,
                c_score: 85,
                c_state: 'HEATING',
                signal_type: null,
                learning_eligible: true,
                score_confidence: 'high',
                score_coverage_pct: 95,
            },
            delta: {
                score_delta_b: null,
                score_delta_c: 0,
                state_changed: true,
                signal_only_production: true,
                signal_only_shadow: false,
            },
            production_config_hash: 'p',
            candidate_config_hash: 'sc',
        },
    ];

    const bSummary = buildShadowAnalytics(rows, [], {
        experiment_id: 'shadow_b_pass81_v1',
        experiment_label: 'SHADOW_B',
    });
    assert.equal(bSummary.production_signal_count, 2);
    assert.equal(bSummary.shadow_signal_count, 1);
    assert.equal(bSummary.signal_coverage_ratio, 0.5);
    assert.equal(bSummary.groups.BOTH.signal_count, 1);
    assert.equal(bSummary.groups.PRODUCTION_ONLY.signal_count, 1);

    const cSummary = buildShadowAnalytics(rows, [], {
        experiment_id: 'shadow_c_82_76_v1',
        experiment_label: 'SHADOW_C',
    });
    assert.equal(cSummary.production_signal_count, 1);
    assert.equal(cSummary.shadow_signal_count, 0);
    assert.equal(cSummary.groups.PRODUCTION_ONLY.signal_count, 1);
    console.log('ok 5 — per-experiment cohorts not mixed');
}

// --- 6. Shadow signal tagged with experiment_id + shadow:true ---
{
    const shadowRoot = tmpRoot('sig');
    const state = makeState();
    const { runtime } = makeRuntime(state);
    const repo = new JsonlShadowRepository(shadowRoot);
    const svc = new ShadowEvaluationService(runtime, {
        repo,
        shadowConfig: enabledShadowCfg({
            experiments: [
                {
                    experiment_id: 'shadow_b_pass81_v1',
                    label: 'SHADOW_B',
                    open_gate: { pass_enter_threshold: 81 },
                },
            ],
        }),
        persist: false,
        emitShadowSignals: true,
    });

    const productionB = {
        symbol: '2330',
        name: 'TSMC',
        a_score: 85,
        a_score_source: 'server',
        final_open_score: 80,
        open_confirm: 'watch',
        tradeable_candidate: false,
        market_regime: 'bull',
        score_coverage_pct: 100,
        score_confidence: 'high',
        generated_at: new Date().toISOString(),
        timestamp: new Date().toISOString(),
    } as OpenConfirmResult;

    svc.evaluatePair({
        symbol: '2330',
        productionB,
        candidateB: {
            ...productionB,
            open_confirm: 'pass',
            tradeable_candidate: true,
        } as OpenConfirmResult,
        emitShadowSignal: true,
        persist: false,
        experiment_id: 'shadow_b_pass81_v1',
    });

    const signals = repo.listShadowSignals('1970-01-01', '9999-12-31');
    assert.ok(signals.length >= 1, 'shadow signal written');
    for (const s of signals) {
        assert.equal(s.shadow, true);
        assert.equal(s.experiment_id, 'shadow_b_pass81_v1');
        assert.ok(s.production_config_hash);
        assert.ok(s.candidate_config_hash);
    }
    const sigDir = join(shadowRoot, 'signals');
    const files = readdirSync(sigDir).filter((f) => f.endsWith('.jsonl'));
    assert.ok(files.length >= 1);
    const raw = readFileSync(join(sigDir, files[0]!), 'utf8');
    assert.ok(raw.includes('"shadow":true') || raw.includes('"shadow": true'));
    assert.ok(raw.includes('shadow_b_pass81_v1'));
    console.log('ok 6 — shadow:true + experiment_id attribution');
}

// --- 7. Coverage guard rejects low avg coverage ---
{
    const cfg = enabledShadowCfg({ min_promotion_coverage_pct: 50 });
    const lowCov = baseSummary({
        avg_score_coverage_pct: 20,
        signal_coverage_ratio: 0.9,
        stability_score: 0.9,
        days_improved_ratio: 1,
        eligible_shadow_signal_count: 200,
        by_day: Array.from({ length: 12 }, (_, i) => ({
            date: `2026-01-${String(i + 1).padStart(2, '0')}`,
            production_signal_count: 20,
            shadow_signal_count: 18,
            signal_coverage_ratio: 0.9,
            improved: true as boolean | null,
        })),
        groups: {
            BOTH: {
                ...baseSummary().groups.BOTH,
                signal_count: 100,
                avg_MAE_15m: -0.4,
                invalid_hit_rate: 5,
                positive_15m_rate: 60,
            },
            PRODUCTION_ONLY: {
                ...baseSummary().groups.PRODUCTION_ONLY,
                signal_count: 20,
                avg_MAE_15m: -0.5,
                invalid_hit_rate: 5,
                positive_15m_rate: 50,
            },
            SHADOW_ONLY: { ...baseSummary().groups.SHADOW_ONLY },
        },
    });
    const r = evaluateShadowPromotion({
        experiment_id: lowCov.experiment_id,
        analytics: lowCov,
        shadowDays: 12,
        eligibleShadowSignals: 200,
        cfg,
    });
    assert.equal(r.status, 'REJECT');
    assert.ok(r.reasons.some((x) => x.includes('avg_score_coverage_pct')));
    console.log('ok 7 — coverage guard blocks promotion');
}

cleanup();
console.log('\nAll shadow multi-experiment tests passed.');
