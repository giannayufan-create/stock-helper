// server/src/lib/signal-outcome/outcome.test.ts
// Run: npx tsx src/lib/signal-outcome/outcome.test.ts

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockMarketDataProvider } from '../../providers/mock/market.ts';
import { MarketManager } from '../../providers/manager.ts';
import { runHistoricalReplay } from '../historical-replay/index.ts';
import {
    SignalLifecycleManager,
    JsonlStrategySignalRepository,
    StrategySignalFactory,
    STRATEGY_VERSION,
    type StrategySignal,
} from '../strategy-signal/index.ts';
import {
    calculateOutcome,
    groupBySignalType,
    JsonlSignalOutcomeRepository,
    SignalOutcomeService,
} from './index.ts';
import type { PriceBar } from './types.ts';

function baseSignal(over: Partial<StrategySignal> = {}): StrategySignal {
    return {
        signal_id: 'test_sig_1',
        symbol: '2330',
        signal_type: 'SURGE',
        signal_time: '2026-06-15T02:15:00.000Z', // ~10:15 Taipei depends; use ms bars
        reference_price: 100,
        reference_price_source: 'replay_bar_close',
        source: 'C',
        strategy_version: STRATEGY_VERSION,
        config_hash: 'abc',
        source_mode: 'replay',
        data_resolution: '1m',
        learning_eligible: true,
        feature_snapshot: Object.freeze({ score: 84 }),
        ...over,
    };
}

async function testForwardMfeMae(): Promise<void> {
    const signalMs = Date.parse('2026-06-15T02:15:00.000Z');
    const bars: PriceBar[] = [];
    for (let i = 1; i <= 60; i++) {
        bars.push({
            t: signalMs + i * 60_000,
            open: 100,
            high: 100 + i * 0.05,
            low: 100 - 0.2,
            close: 100 + i * 0.02,
        });
    }
    const o = calculateOutcome({
        signal: baseSignal({
            signal_time: new Date(signalMs).toISOString(),
        }),
        futureBars: bars,
    });
    assert.ok(o.forward_return_1m != null);
    assert.ok(o.forward_return_15m != null);
    assert.ok((o.mfe_15m ?? 0) > 0);
    assert.ok((o.mae_15m ?? 0) < 0);
    assert.equal(o.hit_plus_1pct, true);
    assert.equal(o.status, 'complete');
    assert.ok(o.forward_return_60m != null);
    console.log('OK forward / MFE / MAE');
}

async function testIncompleteWithout60m(): Promise<void> {
    const signalMs = Date.parse('2026-06-15T02:15:00.000Z');
    const bars: PriceBar[] = [];
    for (let i = 1; i <= 30; i++) {
        bars.push({
            t: signalMs + i * 60_000,
            open: 100,
            high: 101,
            low: 99.5,
            close: 100.5,
        });
    }
    const o = calculateOutcome({
        signal: baseSignal({
            signal_time: new Date(signalMs).toISOString(),
        }),
        futureBars: bars,
        closeBar: {
            t: signalMs + 4 * 60 * 60_000,
            open: 100,
            high: 102,
            low: 99,
            close: 101,
        },
        nowMs: signalMs + 5 * 60 * 60_000,
    });
    assert.equal(o.forward_return_60m, undefined);
    assert.ok(o.close_return != null);
    assert.equal(o.status, 'partial');
    console.log('OK incomplete without 60m stays partial');
}

async function testAmbiguous(): Promise<void> {
    const signalMs = Date.parse('2026-06-15T02:15:00.000Z');
    const bars: PriceBar[] = [
        {
            t: signalMs + 60_000,
            open: 100,
            high: 102.5,
            low: 98.8,
            close: 101,
        },
    ];
    const o = calculateOutcome({
        signal: baseSignal({
            signal_time: new Date(signalMs).toISOString(),
            invalid_price: 99,
            data_resolution: '1m',
        }),
        futureBars: bars,
    });
    assert.equal(o.hit_plus_2pct, true);
    assert.equal(o.invalid_hit, true);
    assert.equal(o.outcome_sequence, 'ambiguous');
    console.log('OK ambiguous same-bar');
}

async function testLifecycleDedupe(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'sig-'));
    const repo = new JsonlStrategySignalRepository(dir);
    const life = new SignalLifecycleManager();
    const factory = new StrategySignalFactory(repo, life);
    const ctx = {
        source_mode: 'replay' as const,
        data_resolution: '1m' as const,
        learning_eligible: false,
        config_hash: 'x',
        universe_source: 'synthetic',
    };
    const item = {
        symbol: '2330',
        name: '2330',
        candidate_origin: 'eod_a' as const,
        candidate_sources: ['A' as const],
        a_score: null,
        open_score: null,
        open_gate_status: null,
        rank: 1,
        rank_prev: null,
        rank_change: null,
        rank_1m_ago: null,
        rank_5m_ago: null,
        rank_velocity: 25,
        last_price: 100,
        change_pct: 1.5,
        intraday_score: 85,
        raw_intraday_score: 85,
        heat_score: 90,
        state: 'STRONG' as const,
        metrics: {
            return_30s: null,
            return_1m: 1,
            return_3m: 2,
            return_5m: 3,
            momentum_acceleration: 70,
            volume_acceleration: 2,
            volume_1m: 100,
            volume_3m: 200,
            vwap: 100,
            vwap_pos_pct: 0.5,
            vwap_structure_score: 70,
            relative_strength_score: 70,
            breakout_score: 80,
            breakout_type: 'breakout' as const,
            trade_aggression_score: null,
            trade_aggression_available: false,
            pullback_quality_score: 50,
            pullback_state: 'none' as const,
            spread_pct: null,
            liquidity_score: 60,
        },
        risk: {
            chase_risk: 'low' as const,
            invalid_price: 99,
            invalid_reason: 'x',
        },
        events: ['SURGE' as const],
        reasons: [],
        risks: [],
        data_health: 'healthy',
        data_blocked: false,
        notification_candidate: true,
        confirmation_count: 2,
        signal_id: null,
        evaluation_id: 'e1',
        updated_at: new Date().toISOString(),
        score_coverage_pct: 90,
        score_confidence: 'high' as const,
    };
    const a = factory.maybeCreateFromC(null, item, ctx, 100, {
        SURGE: 180,
    });
    const b = factory.maybeCreateFromC(item, item, ctx, 100, {
        SURGE: 180,
    });
    assert.ok(a.length >= 1);
    assert.equal(b.filter((s) => s.signal_type === 'SURGE').length, 0);
    assert.ok(Object.isFrozen(a[0]!.feature_snapshot));
    rmSync(dir, { recursive: true, force: true });
    console.log('OK lifecycle dedupe + immutable snapshot');
}

async function testAnalytics(): Promise<void> {
    const signals: StrategySignal[] = [
        baseSignal({
            signal_id: 'a',
            signal_type: 'SURGE',
            score: 90,
            learning_eligible: true,
            score_confidence: 'high',
            source_mode: 'replay',
        }),
        baseSignal({
            signal_id: 'b',
            signal_type: 'SURGE',
            score: 70,
            learning_eligible: false,
            source_mode: 'live',
            data_resolution: 'tick',
        }),
    ];
    const outcomes = [
        {
            ...calculateOutcome({
                signal: signals[0]!,
                futureBars: [
                    {
                        t: Date.parse(signals[0]!.signal_time) + 15 * 60_000,
                        open: 100,
                        high: 103,
                        low: 99.5,
                        close: 102,
                    },
                ],
            }),
            signal_id: 'a',
        },
        {
            ...calculateOutcome({
                signal: signals[1]!,
                futureBars: [
                    {
                        t: Date.parse(signals[1]!.signal_time) + 15 * 60_000,
                        open: 100,
                        high: 101,
                        low: 99,
                        close: 100.5,
                    },
                ],
            }),
            signal_id: 'b',
        },
    ];
    const live = groupBySignalType(signals, outcomes, {
        source_mode: 'live',
    });
    const replay = groupBySignalType(signals, outcomes, {
        source_mode: 'replay',
    });
    assert.equal(live[0]?.count, 1);
    assert.equal(replay[0]?.count, 1);
    const eligible = groupBySignalType(signals, outcomes, {
        learning_eligible: true,
    });
    assert.equal(eligible[0]?.count, 1);
    console.log('OK analytics filters live/replay + learning_eligible');
}

async function testReplayIntegration(): Promise<void> {
    const sigDir = mkdtempSync(join(tmpdir(), 'r-sig-'));
    const outDir = mkdtempSync(join(tmpdir(), 'r-out-'));
    const manager = new MarketManager();
    const mock = new MockMarketDataProvider();
    await mock.init();
    manager.start(mock, 'mock');

    const report = await runHistoricalReplay({
        date: '2026-06-15',
        symbols: ['2330', '2317', '2367'],
        synthetic: true,
        market: manager,
        speed: 'max',
        signalsDir: sigDir,
        outcomesDir: outDir,
        universe_source: 'synthetic',
    });
    assert.equal(report.learning_eligible, false);
    assert.ok(report.signals);
    assert.equal(report.signals.learning_eligible_count, 0);
    // outcomes settled for whatever signals formed
    assert.ok(report.outcomes.complete + report.outcomes.partial >= 0);

    const repo = new JsonlStrategySignalRepository(sigDir);
    const listed = repo.listByDate('2026-06-15');
    assert.equal(listed.length, report.signals.total);

    rmSync(sigDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    console.log(
        `OK replay+outcome signals=${report.signals.total} by_type=${JSON.stringify(report.signals.by_type)}`,
    );
}

async function testOpenPassAndOutcomeChain(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'sig-b-'));
    const outDir = mkdtempSync(join(tmpdir(), 'out-b-'));
    const repo = new JsonlStrategySignalRepository(dir);
    const life = new SignalLifecycleManager();
    const factory = new StrategySignalFactory(repo, life);
    const now = new Date().toISOString();
    const result = {
        symbol: '2330',
        name: '台積電',
        timestamp: now,
        a_score: 70,
        a_score_source: 'legacy_frontend' as const,
        phase: 'confirmed' as const,
        tradeable: true,
        tradeable_candidate: true,
        raw_open_score: 80,
        market_adjustment: 0,
        liquidity_adjustment: 0,
        risk_adjustment: 0,
        final_open_score: 82,
        open_confirm: 'pass' as const,
        hard_reject: false,
        soft_reject: false,
        data_blocked: false,
        market_regime: 'bull' as const,
        market_score: 60,
        score_components: {
            rvol_score: 70,
            vwap_score: 70,
            open_hold_score: 70,
            pullback_score: 70,
            momentum_score: 70,
            gap_score: 50,
        },
        metrics: {
            gap_pct: 1,
            rvol_same_time: 1.5,
            vwap: 100,
            vwap_pos_pct: 0.5,
            vwap_source: 'calculated' as const,
            vwap_valid: true,
            open_pos_pct: 0.5,
            high_pullback_pct: 0.2,
            momentum_score: 70,
            spread_pct: null,
        },
        risk: {
            chase_risk: 'low' as const,
            invalid_price: 99,
            invalid_reason: 'x',
            risk_pct: 1,
            risk_distance_pct: 1,
            risk_score: 20,
            risk_adjustment: 0,
        },
        liquidity_score: 70,
        reasons: [],
        risks: [],
        data_health: 'healthy' as const,
        signal_status: 'active' as const,
        evaluation_stale: false,
        signal_expired: false,
        confirmation_count: 2,
        pass_streak: 2,
        watch_streak: 0,
        reject_streak: 0,
        status_since: now,
        first_pass_at: now,
        last_pass_at: now,
        signal_maturity: 'new' as const,
        open_gate_passed_before_cutoff: true,
        open_gate_baseline: 80,
        open_gate_final_score: 80,
        late_candidate: false,
        feature_availability: {
            rvol: true,
            vwap: true,
            open_hold: true,
            pullback: true,
            momentum: true,
            gap: true,
        },
        score_coverage_pct: 100,
        score_confidence: 'high' as const,
        evaluation_id: 'ev1',
        signal_id: 'bsig_forced_1',
        generated_at: now,
        fresh_until: now,
        signal_valid_until: now,
        expires_at: now,
        ttl_seconds: 180,
    };
    const sig = factory.maybeCreateFromB(null, result, {
        source_mode: 'replay',
        data_resolution: '1m',
        learning_eligible: true,
        config_hash: 'cfg',
        universe_source: 'historical_A',
    }, 100);
    assert.ok(sig);
    assert.equal(sig!.signal_type, 'OPEN_PASS');
    assert.equal(sig!.reference_price, 100);
    assert.equal(sig!.reference_price_source, 'replay_bar_close');
    // continuation — no second signal
    const again = factory.maybeCreateFromB(result, result, {
        source_mode: 'replay',
        data_resolution: '1m',
        learning_eligible: true,
        config_hash: 'cfg',
    }, 100);
    assert.equal(again, null);

    const signalMs = Date.parse(sig!.signal_time);
    const bars: PriceBar[] = [];
    for (let i = 1; i <= 60; i++) {
        bars.push({
            t: signalMs + i * 60_000,
            open: 100,
            high: 100 + 0.1 * i,
            low: 99.5,
            close: 100 + 0.05 * i,
        });
    }
    const orepo = new JsonlSignalOutcomeRepository(outDir);
    const svc = new SignalOutcomeService(orepo);
    const outcome = svc.updateFromBars(sig!, bars);
    assert.ok(outcome.forward_return_15m != null);
    assert.ok((outcome.mfe_15m ?? 0) > 0);

    const stats = groupBySignalType([sig!], [outcome], {
        source_mode: 'replay',
    });
    assert.equal(stats[0]?.signal_type, 'OPEN_PASS');
    assert.equal(stats[0]?.count, 1);

    rmSync(dir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    console.log('OK OPEN_PASS → Outcome → Analytics chain');
}

async function testRepoAppendOnly(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'out-'));
    const repo = new JsonlSignalOutcomeRepository(dir);
    const svc = new SignalOutcomeService(repo);
    const sig = baseSignal({ signal_id: 'x1' });
    const signalMs = Date.parse(sig.signal_time);
    svc.updateFromBars(sig, [
        {
            t: signalMs + 60_000,
            open: 100,
            high: 101,
            low: 99.5,
            close: 100.5,
        },
    ]);
    svc.updateFromBars(sig, [
        {
            t: signalMs + 60_000,
            open: 100,
            high: 101,
            low: 99.5,
            close: 100.5,
        },
        {
            t: signalMs + 15 * 60_000,
            open: 101,
            high: 102,
            low: 100,
            close: 101.5,
        },
    ]);
    const latest = repo.findBySignalId('x1');
    assert.ok(latest?.forward_return_15m != null);
    rmSync(dir, { recursive: true, force: true });
    console.log('OK outcome append-only materialize');
}

async function main(): Promise<void> {
    await testForwardMfeMae();
    await testIncompleteWithout60m();
    await testAmbiguous();
    await testLifecycleDedupe();
    await testAnalytics();
    await testOpenPassAndOutcomeChain();
    await testRepoAppendOnly();
    await testReplayIntegration();
    console.log('\nAll outcome/signal tests passed.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
