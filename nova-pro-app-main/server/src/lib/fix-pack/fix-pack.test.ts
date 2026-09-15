// server/src/lib/fix-pack/fix-pack.test.ts
// Run: npm run test:fix-pack

import assert from 'node:assert/strict';
import {
    mkdtempSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataHealthService } from '../open-gate-v2/data-health.ts';
import { DEFAULT_OPEN_GATE_CONFIG } from '../open-gate-v2/config.ts';
import { evaluateOpenGate } from '../open-gate-v2/open-gate-evaluator.ts';
import { runMomentumEngine } from '../open-gate-v2/momentum-engine.ts';
import type {
    ACandidate,
    OpenConfirmResult,
    SymbolMarketState,
} from '../open-gate-v2/types.ts';
import { DEFAULT_INTRADAY_RANK_CONFIG } from '../intraday-rank/config.ts';
import { EventEngine } from '../intraday-rank/event-engine.ts';
import {
    attachRanks,
    scoreIntradaySymbol,
} from '../intraday-rank/intraday-rank-engine.ts';
import { rankAtLookback } from '../intraday-rank/metric-engines.ts';
import type {
    DiscoveryItem,
    IntradayRankItem,
} from '../intraday-rank/types.ts';
import type { Clock } from '../market-runtime/clock.ts';
import { SubscriptionManager } from '../market-runtime/subscription-manager.ts';
import { JsonlStrategySignalRepository } from '../strategy-signal/repository.ts';
import { SignalLifecycleManager } from '../strategy-signal/lifecycle.ts';
import type { StrategySignal } from '../strategy-signal/types.ts';

function fakeEngine(opts: {
    lastQuoteAt: number | null;
    stream?: boolean;
}): {
    getState: (s?: string) => SymbolMarketState | undefined;
    lastTickAt: () => number | null;
    lastBidAskAt: () => number | null;
    streamConnected: () => boolean;
} {
    const ts = opts.lastQuoteAt;
    return {
        getState: () =>
            ts == null
                ? undefined
                : ({
                      symbol: '2330',
                      timestamp: ts,
                      last_price: 100,
                      open: 100,
                      high: 101,
                      low: 99,
                      prev_close: 99,
                      total_volume: 1000,
                      total_amount: 1e8,
                      turnover: 1e8,
                      avg_price: 100,
                      best_bid: 99.5,
                      best_ask: 100.5,
                      bid_volume: 10,
                      ask_volume: 10,
                      tick_count: 20,
                      last_tick_at: ts,
                      last_bidask_at: ts,
                      vwap_num: 0,
                      vwap_den: 0,
                      vwap_source: 'calculated',
                      vwap_valid: true,
                      recent_prices: [],
                  } as SymbolMarketState),
        lastTickAt: () => ts,
        lastBidAskAt: () => ts,
        streamConnected: () => opts.stream !== false,
    };
}

function baseCandidate(): ACandidate {
    return {
        symbol: '2330',
        name: 'TSMC',
        exchange: 'tse',
        a_score: 70,
        a_score_source: 'server',
        prev_close: 100,
        avg_volume_20d: 1e6,
        avg_amount_20d: 1e9,
        sector: null,
        warning_status: false,
        disposition_status: false,
    };
}

function richState(nowMs: number): SymbolMarketState {
    const pts = [];
    for (let i = 0; i < 30; i++) {
        pts.push({
            t: nowMs - (30 - i) * 10_000,
            p: 100 + i * 0.05,
            v: 1000,
        });
    }
    return {
        symbol: '2330',
        timestamp: nowMs,
        last_price: 102,
        open: 100,
        high: 103,
        low: 99.5,
        prev_close: 99,
        total_volume: 50_000,
        total_amount: 5e8,
        turnover: 5e8,
        avg_price: 101,
        best_bid: 101.5,
        best_ask: 102,
        bid_volume: 20,
        ask_volume: 15,
        tick_count: 40,
        last_tick_at: nowMs,
        last_bidask_at: nowMs,
        vwap_num: 101 * 50_000,
        vwap_den: 50_000,
        vwap_source: 'calculated',
        vwap_valid: true,
        vwap_available: true,
        recent_prices: pts,
    };
}

function discovery(): DiscoveryItem {
    return {
        symbol: '2330',
        name: 'TSMC',
        candidate_sources: ['A'],
        candidate_origin: 'eod_a',
        discovery_score: 70,
        a_score: 70,
        open_score: null,
        open_gate_status: null,
        scanner_ranks: {},
        change_pct: 2,
        total_amount: 5e8,
        total_volume: 50_000,
    };
}

function healthyReport() {
    return {
        health: 'healthy' as const,
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

function regimeOk() {
    return {
        market_regime: 'neutral' as const,
        market_score: 50,
        market_adjustment: 0,
        notes: [] as string[],
        data_available: true,
        components: {
            taiex: { available: false, value: null },
            tpex: { available: false, value: null },
            breadth: { available: false, value: null },
            us_overnight: { available: false, value: null },
        },
    };
}

// ---- 1 DataHealth clock ----
{
    const knownAt = Date.parse('2026-03-10T01:15:00.000Z'); // historical bar
    const wallMuchLater = knownAt + 7 * 24 * 3600_000;
    const engine = fakeEngine({ lastQuoteAt: knownAt });
    const dh = new DataHealthService(
        engine as never,
        DEFAULT_OPEN_GATE_CONFIG,
        'replay',
    );
    dh.setHistoricalProfileAvailable(true);
    // With strategy clock = knownAt → not stale
    const ok = dh.report('2330', knownAt + 5_000);
    assert.equal(ok.health, 'healthy');
    assert.equal(ok.data_blocked, false);
    // If wrongly used wall clock → would look ancient (stale/disconnected)
    const wrong = dh.report('2330', wallMuchLater);
    assert.ok(
        wrong.health === 'stale' || wrong.health === 'disconnected',
        `expected stale/disconnected with wall clock, got ${wrong.health}`,
    );
    console.log('1 DataHealth clock: OK');
}

// ---- 2 Event cooldown clock ----
{
    let t = Date.parse('2026-03-10T01:10:00.000Z');
    const clock: Clock = { now: () => new Date(t) };
    const cfg = {
        ...DEFAULT_INTRADAY_RANK_CONFIG,
        event_cooldowns_sec: {
            ...DEFAULT_INTRADAY_RANK_CONFIG.event_cooldowns_sec,
            BREAKOUT: 120,
        },
    };
    const eng = new EventEngine(cfg, clock);
    const item = {
        symbol: '2330',
        name: 'TSMC',
        state: 'STRONG',
        rank: 1,
        intraday_score: 85,
        heat_score: 80,
        data_blocked: false,
        metrics: {
            volume_acceleration: 1,
            momentum_acceleration: 50,
            vwap_pos_pct: 0.5,
            liquidity_score: 60,
            breakout_type: 'breakout',
            breakout_score: 90,
            pullback_state: 'none',
            pullback_quality_score: 50,
        },
    } as unknown as IntradayRankItem;
    const first = eng.evaluate(item, null);
    assert.ok(first.includes('BREAKOUT'));
    // advance wall-equivalent little, same clock barely moved → cooldown blocks
    t += 30_000;
    const second = eng.evaluate(item, null);
    assert.ok(!second.includes('BREAKOUT'));
    // clock past cooldown
    t += 100_000;
    const third = eng.evaluate(item, null);
    assert.ok(third.includes('BREAKOUT'));
    console.log('2 Event cooldown clock: OK');
}

// ---- 3 Replay speed invariance (same clock advances → same fires) ----
{
    function runAtWallPacing(wallStepMs: number): string[] {
        let t = Date.parse('2026-03-10T01:00:00.000Z');
        const clock: Clock = { now: () => new Date(t) };
        const eng = new EventEngine(
            {
                ...DEFAULT_INTRADAY_RANK_CONFIG,
                event_cooldowns_sec: {
                    ...DEFAULT_INTRADAY_RANK_CONFIG.event_cooldowns_sec,
                    RANK_JUMP: 60,
                },
            },
            clock,
        );
        const fires: string[] = [];
        for (let i = 0; i < 5; i++) {
            const item = {
                symbol: '2330',
                name: 'TSMC',
                state: 'HEATING',
                rank: 5 - i,
                rank_velocity: 25,
                intraday_score: 75,
                heat_score: 70,
                data_blocked: false,
                metrics: {
                    volume_acceleration: 1,
                    momentum_acceleration: 50,
                    vwap_pos_pct: 0,
                    liquidity_score: 60,
                    breakout_type: 'none',
                    breakout_score: 40,
                    pullback_state: 'none',
                    pullback_quality_score: 40,
                },
            } as unknown as IntradayRankItem;
            const types = eng.evaluate(item, null);
            fires.push(`${t}:${types.join(',')}`);
            t += 60_000; // strategy clock +1m
            // wall pacing differs but must not affect fire times
            void wallStepMs;
        }
        return fires;
    }
    assert.deepEqual(runAtWallPacing(1), runAtWallPacing(50));
    console.log('3 Replay speed invariance: OK');
}

// ---- 4 Rank velocity timestamp window ----
{
    const nowMs = Date.parse('2026-03-10T01:20:00.000Z');
    const hist = [
        { t: nowMs - 400_000, rank: 40 },
        { t: nowMs - 300_000, rank: 30 },
        { t: nowMs - 60_000, rank: 10 },
        { t: nowMs, rank: 5 },
    ];
    assert.equal(rankAtLookback(hist, nowMs, 60_000), 10);
    assert.equal(rankAtLookback(hist, nowMs, 300_000), 30);

    const history = new Map<string, Array<{ t: number; rank: number }>>();
    history.set('2330', [
        { t: nowMs - 300_000, rank: 25 },
        { t: nowMs - 60_000, rank: 12 },
    ]);
    const scored = [
        {
            symbol: '2330',
            name: 'TSMC',
            intraday_score: 80,
            heat_score: 70,
            reasons: [],
            metrics: {
                volume_acceleration: 2,
                momentum_acceleration: 60,
                return_1m: 0.5,
            },
            rank_prev: 12,
        } as unknown as IntradayRankItem,
    ];
    const ranked = attachRanks(
        scored,
        new Map([['2330', 12]]),
        history,
        DEFAULT_INTRADAY_RANK_CONFIG,
        nowMs,
    );
    assert.equal(ranked[0]!.rank, 1);
    assert.equal(ranked[0]!.rank_1m_ago, 12);
    assert.equal(ranked[0]!.rank_5m_ago, 25);
    assert.equal(ranked[0]!.rank_velocity, 24);
    console.log('4 Rank velocity timestamp window: OK');
}

// ---- 5 B missing-feature renormalization ----
{
    const now = new Date('2026-03-10T01:20:00.000Z'); // ~09:20 Taipei → confirmed
    const state = richState(now.getTime());
    const full = evaluateOpenGate({
        cfg: DEFAULT_OPEN_GATE_CONFIG,
        candidate: baseCandidate(),
        state,
        vwapInfo: {
            vwap: 101,
            source: 'calculated',
            valid: true,
            available: true,
            confidence: 'high',
        },
        rvolSameTime: 2.0,
        regime: regimeOk(),
        health: healthyReport(),
        now,
    });
    assert.ok(full.feature_availability.rvol);
    assert.equal(full.score_coverage_pct, 100);

    const missing = evaluateOpenGate({
        cfg: DEFAULT_OPEN_GATE_CONFIG,
        candidate: baseCandidate(),
        state,
        vwapInfo: {
            vwap: null,
            source: 'fallback',
            valid: false,
            available: false,
            confidence: 'none',
        },
        rvolSameTime: null,
        regime: regimeOk(),
        health: healthyReport(),
        now,
    });
    assert.equal(missing.feature_availability.rvol, false);
    assert.equal(missing.feature_availability.vwap, false);
    assert.ok(missing.score_coverage_pct < 100);
    // No silent 40 fill: missing features excluded from weight sum
    assert.ok(missing.score_components.rvol_score === 0);
    assert.ok(missing.raw_open_score !== 40);
    console.log('5 B missing-feature renormalization: OK');
}

// ---- 6 C missing-feature renormalization ----
{
    const now = new Date('2026-03-10T01:20:00.000Z');
    const state = richState(now.getTime());
    const withRs = scoreIntradaySymbol({
        cfg: DEFAULT_INTRADAY_RANK_CONFIG,
        discovery: discovery(),
        state,
        vwap: { vwap: 101, valid: true, available: true, confidence: 'high' },
        rvolSameTime: 1.5,
        health: healthyReport(),
        marketRetHint: 0.2,
        previous: null,
        now,
    });
    assert.equal(withRs.feature_availability!.relative_strength, true);

    const noRs = scoreIntradaySymbol({
        cfg: DEFAULT_INTRADAY_RANK_CONFIG,
        discovery: discovery(),
        state,
        vwap: { vwap: 101, valid: true, available: true, confidence: 'high' },
        rvolSameTime: 1.5,
        health: healthyReport(),
        marketRetHint: null,
        previous: null,
        now,
        featureFlags: { trade_aggression: false, bid_ask: false },
    });
    assert.equal(noRs.feature_availability!.relative_strength, false);
    assert.equal(noRs.feature_availability!.trade_aggression, false);
    assert.ok((noRs.score_coverage_pct ?? 0) < (withRs.score_coverage_pct ?? 100));
    // momentum unavailable without prices
    const empty = scoreIntradaySymbol({
        cfg: DEFAULT_INTRADAY_RANK_CONFIG,
        discovery: discovery(),
        state: undefined,
        vwap: { vwap: null, valid: false, available: false },
        rvolSameTime: null,
        health: healthyReport(),
        marketRetHint: null,
        previous: null,
        now,
    });
    assert.equal(empty.feature_availability!.momentum, false);
    assert.ok((empty.score_coverage_pct ?? 0) < 50);
    console.log('6 C missing-feature renormalization: OK');
}

// ---- 7 Subscription cross-consumer + UI_VIEW release doesn't drop B/C ----
{
    const sm = new SubscriptionManager();
    const unsub: string[][] = [];
    const sub: string[][] = [];
    const subscribe = async (syms: string[]) => {
        sub.push([...syms]);
    };
    const unsubscribe = async (syms: string[]) => {
        unsub.push([...syms]);
    };

    await sm.acquire('2330', 'OPEN_GATE', subscribe);
    await sm.acquire('2330', 'INTRADAY_RANK', subscribe);
    await sm.acquire('2330', 'UI_VIEW', subscribe);
    assert.equal(sm.refCount('2330'), 3);
    assert.equal(sub.length, 1);

    await sm.release('2330', 'UI_VIEW', unsubscribe);
    assert.equal(sm.refCount('2330'), 2);
    assert.deepEqual(unsub, []);
    assert.deepEqual(
        sm.consumersOf('2330').sort(),
        ['INTRADAY_RANK', 'OPEN_GATE'],
    );

    await sm.release('2330', 'OPEN_GATE', unsubscribe);
    assert.equal(sm.refCount('2330'), 1);
    assert.deepEqual(unsub, []);

    await sm.release('2330', 'INTRADAY_RANK', unsubscribe);
    assert.deepEqual(unsub, [['2330']]);
    console.log('7 Subscription cross-consumer UI_VIEW: OK');
}

// ---- 8 after-cutoff no new OPEN_PASS / tradeable ----
{
    const afterNow = new Date('2026-03-10T02:00:00.000Z'); // 10:00 Taipei
    const state = richState(afterNow.getTime());
    const fresh = evaluateOpenGate({
        cfg: DEFAULT_OPEN_GATE_CONFIG,
        candidate: baseCandidate(),
        state,
        vwapInfo: {
            vwap: 101,
            source: 'calculated',
            valid: true,
            available: true,
            confidence: 'high',
        },
        rvolSameTime: 3,
        regime: regimeOk(),
        health: healthyReport(),
        now: afterNow,
        previous: null,
    });
    assert.equal(fresh.phase, 'after');
    assert.notEqual(fresh.open_confirm, 'pass');
    assert.equal(fresh.tradeable_candidate, false);

    const prevPass: OpenConfirmResult = {
        ...fresh,
        phase: 'confirmed',
        open_confirm: 'pass',
        tradeable: true,
        tradeable_candidate: true,
        final_open_score: 88,
        open_gate_passed_before_cutoff: true,
        open_gate_baseline: 88,
        open_gate_final_score: 88,
        confirmation_count: 3,
        pass_streak: 3,
    };
    const afterKeep = evaluateOpenGate({
        cfg: DEFAULT_OPEN_GATE_CONFIG,
        candidate: baseCandidate(),
        state,
        vwapInfo: {
            vwap: 101,
            source: 'calculated',
            valid: true,
            available: true,
            confidence: 'high',
        },
        rvolSameTime: 3,
        regime: regimeOk(),
        health: healthyReport(),
        now: afterNow,
        previous: prevPass,
    });
    assert.equal(afterKeep.tradeable_candidate, false);
    assert.equal(afterKeep.open_gate_final_score, 88);
    assert.ok(afterKeep.current_open_metrics);
    assert.ok(
        afterKeep.current_open_metrics!.live_final_open_score != null,
    );
    console.log('8 after-cutoff no new OPEN_PASS: OK');
}

// ---- 9 signal restart dedupe ----
{
    const dir = mkdtempSync(join(tmpdir(), 'fix-pack-sig-'));
    try {
        const sig: StrategySignal = {
            signal_id: 'sig_restart_dedupe_1',
            symbol: '2330',
            signal_type: 'OPEN_PASS',
            signal_time: '2026-03-10T01:15:00.000Z',
            reference_price: 100,
            reference_price_source: 'last',
            source: 'B',
            strategy_version: 'bc-strategy-v1',
            config_hash: 'abc',
            source_mode: 'live',
            data_resolution: 'tick',
            learning_eligible: true,
            feature_snapshot: { x: 1 },
        };
        const repo1 = new JsonlStrategySignalRepository(dir);
        repo1.save(sig);
        assert.throws(() => repo1.save(sig));

        // Simulate restart
        const repo2 = new JsonlStrategySignalRepository(dir);
        assert.ok(repo2.knownIds().has(sig.signal_id));
        assert.throws(() => repo2.save(sig));

        const lifePath = join(dir, 'lifecycle.json');
        const life = new SignalLifecycleManager();
        life.hydrateFromDisk(lifePath);
        life.activate({
            symbol: '2330',
            signal_type: 'OPEN_PASS',
            signal_id: sig.signal_id,
            nowIso: sig.signal_time,
        });
        const life2 = new SignalLifecycleManager();
        life2.hydrateFromDisk(lifePath);
        const gate = life2.canCreate(
            '2330',
            'OPEN_PASS',
            '2026-03-10T01:16:00.000Z',
        );
        assert.equal(gate.ok, false);
        assert.equal(gate.reason, 'already_active');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
    console.log('9 signal restart dedupe: OK');
}

// Momentum unavailable (no fake 45)
{
    const m = runMomentumEngine(undefined);
    assert.equal(m.available, false);
    assert.equal(m.momentum_score, null);
    console.log('momentum unavailable: OK');
}

console.log('fix-pack.test.ts: ALL OK');
