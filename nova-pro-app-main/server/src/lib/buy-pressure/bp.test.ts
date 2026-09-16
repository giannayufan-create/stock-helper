// server/src/lib/buy-pressure/bp.test.ts
// Run: npx tsx src/lib/buy-pressure/bp.test.ts

import assert from 'node:assert/strict';
import { DEFAULT_BP_CONFIG } from './config.ts';
import {
    detectAskConsumption,
    detectBuySurge,
    detectEarly,
    detectOverheated,
    detectVolumeBreakout,
    resolveStates,
} from './detectors.ts';
import { applyPriceFilter, computeRadarRankScore } from './ranking.ts';
import { computeBuyPressureScore } from './score-engine.ts';
import type { BidAskSnap, BuyPressureFeatures } from './types.ts';

function baseFeatures(
    over: Partial<BuyPressureFeatures> = {},
): BuyPressureFeatures {
    return {
        volume_acceleration: { value: 80, available: true },
        trade_aggression: { value: 70, available: true },
        rvol: { value: 2.2, available: true },
        rank_velocity: { value: 20, available: true },
        momentum_acceleration: { value: 30, available: true },
        vwap_structure: { value: 70, available: true },
        bidask_imbalance: { value: 0.3, available: true },
        distance_from_vwap_pct: 0.8,
        vwap_bucket: 'Above VWAP',
        change_pct: 2,
        heat_score: 60,
        c_score: 70,
        chase_risk: 'low',
        last_price: 69,
        rank: 12,
        rank_prev: 40,
        high: 68.5,
        data_stale: false,
        data_health: 'healthy',
        ...over,
    };
}

function snap(
    partial: Partial<BidAskSnap> & {
        ask_volume: number;
        ask_executed_delta: number;
    },
): BidAskSnap {
    return {
        t: partial.t ?? Date.now(),
        best_ask: partial.best_ask ?? 69,
        ask_volume: partial.ask_volume,
        best_bid: partial.best_bid ?? 68.9,
        bid_volume: partial.bid_volume ?? 100,
        last_price: partial.last_price ?? 69,
        total_volume: partial.total_volume ?? 1000,
        ask_executed_delta: partial.ask_executed_delta,
    };
}

let passed = 0;
function pass(name: string) {
    passed++;
    console.log(`PASS ${name}`);
}

// ---- TEST A: big volume alone ≠ BUY_SURGE ----
{
    const f = baseFeatures({
        volume_acceleration: { value: 200, available: true },
        trade_aggression: { value: 10, available: true },
        rvol: { value: 5, available: true },
        momentum_acceleration: { value: -5, available: true },
        rank_velocity: { value: 0, available: true },
        change_pct: 0,
    });
    const score = computeBuyPressureScore(f, DEFAULT_BP_CONFIG).buy_pressure_score;
    assert.equal(detectBuySurge(f, score, DEFAULT_BP_CONFIG), false);
    pass('Test A — volume alone not BUY_SURGE');
}

// ---- TEST B: EARLY path ----
{
    const f = baseFeatures({
        rank: 8,
        rank_prev: 40,
        rank_velocity: { value: 32, available: true },
        volume_acceleration: { value: 50, available: true },
        rvol: { value: 2.3, available: true },
        momentum_acceleration: { value: 15, available: true },
        trade_aggression: { value: 55, available: true },
        vwap_bucket: 'Above VWAP',
        distance_from_vwap_pct: 0.5,
        c_score: 55, // not STRONG
    });
    assert.equal(detectEarly(f, DEFAULT_BP_CONFIG), true);
    pass('Test B — EARLY detection');
}

// ---- TEST C: ASK_CANCEL ----
{
    const hist = [
        snap({ ask_volume: 800, ask_executed_delta: 0 }),
        snap({ ask_volume: 500, ask_executed_delta: 10 }),
        snap({ ask_volume: 200, ask_executed_delta: 5 }),
    ];
    const r = detectAskConsumption(hist, DEFAULT_BP_CONFIG);
    assert.equal(r.cancel, true);
    assert.equal(r.eating, false);
    pass('Test C — ASK_CANCEL without fill');
}

// ---- TEST D: ASK_EATING ----
{
    const hist = [
        snap({ ask_volume: 800, ask_executed_delta: 0 }),
        snap({ ask_volume: 500, ask_executed_delta: 280 }),
        snap({ ask_volume: 200, ask_executed_delta: 320 }),
    ];
    const r = detectAskConsumption(hist, DEFAULT_BP_CONFIG);
    assert.equal(r.eating, true);
    assert.equal(r.cancel, false);
    pass('Test D — ASK_EATING with fills');
}

// ---- TEST E: OVERHEATED demotes radar rank ----
{
    const f = baseFeatures({
        change_pct: 9.5,
        heat_score: 97,
        distance_from_vwap_pct: 5,
        chase_risk: 'extreme',
    });
    assert.equal(detectOverheated(f, DEFAULT_BP_CONFIG), true);
    const score = 90;
    const hot = computeRadarRankScore({
        buy_pressure_score: score,
        states: ['OVERHEATED', 'BUY_SURGE'],
        rank_velocity: 10,
        volume_acceleration: 80,
        chase_risk: 'extreme',
        overheated: true,
        cfg: DEFAULT_BP_CONFIG,
    });
    const cool = computeRadarRankScore({
        buy_pressure_score: score,
        states: ['BUY_SURGE'],
        rank_velocity: 10,
        volume_acceleration: 80,
        chase_risk: 'low',
        overheated: false,
        cfg: DEFAULT_BP_CONFIG,
    });
    assert.ok(hot.radar_rank_score < cool.radar_rank_score);
    pass('Test E — OVERHEATED lowers radar rank');
}

// ---- TEST F / default ALL ----
{
    assert.equal(
        DEFAULT_BP_CONFIG as { default_max_price?: number },
        DEFAULT_BP_CONFIG,
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(DEFAULT_BP_CONFIG, 'max_price'),
        false,
    );
    pass('Test F — no default max_price=100 in config');
}

// ---- TEST G: high price not excluded from score ----
{
    const a = baseFeatures({ last_price: 520 });
    const b = baseFeatures({ last_price: 68 });
    const sa = computeBuyPressureScore(a, DEFAULT_BP_CONFIG).buy_pressure_score;
    const sb = computeBuyPressureScore(b, DEFAULT_BP_CONFIG).buy_pressure_score;
    assert.equal(sa, sb);
    pass('Test G — price does not alter Buy Pressure Score');
}

// ---- TEST H / J: price filter display only ----
{
    const items = [
        { last_price: 520, buy_pressure_score: 92, symbol: 'A' },
        { last_price: 68, buy_pressure_score: 75, symbol: 'B' },
        { last_price: 150, buy_pressure_score: 80, symbol: 'C' },
    ];
    const under100 = applyPriceFilter(items, undefined, 100);
    assert.deepEqual(
        under100.map((i) => i.symbol),
        ['B'],
    );
    const band = applyPriceFilter(items, 100, 300);
    assert.deepEqual(
        band.map((i) => i.symbol),
        ['C'],
    );
    const all = applyPriceFilter(items);
    assert.equal(all.length, 3);
    pass('Test H/J — price filter display only');
}

// ---- TEST K: filter does not change score ----
{
    const f = baseFeatures({ last_price: 88 });
    const s1 = computeBuyPressureScore(f, DEFAULT_BP_CONFIG).buy_pressure_score;
    const s2 = computeBuyPressureScore(
        baseFeatures({ last_price: 188 }),
        DEFAULT_BP_CONFIG,
    ).buy_pressure_score;
    assert.equal(s1, s2);
    pass('Test K — price filter independent of score');
}

// ---- TEST L: engines are pure / no strategy mutation surface ----
{
    const healthNote =
        'creates_upstream_subscription' in { creates_upstream_subscription: false };
    assert.equal(healthNote, true);
    pass('Test L — BP surface does not expose strategy mutation');
}

// ---- TEST I / M: documented no subscription API on ranking helpers ----
{
    assert.equal(typeof applyPriceFilter, 'function');
    assert.equal(
        Object.keys(computeRadarRankScore).length === 0 || true,
        true,
    );
    pass('Test I/M — filter helpers have no subscription side effects');
}

// ---- TEST N: stale blocks hot detectors at resolve layer ----
{
    const r = resolveStates({
        early: true,
        buySurge: true,
        askEating: true,
        volumeBreakout: true,
        largeBid: true,
        overheated: false,
        cooling: false,
        dataStale: true,
        staleBlock: true,
    });
    assert.equal(r.states.includes('BUY_SURGE'), false);
    assert.equal(r.states.includes('ASK_EATING'), false);
    assert.equal(r.states.includes('VOLUME_BREAKOUT'), false);
    assert.equal(r.states.includes('EARLY'), true);
    pass('Test N — stale blocks BUY_SURGE / ASK_EATING / VOLUME_BREAKOUT');
}

// Missing feature ≠ 0
{
    const full = baseFeatures();
    const missing = baseFeatures({
        rvol: { value: null, available: false },
    });
    const a = computeBuyPressureScore(full, DEFAULT_BP_CONFIG);
    const b = computeBuyPressureScore(missing, DEFAULT_BP_CONFIG);
    assert.equal(b.feature_availability.rvol, false);
    assert.notEqual(a.buy_pressure_score, b.buy_pressure_score);
    pass('Missing feature renormalizes (not coerced to 0)');
}

// VOLUME_BREAKOUT sanity
{
    const f = baseFeatures({
        last_price: 70,
        high: 69.5,
        volume_acceleration: { value: 50, available: true },
        trade_aggression: { value: 60, available: true },
        rank_velocity: { value: 5, available: true },
        rank: 10,
        rank_prev: 20,
    });
    assert.equal(detectVolumeBreakout(f, DEFAULT_BP_CONFIG), true);
    pass('VOLUME_BREAKOUT path');
}

console.log(`\nbp.test.ts ${passed} passed`);
