// EARLY backtest metrics + print samples + signal store — unit checks.
// Includes scenarios T–Z for day vs post-trigger targets and persistence.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    resolveAttackState,
    buildAttackFeatures,
    type AttackFeatures,
} from './attack-state.ts';
import { DEFAULT_RESCUE_CONFIG } from './config.ts';
import {
    EarlyBacktestSession,
    evaluatePriceTarget,
    isTrackingCompleteToClose,
} from './early-backtest.ts';
import { EarlySignalStore } from './early-signal-store.ts';
import { printsFromRecentPrices } from './print-samples.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';
import type { PriceBar } from '../signal-outcome/types.ts';

function stubC(partial: Partial<IntradayRankItem> = {}): IntradayRankItem {
    return {
        symbol: '2330',
        name: '台積電',
        candidate_origin: 'mixed',
        candidate_sources: [],
        a_score: null,
        open_score: null,
        open_gate_status: null,
        rank: 10,
        rank_prev: 40,
        rank_change: 30,
        rank_1m_ago: 20,
        rank_5m_ago: 40,
        rank_velocity: 20,
        last_price: 100,
        change_pct: 1.2,
        raw_change_pct: 1.2,
        adjusted_change_pct: 1.2,
        gap_adjustment_reason: 'NONE',
        corporate_action: {
            has_action_today: false,
            action_type: null,
            badge: null,
            cash_dividend: null,
            ex_reference_price: null,
        },
        intraday_score: 70,
        raw_intraday_score: 70,
        heat_score: 60,
        state: 'HEATING',
        metrics: {
            return_30s: 0.4,
            return_1m: 0.6,
            return_3m: 0.8,
            return_5m: null,
            momentum_acceleration: 40,
            volume_acceleration: 35,
            volume_1m: 100,
            volume_3m: 200,
            vwap: 99,
            vwap_pos_pct: 0.5,
            vwap_structure_score: 70,
            relative_strength_score: 60,
            breakout_score: 50,
            breakout_type: 'attempt',
            trade_aggression_score: 55,
            trade_aggression_available: true,
            pullback_quality_score: 50,
            pullback_state: 'none',
            spread_pct: 0.2,
            liquidity_score: 70,
        },
        risk: {
            chase_risk: 'low',
            invalid_price: null,
            invalid_reason: null,
            trap_flags: [],
            trap_penalty: 0,
        },
        events: [],
        reasons: [],
        score_coverage_pct: 90,
        score_confidence: 'high',
        feature_availability: {},
        data_health: 'ok',
        data_blocked: false,
        updated_at: new Date().toISOString(),
        ...partial,
    } as IntradayRankItem;
}

function baseFeatures(over: Partial<AttackFeatures> = {}): AttackFeatures {
    return {
        change_pct: 1.0,
        last_price: 100,
        vwap_pos_pct: 0.3,
        prev_vwap_pos_pct: 0.2,
        volume_accel: 18,
        rank_velocity: 8,
        bp_slope: 0.1,
        buy_surge: false,
        ask_eating_raw: true,
        trade_aggression: 55,
        trade_aggression_available: true,
        return_30s: 0.15,
        return_1m: 0.25,
        return_3m: 0.1,
        breakout_type: 'attempt',
        trigger: 55,
        near_limit: false,
        limit_up: false,
        last_trade_age_sec: 2,
        quote_age_sec: 2,
        orderbook_age_sec: 2,
        volume_age_sec: 2,
        breakout_price: null,
        prints_above_breakout: 0,
        breakout_print_samples: [],
        breakout_hold_sec: null,
        breakout_hold_has_fresh_trades: false,
        last_trade_key: null,
        last_trade_ts_ms: null,
        last_trade_seq: null,
        best_bid_lift: true,
        sell_aggression_up: false,
        ask_replenish_heavy: false,
        ...over,
    };
}

function barsFrom(
    triggerMs: number,
    specs: Array<{ afterMin: number; high: number; close?: number }>,
): PriceBar[] {
    return specs.map((s) => {
        const t = triggerMs + s.afterMin * 60_000;
        const close = s.close ?? s.high;
        return {
            t,
            open: close,
            high: s.high,
            low: close - 0.5,
            close,
        };
    });
}

function testPrintsFromRecent(): void {
    const now = 1_000_000;
    const samples = printsFromRecentPrices(
        [
            { t: now - 5_000, p: 101, v: 10 },
            { t: now - 5_000, p: 101, v: 10 },
            { t: now - 120_000, p: 99, v: 5 },
            { t: now - 1_000, p: 102, v: 20 },
        ],
        now,
        90_000,
    );
    assert.equal(samples.length, 2);
    assert.equal(samples[1]!.price, 102);
    console.log('OK printsFromRecentPrices dedupe+age');
}

function testBuildAttackFeaturesFillsPrints(): void {
    const now = Date.now();
    const f = buildAttackFeatures({
        c: stubC(),
        bp: null,
        trigger: 70,
        changePct: 1.2,
        prevVwapPos: null,
        nowMs: now,
        recentPrices: [
            { t: now - 2_000, p: 100.5, v: 8 },
            { t: now - 500, p: 101, v: 12 },
        ],
    });
    assert.ok(f.breakout_print_samples.length >= 2);
    assert.ok(f.last_trade_key);
    console.log('OK buildAttackFeatures fills breakout_print_samples');
}

function testSignalIdNoOverwrite(): void {
    const dir = mkdtempSync(join(tmpdir(), 'early-sig-'));
    let t = 1_700_000_000_000;
    const clock = () => t;
    const store = new EarlySignalStore(dir, clock);
    const id1 = store.recordTrigger({
        symbol: '2330',
        name: '台積電',
        timestamp: new Date(t).toISOString(),
        trigger_price: 100,
        change_pct: 1,
        vwap_pos_pct: 0.2,
        volume_accel: 30,
        rank_velocity: 10,
        bp_score: 60,
        bp_slope: 0.05,
        ask_eating: true,
        buy_surge: false,
        trigger_score: 70,
        state: 'EARLY',
    });
    t += 1000;
    const id2 = store.recordTrigger({
        symbol: '2330',
        name: '台積電',
        timestamp: new Date(t).toISOString(),
        trigger_price: 101,
        change_pct: 1.5,
        vwap_pos_pct: 0.3,
        volume_accel: 35,
        rank_velocity: 12,
        bp_score: 65,
        bp_slope: 0.06,
        ask_eating: true,
        buy_surge: true,
        trigger_score: 75,
        state: 'EARLY',
    });
    assert.notEqual(id1, id2);
    assert.equal(store.openCount(), 2);
    rmSync(dir, { recursive: true, force: true });
    console.log('OK early signal_id no overwrite');
}

/** T: day +3.2% SUCCESS; post-trigger +3% FAIL */
function testT_DayPlus3VsPostTrigger(): void {
    const triggerMs = Date.parse('2026-06-15T01:10:00.000Z');
    const dayRef = 100; // 當日基準
    const triggerPx = 101; // 已漲 +1%
    // Day +3.2% → high >= 103.2; post-trigger +3% → high >= 101*1.03 = 104.03
    const sessionEnd = triggerMs + 50 * 60_000;
    const padded: PriceBar[] = [];
    for (let m = 1; m <= 50; m++) {
        const high = m === 5 ? 103.2 : 102.5; // touches day+3.2%, never post-trigger+3
        padded.push({
            t: triggerMs + m * 60_000,
            open: 102,
            high,
            low: 101.5,
            close: 102.5,
        });
    }
    assert.equal(
        isTrackingCompleteToClose(triggerMs, padded, sessionEnd),
        true,
    );

    const session = new EarlyBacktestSession();
    session.injectSignal({
        signal_id: 't_sig',
        symbol: '2330',
        triggered_at_ms: triggerMs,
        trigger_price: triggerPx,
        change_pct_at_trigger: 1.0,
        state_at_trigger: 'EARLY',
        trigger_score: 70,
    });
    const summary = session.finalize(new Map([['2330', padded]]), {
        dayReferenceBySymbol: new Map([['2330', dayRef]]),
        defaultSessionEndKnownAt: sessionEnd,
    });
    const o = summary.outcomes[0]!;
    assert.equal(o.day_plus_3pct.verdict, 'SUCCESS', 'T day+3 SUCCESS');
    assert.equal(o.post_trigger_plus_3pct.verdict, 'FAIL', 'T post-trigger+3 FAIL');
    assert.equal(o.day_plus_3pct.time_precision, '1m_bar');
    assert.equal(o.day_plus_3pct.first_hit_after_min, 5);
    assert.equal(
        (o.day_plus_3pct as { time_to_plus_3pct_sec?: unknown })
            .time_to_plus_3pct_sec,
        undefined,
    );
    console.log(
        `T PASS: day+3=${o.day_plus_3pct.verdict} post+3=${o.post_trigger_plus_3pct.verdict}`,
    );
}

/** U: only one bar after trigger → INCOMPLETE, not FAIL */
function testU_IncompleteSparseBars(): void {
    const triggerMs = Date.parse('2026-06-15T01:10:00.000Z');
    const sessionEnd = triggerMs + 200 * 60_000;
    const future = barsFrom(triggerMs, [{ afterMin: 1, high: 101, close: 100.5 }]);
    assert.equal(
        isTrackingCompleteToClose(triggerMs, future, sessionEnd),
        false,
    );
    const hit = evaluatePriceTarget({
        threshold: 100 * 1.03,
        triggerMs,
        futureBars: future,
        trackingToClose: false,
        referenceAvailable: true,
    });
    assert.equal(hit.verdict, 'INCOMPLETE');

    const session = new EarlyBacktestSession();
    session.injectSignal({
        signal_id: 'u_sig',
        symbol: '2330',
        triggered_at_ms: triggerMs,
        trigger_price: 100,
        change_pct_at_trigger: 0.5,
        state_at_trigger: 'EARLY',
        trigger_score: 60,
    });
    const summary = session.finalize(new Map([['2330', future]]), {
        dayReferenceBySymbol: new Map([['2330', 100]]),
        defaultSessionEndKnownAt: sessionEnd,
    });
    assert.equal(summary.outcomes[0]!.day_plus_3pct.verdict, 'INCOMPLETE');
    assert.equal(summary.day_plus_3pct.fail, 0);
    assert.equal(summary.day_plus_3pct.incomplete, 1);
    assert.equal(summary.day_plus_3pct.rate, null); // no SUCCESS+FAIL
    console.log('U PASS: sparse bars → INCOMPLETE (not FAIL)');
}

/** V: full track to close, no hit → FAIL in denominator */
function testV_FailToClose(): void {
    const triggerMs = Date.parse('2026-06-15T01:10:00.000Z');
    const sessionEnd = triggerMs + 50 * 60_000;
    const future: PriceBar[] = [];
    for (let m = 1; m <= 50; m++) {
        future.push({
            t: triggerMs + m * 60_000,
            open: 100.5,
            high: 101.5,
            low: 100,
            close: 101,
        });
    }
    const session = new EarlyBacktestSession();
    session.injectSignal({
        signal_id: 'v_sig',
        symbol: '2330',
        triggered_at_ms: triggerMs,
        trigger_price: 100.5,
        change_pct_at_trigger: 0.5,
        state_at_trigger: 'EARLY',
        trigger_score: 60,
    });
    const summary = session.finalize(new Map([['2330', future]]), {
        dayReferenceBySymbol: new Map([['2330', 100]]),
        defaultSessionEndKnownAt: sessionEnd,
    });
    const o = summary.outcomes[0]!;
    assert.equal(o.tracking_to_close, true);
    assert.equal(o.day_plus_3pct.verdict, 'FAIL');
    assert.equal(summary.day_plus_3pct.fail, 1);
    assert.equal(summary.day_plus_3pct.rate, 0);
    console.log('V PASS: complete-to-close miss → FAIL in denominator');
}

/** W: missing day reference → UNKNOWN */
function testW_UnknownWithoutDayRef(): void {
    const triggerMs = Date.parse('2026-06-15T01:10:00.000Z');
    const sessionEnd = triggerMs + 50 * 60_000;
    const future: PriceBar[] = [];
    for (let m = 1; m <= 50; m++) {
        future.push({
            t: triggerMs + m * 60_000,
            open: 105,
            high: 110,
            low: 104,
            close: 108,
        });
    }
    const session = new EarlyBacktestSession();
    session.injectSignal({
        signal_id: 'w_sig',
        symbol: '2330',
        triggered_at_ms: triggerMs,
        trigger_price: 105,
        change_pct_at_trigger: null,
        state_at_trigger: 'EARLY',
        trigger_score: 60,
    });
    const summary = session.finalize(new Map([['2330', future]]), {
        dayReferenceBySymbol: new Map([['2330', null]]),
        defaultSessionEndKnownAt: sessionEnd,
    });
    const o = summary.outcomes[0]!;
    assert.equal(o.day_reference_price, null);
    assert.equal(o.day_plus_3pct.verdict, 'UNKNOWN');
    assert.equal(o.day_plus_5pct.verdict, 'UNKNOWN');
    // Post-trigger still evaluable
    assert.equal(o.post_trigger_plus_3pct.verdict, 'SUCCESS');
    assert.equal(summary.day_plus_3pct.unknown, 1);
    assert.equal(summary.day_plus_3pct.rate, null);
    console.log('W PASS: missing day_ref → day+3 UNKNOWN (no guess)');
}

/** X: EARLY→PRE_ATTACK→ACTIVE = one signal, one ACTIVE success */
function testX_SingleSignalThroughActive(): void {
    const t0 = Date.parse('2026-06-15T01:10:00.000Z');
    const early = resolveAttackState(
        DEFAULT_RESCUE_CONFIG,
        baseFeatures({
            change_pct: 1.0,
            last_price: 100,
            volume_accel: 18,
            ask_eating_raw: true,
            best_bid_lift: true,
            return_30s: 0.2,
            return_1m: 0.3,
            trade_aggression: 60,
        }),
        {
            symbol: '2330',
            cashSession: true,
            stale: false,
            dataBlocked: false,
            prev: null,
            nowMs: t0,
        },
    );
    assert.ok(
        early.state === 'EARLY' || early.state === 'PRE_ATTACK',
        `X start early-path got ${early.state}`,
    );
    assert.ok(early.track);

    const pre = resolveAttackState(
        DEFAULT_RESCUE_CONFIG,
        baseFeatures({
            change_pct: 1.2,
            last_price: 100.5,
            volume_accel: 25,
            ask_eating_raw: true,
            best_bid_lift: true,
            return_30s: 0.3,
            return_1m: 0.4,
            trade_aggression: 70,
            breakout_type: 'breakout',
            breakout_price: 100.2,
            breakout_print_samples: [
                { trade_key: 'a', ts_ms: t0 + 30_000, price: 100.4 },
            ],
        }),
        {
            symbol: '2330',
            cashSession: true,
            stale: false,
            dataBlocked: false,
            prev: early.track,
            nowMs: t0 + 60_000,
        },
    );
    assert.ok(pre.track);
    assert.equal(
        pre.track!.triggered_at_ms,
        early.track!.triggered_at_ms,
        'X EARLY→PRE_ATTACK keeps triggered_at_ms',
    );

    const prints = [
        { trade_key: 'a', ts_ms: t0 + 70_000, price: 100.6 },
        { trade_key: 'b', ts_ms: t0 + 80_000, price: 100.8 },
        { trade_key: 'c', ts_ms: t0 + 90_000, price: 101.0 },
    ];
    const active = resolveAttackState(
        DEFAULT_RESCUE_CONFIG,
        baseFeatures({
            change_pct: 1.5,
            last_price: 101,
            volume_accel: 24,
            ask_eating_raw: true,
            best_bid_lift: true,
            return_30s: 0.4,
            return_1m: 0.5,
            trade_aggression: 70,
            breakout_type: 'breakout',
            breakout_price: 100.2,
            breakout_print_samples: prints,
            last_trade_key: 'c',
            last_trade_ts_ms: t0 + 90_000,
            last_trade_age_sec: 1,
        }),
        {
            symbol: '2330',
            cashSession: true,
            stale: false,
            dataBlocked: false,
            prev: pre.track,
            nowMs: t0 + 100_000,
        },
    );
    assert.equal(active.state, 'ACTIVE', `X expected ACTIVE got ${active.state}`);
    assert.equal(
        active.track!.triggered_at_ms,
        early.track!.triggered_at_ms,
        'X ACTIVE keeps same attack id time',
    );

    const session = new EarlyBacktestSession();
    const sid = 'x_sig';
    session.injectSignal({
        signal_id: sid,
        symbol: '2330',
        triggered_at_ms: early.track!.triggered_at_ms,
        trigger_price: early.track!.trigger_price,
        change_pct_at_trigger: 1,
        state_at_trigger: 'EARLY',
        trigger_score: 70,
    });
    session.injectActive(sid, t0 + 100_000);
    session.injectActive(sid, t0 + 160_000); // second ACTIVE ignored
    const summary = session.finalize(new Map(), {
        dayReferenceBySymbol: new Map([['2330', 100]]),
        defaultSessionEndKnownAt: t0 + 200 * 60_000,
    });
    assert.equal(summary.signal_count, 1);
    assert.equal(summary.unique_symbol_count, 1);
    assert.equal(summary.active_upgrade.success, 1);
    assert.equal(summary.outcomes[0]!.active_upgrade.reached, true);
    console.log('X PASS: one signal, one ACTIVE upgrade');
}

/** Y: restart at 4m keeps 30s/60s/90s/3m; completes 5m later */
function testY_RestartPreservesHorizons(): void {
    const dir = mkdtempSync(join(tmpdir(), 'early-y-'));
    let now = 1_700_000_000_000;
    const clock = () => now;
    const store = new EarlySignalStore(dir, clock);
    const t0 = now;
    const sid = store.recordTrigger({
        symbol: '2330',
        name: '台積電',
        timestamp: new Date(t0).toISOString(),
        trigger_price: 100,
        change_pct: 1,
        vwap_pos_pct: 0.2,
        volume_accel: 30,
        rank_velocity: 10,
        bp_score: 60,
        bp_slope: 0.05,
        ask_eating: true,
        buy_surge: false,
        trigger_score: 70,
        state: 'EARLY',
    });

    const ticks: Array<[number, number]> = [
        [30_000, 100.3],
        [60_000, 100.5],
        [90_000, 100.7],
        [180_000, 101.0],
    ];
    for (const [offset, px] of ticks) {
        now = t0 + offset;
        store.sample('2330', px, 'EARLY', now);
    }
    const before = store.getOpen(sid)!;
    assert.equal(before.px_30s, 100.3);
    assert.equal(before.px_60s, 100.5);
    assert.equal(before.px_90s, 100.7);
    assert.equal(before.px_3m, 101.0);
    assert.equal(before.max_price, 101.0);
    assert.ok(before.px_5m == null);
    assert.equal(before.status_5m, 'pending');

    // Restart at 4 minutes — must not backfill early windows with 102.
    now = t0 + 240_000;
    const store2 = new EarlySignalStore(dir, clock);
    assert.equal(store2.openCount(), 1);
    const mid = store2.getOpen(sid)!;
    assert.equal(mid.px_30s, 100.3, 'Y keep px_30s');
    assert.equal(mid.px_60s, 100.5, 'Y keep px_60s');
    assert.equal(mid.px_90s, 100.7, 'Y keep px_90s');
    assert.equal(mid.px_3m, 101.0, 'Y keep px_3m');
    assert.equal(mid.max_price, 101.0);
    store2.sample('2330', 102, 'EARLY', now);
    const afterSample = store2.getOpen(sid)!;
    assert.equal(afterSample.px_30s, 100.3, 'Y no backfill 30s with 102');
    assert.equal(afterSample.px_3m, 101.0, 'Y no backfill 3m with 102');
    assert.equal(afterSample.max_price, 102);

    // Complete 5m
    now = t0 + 300_000;
    store2.sample('2330', 102.5, 'ACTIVE', now);
    assert.equal(store2.openCount(), 0, 'Y finalized after 5m');
    const latest = store2.loadToday().find((r) => r.signal_id === sid && r.finalized);
    assert.ok(latest);
    assert.equal(latest!.px_5m, 102.5);
    assert.equal(latest!.px_30s, 100.3);
    assert.equal(latest!.status_5m, 'ok');
    rmSync(dir, { recursive: true, force: true });
    console.log('Y PASS: restart preserves horizons; 5m completes');
}

/** Z: 1m high touches threshold → minute precision, no fake seconds */
function testZ_MinutePrecisionFromBarHigh(): void {
    const triggerMs = Date.parse('2026-06-15T01:10:00.000Z');
    const future = barsFrom(triggerMs, [
        { afterMin: 3, high: 103.0, close: 102.5 }, // day_ref 100 → +3%
    ]);
    const hit = evaluatePriceTarget({
        threshold: 100 * 1.03,
        triggerMs,
        futureBars: future,
        trackingToClose: false,
        referenceAvailable: true,
    });
    assert.equal(hit.verdict, 'SUCCESS');
    assert.equal(hit.time_precision, '1m_bar');
    assert.equal(hit.first_hit_after_min, 3);
    assert.equal(hit.first_hit_bar_known_at_ms, triggerMs + 3 * 60_000);
    // No second-level claim
    assert.ok(!('first_hit_after_sec' in hit));
    console.log(
        `Z PASS: bar high hit → after_min=${hit.first_hit_after_min} precision=${hit.time_precision}`,
    );
}

testPrintsFromRecent();
testBuildAttackFeaturesFillsPrints();
testSignalIdNoOverwrite();
testT_DayPlus3VsPostTrigger();
testU_IncompleteSparseBars();
testV_FailToClose();
testW_UnknownWithoutDayRef();
testX_SingleSignalThroughActive();
testY_RestartPreservesHorizons();
testZ_MinutePrecisionFromBarHigh();
console.log('\nAll early-validation tests passed (incl. T–Z)');
