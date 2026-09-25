// EARLY backtest + print samples + signal store — unit checks.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAttackFeatures } from './attack-state.ts';
import { EarlyBacktestSession } from './early-backtest.ts';
import { EarlySignalStore } from './early-signal-store.ts';
import { printsFromRecentPrices } from './print-samples.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';

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

function testPrintsFromRecent(): void {
    const now = 1_000_000;
    const samples = printsFromRecentPrices(
        [
            { t: now - 5_000, p: 101, v: 10 },
            { t: now - 5_000, p: 101, v: 10 }, // dup
            { t: now - 120_000, p: 99, v: 5 }, // too old
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
    assert.ok(f.last_trade_ts_ms != null);
    console.log('OK buildAttackFeatures fills breakout_print_samples');
}

function testEarlyBacktestHit3(): void {
    const session = new EarlyBacktestSession();
    const t0 = Date.parse('2026-06-15T01:05:00.000Z'); // ~09:05 Taipei
    // Push EARLY-ish features for a few minutes
    for (let i = 0; i < 5; i++) {
        const now = t0 + i * 60_000;
        session.step({
            symbol: '2330',
            nowMs: now,
            cashSession: true,
            c: stubC({
                last_price: 100 + i * 0.2,
                change_pct: 1 + i * 0.1,
                updated_at: new Date(now).toISOString(),
                metrics: {
                    ...stubC().metrics!,
                    return_30s: 0.3,
                    return_1m: 0.5,
                    volume_acceleration: 40,
                    breakout_type: 'attempt',
                    vwap_pos_pct: 0.4,
                },
            }),
            recentPrices: [
                { t: now - 1000, p: 100 + i * 0.2, v: 10 },
                { t: now - 500, p: 100 + i * 0.25, v: 12 },
            ],
        });
    }
    const bars = [
        { t: t0 + 60_000, open: 100, high: 101, low: 100, close: 100.5 },
        { t: t0 + 120_000, open: 100.5, high: 104, low: 100.4, close: 103.5 },
    ];
    const summary = session.finalize(new Map([['2330', bars]]));
    assert.ok(summary.triggers >= 0);
    // If any trigger fired, look-ahead must compute hit_plus_3 from high=104
    for (const o of summary.outcomes) {
        if (o.trigger_price > 0 && o.complete) {
            const need = o.trigger_price * 1.03;
            if (104 >= need) assert.equal(o.hit_plus_3pct, true);
        }
    }
    console.log(
        `OK early-backtest triggers=${summary.triggers} hit3=${summary.hit_plus_3pct}`,
    );
}

function testSignalIdNoOverwrite(): void {
    const dir = mkdtempSync(join(tmpdir(), 'early-sig-'));
    const store = new EarlySignalStore(dir);
    const t1 = new Date().toISOString();
    const id1 = store.recordTrigger({
        symbol: '2330',
        name: '台積電',
        timestamp: t1,
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
    const id2 = store.recordTrigger({
        symbol: '2330',
        name: '台積電',
        timestamp: new Date(Date.now() + 1000).toISOString(),
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
        state: 'PRE_ATTACK',
    });
    assert.notEqual(id1, id2);
    assert.equal(store.openCount(), 2);
    store.sample('2330', 102, 'ACTIVE');
    assert.equal(store.openCount(), 2); // still within 5m

    // Restart hydrate
    const store2 = new EarlySignalStore(dir);
    assert.ok(store2.openCount() >= 1, 'restart should reopen incomplete');
    rmSync(dir, { recursive: true, force: true });
    console.log('OK early signal_id + reopen after restart');
}

testPrintsFromRecent();
testBuildAttackFeaturesFillsPrints();
testEarlyBacktestHit3();
testSignalIdNoOverwrite();
console.log('All early-validation tests passed');
