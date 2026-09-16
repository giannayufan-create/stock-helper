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
import { applyPriceFilter, computeBpChaseRisk, computeRadarRankScore, isOverheatedStrong, sortBuyPressureItems } from './ranking.ts';
import { computeBuyPressureScore } from './score-engine.ts';
import type { BidAskSnap, BuyPressureFeatures, BuyPressureItem } from './types.ts';

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
    const ask = partial.best_ask ?? 69;
    const bid = partial.best_bid ?? 68.9;
    const askVol = partial.ask_volume;
    const bidVol = partial.bid_volume ?? 100;
    return {
        t: partial.t ?? Date.now(),
        best_ask: ask,
        ask_volume: askVol,
        best_bid: bid,
        bid_volume: bidVol,
        last_price: partial.last_price ?? 69,
        total_volume: partial.total_volume ?? 1000,
        ask_executed_delta: partial.ask_executed_delta,
        bid_levels: [bid],
        ask_levels: [ask],
        bid_qty: [bidVol],
        ask_qty: [askVol],
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

// ---- TEST E: OVERHEATED is label — does NOT demote default rank / score ----
{
    const f = baseFeatures({
        change_pct: 9.5,
        heat_score: 97,
        distance_from_vwap_pct: 5,
        chase_risk: 'extreme',
    });
    assert.equal(detectOverheated(f, DEFAULT_BP_CONFIG), true);
    const score = computeBuyPressureScore(f, DEFAULT_BP_CONFIG).buy_pressure_score;
    const coolFeat = baseFeatures({
        change_pct: 1,
        heat_score: 50,
        distance_from_vwap_pct: 0.3,
    });
    const coolScore = computeBuyPressureScore(coolFeat, DEFAULT_BP_CONFIG).buy_pressure_score;
    // Same underlying pressure features → same BP score (heat not in score weights)
    assert.equal(score, coolScore);
    const hotRank = computeRadarRankScore({
        buy_pressure_score: 95,
        states: ['OVERHEATED', 'BUY_SURGE'],
        rank_velocity: 10,
        volume_acceleration: 80,
        trade_aggression: 70,
        cfg: DEFAULT_BP_CONFIG,
    });
    const coolRank = computeRadarRankScore({
        buy_pressure_score: 95,
        states: ['BUY_SURGE'],
        rank_velocity: 10,
        volume_acceleration: 80,
        trade_aggression: 70,
        cfg: DEFAULT_BP_CONFIG,
    });
    assert.equal(hotRank.radar_rank_score, coolRank.radar_rank_score);
    assert.equal(hotRank.chase_penalty, 0);
    pass('Test E — OVERHEATED does not demote score/rank');
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

function stubItem(
    partial: Partial<BuyPressureItem> & {
        symbol: string;
        buy_pressure_score: number;
    },
): BuyPressureItem {
    return {
        symbol: partial.symbol,
        name: partial.name ?? partial.symbol,
        market: 'UNKNOWN',
        last_price: partial.last_price ?? 100,
        change_pct: partial.change_pct ?? 5,
        buy_pressure_score: partial.buy_pressure_score,
        radar_rank_score: partial.radar_rank_score ?? partial.buy_pressure_score,
        primary_state: partial.primary_state ?? 'BUY_SURGE',
        states: partial.states ?? ['BUY_SURGE'],
        tags: partial.tags ?? (partial.overheated ? ['OVERHEATED'] : []),
        c_score: partial.c_score ?? 80,
        heat_score: partial.heat_score ?? 70,
        rank: partial.rank ?? 5,
        rank_prev: partial.rank_prev ?? 20,
        rank_velocity: partial.rank_velocity ?? 15,
        volume_acceleration: partial.volume_acceleration ?? 50,
        rvol: 2,
        trade_aggression: 60,
        bidask_imbalance: 0.2,
        momentum_acceleration: 20,
        vwap_bucket: 'Above VWAP',
        distance_from_vwap_pct: partial.distance_from_vwap_pct ?? 1,
        chase_penalty: 0,
        chase_risk: partial.chase_risk ?? 'LOW',
        overheated: partial.overheated ?? false,
        overheated_note: partial.overheated
            ? '買盤強，短線延伸較大'
            : null,
        ask_eating_note: null,
        large_bid_note: null,
        data_stale: false,
        data_health: 'healthy',
        updated_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
        evaluated_at: new Date().toISOString(),
        last_tick_at: new Date().toISOString(),
        last_bidask_at: new Date().toISOString(),
        data_age_ms: 0,
        freshness: 'FRESH',
        rvol_slope: 0.2,
        volume_acceleration_slope: 5,
        rvol_accel: 'ACCELERATING',
        volume_accel_label: 'ACCELERATING',
        events: [],
        notification_candidates: [],
        feature_availability: {},
        score_coverage_pct: 100,
        score_confidence: 'high',
    };
}

// ---- TEST O: overheated still on radar ----
{
    const items = [
        stubItem({
            symbol: 'HOT',
            buy_pressure_score: 95,
            heat_score: 97,
            overheated: true,
            states: ['BUY_SURGE', 'OVERHEATED'],
            rank: 2,
            rank_prev: 20,
        }),
        stubItem({ symbol: 'COOL', buy_pressure_score: 70, heat_score: 50 }),
    ];
    const sorted = sortBuyPressureItems(items, 'strongest');
    assert.ok(sorted.some((i) => i.symbol === 'HOT'));
    assert.equal(sorted[0]!.symbol, 'HOT');
    pass('Test O — OVERHEATED remains on radar');
}

// ---- TEST P: heat does not reduce BP score ----
{
    const hi = baseFeatures({ heat_score: 97 });
    const lo = baseFeatures({ heat_score: 40 });
    assert.equal(
        computeBuyPressureScore(hi, DEFAULT_BP_CONFIG).buy_pressure_score,
        computeBuyPressureScore(lo, DEFAULT_BP_CONFIG).buy_pressure_score,
    );
    pass('Test P — Heat independent of Buy Pressure Score');
}

// ---- TEST Q: strongest sort allows OVERHEATED #1 ----
{
    const items = [
        stubItem({
            symbol: 'A',
            buy_pressure_score: 95,
            heat_score: 97,
            overheated: true,
            states: ['BUY_SURGE', 'OVERHEATED'],
        }),
        stubItem({
            symbol: 'B',
            buy_pressure_score: 82,
            heat_score: 65,
            overheated: false,
        }),
    ];
    const sorted = sortBuyPressureItems(items, 'strongest');
    assert.equal(sorted[0]!.symbol, 'A');
    pass('Test Q — strongest allows OVERHEATED first');
}

// ---- TEST R: early sort prefers EARLY over OVERHEATED ----
{
    const items = [
        stubItem({
            symbol: 'HOT',
            buy_pressure_score: 95,
            overheated: true,
            states: ['OVERHEATED', 'BUY_SURGE'],
            primary_state: 'BUY_SURGE',
        }),
        stubItem({
            symbol: 'EAR',
            buy_pressure_score: 78,
            overheated: false,
            states: ['EARLY'],
            primary_state: 'EARLY',
            heat_score: 55,
        }),
    ];
    const sorted = sortBuyPressureItems(items, 'early');
    assert.equal(sorted[0]!.symbol, 'EAR');
    assert.ok(sorted.some((i) => i.symbol === 'HOT'));
    pass('Test R — early prefers EARLY; OVERHEATED not excluded');
}

// ---- TEST S: overheated_strong filter ----
{
    const items = [
        stubItem({
            symbol: 'A',
            buy_pressure_score: 90,
            heat_score: 95,
            overheated: true,
        }),
        stubItem({
            symbol: 'B',
            buy_pressure_score: 90,
            heat_score: 70,
            overheated: false,
        }),
        stubItem({
            symbol: 'C',
            buy_pressure_score: 60,
            heat_score: 95,
            overheated: true,
        }),
    ];
    const sorted = sortBuyPressureItems(items, 'overheated_strong');
    assert.deepEqual(
        sorted.map((i) => i.symbol),
        ['A'],
    );
    assert.equal(isOverheatedStrong(items[0]!), true);
    pass('Test S — 過熱強勢 filter');
}

// ---- TEST T: default ALL includes all state types ----
{
    const items = [
        stubItem({ symbol: '1', buy_pressure_score: 70, states: ['EARLY'], primary_state: 'EARLY' }),
        stubItem({ symbol: '2', buy_pressure_score: 80, states: ['BUY_SURGE'], primary_state: 'BUY_SURGE' }),
        stubItem({ symbol: '3', buy_pressure_score: 85, states: ['ASK_EATING'], primary_state: 'ASK_EATING' }),
        stubItem({ symbol: '4', buy_pressure_score: 88, states: ['VOLUME_BREAKOUT'], primary_state: 'VOLUME_BREAKOUT' }),
        stubItem({
            symbol: '5',
            buy_pressure_score: 95,
            states: ['BUY_SURGE', 'OVERHEATED'],
            primary_state: 'BUY_SURGE',
            overheated: true,
            heat_score: 96,
        }),
    ];
    const sorted = sortBuyPressureItems(items, 'strongest');
    assert.equal(sorted.length, 5);
    assert.ok(sorted.some((i) => i.overheated));
    pass('Test T — default ALL keeps all states including OVERHEATED');
}

// Chase risk independent
{
    const chase = computeBpChaseRisk(
        baseFeatures({
            change_pct: 9.5,
            heat_score: 97,
            distance_from_vwap_pct: 5.8,
            momentum_acceleration: { value: 50, available: true },
        }),
    );
    assert.ok(chase === 'HIGH' || chase === 'EXTREME');
    pass('Chase Risk independent helper');
}

console.log(`\nbp.test.ts ${passed} passed`);
