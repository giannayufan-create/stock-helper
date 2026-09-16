// server/src/lib/decision-summary/ds.test.ts
// Acceptance fixtures for Decision Summary Engine v1

import assert from 'node:assert/strict';
import { DEFAULT_DS_CONFIG } from './config.ts';
import { evaluateDecisionSummary, evaluateWithStreak } from './engine.ts';
import type { DecisionSummaryInput } from './types.ts';

let passed = 0;
function pass(name: string) {
    passed += 1;
    console.log(`  PASS  ${name}`);
}

function base(partial: Partial<DecisionSummaryInput>): DecisionSummaryInput {
    return {
        symbol: '0000',
        name: 'TEST',
        c_score: 50,
        c_state: 'HEATING',
        rank: 40,
        rank_prev: 45,
        rank_change: -5,
        rank_velocity: 1,
        bp_score: 40,
        bp_states: [],
        last_price: 100,
        vwap: 99,
        vwap_pos_pct: 0.5,
        rvol: 1.2,
        volume_acceleration: 0.5,
        trade_aggression: 50,
        breakout_type: 'none',
        chase_risk: 'low',
        heat_score: 40,
        data_health: 'healthy',
        data_blocked: false,
        data_stale: false,
        score_coverage_pct: 80,
        bp_coverage_pct: 80,
        has_ca_today: false,
        adjusted_change_pct: null,
        raw_change_pct: null,
        taiwan_regime: 'NEUTRAL',
        market_breadth_advance_pct: 50,
        market_context_available: true,
        sector_state: 'STABLE',
        sector_breadth: 0.5,
        sector_rs: 0,
        sector_coverage_pct: 70,
        event_status: null,
        institutional_realtime_level: 'PREVIOUS_DAY',
        institutional_is_proxy: false,
        ...partial,
    };
}

console.log('decision-summary tests');

// 18 — 1529 case
{
    const out = evaluateDecisionSummary(
        base({
            symbol: '1529',
            c_score: 84,
            rank: 1,
            bp_score: 32,
            bp_states: [],
            vwap_pos_pct: 0.89,
            rvol: null,
            volume_acceleration: null,
            heat_score: 18,
            score_coverage_pct: 70,
            bp_coverage_pct: 60,
        }),
        DEFAULT_DS_CONFIG,
        0,
    );
    assert.equal(out.status, 'WATCH');
    assert.notEqual(out.status, 'CONFIRMED_STRENGTH');
    assert.match(out.headline, /相對強度高.*買盤.*量能/);
    pass('1529 case → WATCH');
}

// 19 — Strong case (streak 2)
{
    const input = base({
        symbol: '2330',
        c_score: 87,
        rank: 4,
        rank_prev: 18,
        rank_change: -14,
        bp_score: 86,
        bp_states: ['BUY_SURGE'],
        vwap_pos_pct: 1.2,
        rvol: 2.1,
        volume_acceleration: 1.5,
        sector_state: 'ROTATING_IN',
        sector_breadth: 0.7,
        taiwan_regime: 'RISK_ON_BROAD',
        score_coverage_pct: 90,
        bp_coverage_pct: 88,
        chase_risk: 'low',
    });
    const out = evaluateWithStreak(input, DEFAULT_DS_CONFIG, 2);
    assert.equal(out.status, 'CONFIRMED_STRENGTH');
    assert.equal(out.context_alignment, 'ALIGNED');
    assert.equal(out.confidence, 'HIGH');
    pass('Strong case → CONFIRMED_STRENGTH ALIGNED HIGH');
}

// First eval of strong conditions stays WATCH (streak gate)
{
    const input = base({
        c_score: 87,
        bp_score: 86,
        bp_states: ['BUY_SURGE'],
        vwap_pos_pct: 1.2,
        rvol: 2.1,
        volume_acceleration: 1.5,
        taiwan_regime: 'RISK_ON_BROAD',
        sector_state: 'ROTATING_IN',
    });
    const out = evaluateDecisionSummary(input, DEFAULT_DS_CONFIG, 0);
    assert.equal(out.status, 'WATCH');
    assert.equal(out.confirm_streak, 1);
    pass('Streak gate: first confirm stays WATCH');
}

// 20 — Extended
{
    const input = base({
        c_score: 87,
        bp_score: 86,
        bp_states: ['BUY_SURGE'],
        vwap_pos_pct: 1.2,
        rvol: 2.1,
        volume_acceleration: 1.5,
        sector_state: 'ROTATING_IN',
        taiwan_regime: 'RISK_ON_BROAD',
        chase_risk: 'EXTREME',
        score_coverage_pct: 90,
        bp_coverage_pct: 88,
    });
    const out = evaluateWithStreak(input, DEFAULT_DS_CONFIG, 2);
    assert.equal(out.status, 'EXTENDED');
    assert.equal(out.context_alignment, 'ALIGNED');
    assert.match(out.headline, /延伸/);
    pass('Extended case → EXTENDED + ALIGNED');
}

// 21 — Data stale
{
    const out = evaluateDecisionSummary(
        base({
            c_score: 90,
            bp_score: 90,
            bp_states: ['BUY_SURGE'],
            vwap_pos_pct: 1,
            rvol: 2,
            volume_acceleration: 1,
            data_stale: true,
            data_health: 'stale',
        }),
        DEFAULT_DS_CONFIG,
        5,
    );
    assert.equal(out.status, 'NOT_READY');
    assert.equal(out.confidence, 'LOW');
    assert.equal(out.confirm_streak, 0);
    pass('Data stale → NOT_READY LOW');
}

// Context CONTRARY does not block CONFIRMED
{
    const out = evaluateWithStreak(
        base({
            c_score: 88,
            bp_score: 80,
            bp_states: ['ASK_EATING'],
            vwap_pos_pct: 1,
            rvol: 2,
            volume_acceleration: 1,
            taiwan_regime: 'RISK_OFF_BROAD',
            sector_state: 'ROTATING_OUT',
            score_coverage_pct: 85,
            bp_coverage_pct: 80,
        }),
        DEFAULT_DS_CONFIG,
        2,
    );
    assert.equal(out.status, 'CONFIRMED_STRENGTH');
    assert.equal(out.context_alignment, 'CONTRARY');
    pass('CONFIRMED + CONTRARY allowed');
}

// Confidence ≠ strength when coverage low
{
    const out = evaluateWithStreak(
        base({
            c_score: 90,
            bp_score: 88,
            bp_states: ['BUY_SURGE'],
            vwap_pos_pct: 1,
            rvol: 2,
            volume_acceleration: 1,
            score_coverage_pct: 55,
            bp_coverage_pct: 55,
            market_context_available: false,
            taiwan_regime: null,
            sector_state: null,
        }),
        DEFAULT_DS_CONFIG,
        2,
    );
    assert.equal(out.status, 'CONFIRMED_STRENGTH');
    assert.notEqual(out.confidence, 'HIGH');
    pass('High strength + low coverage → confidence not HIGH');
}

// No buy advice language
{
    const out = evaluateDecisionSummary(
        base({ c_score: 84, rank: 1, bp_score: 30, rvol: null }),
        DEFAULT_DS_CONFIG,
        0,
    );
    const blob = [
        out.headline,
        ...out.next_confirmations,
        ...out.confirmed_reasons,
    ].join(' ');
    assert.ok(!/建議買|買進|賣出/.test(blob));
    pass('No trade advice language');
}

// Institutional PROXY wording
{
    const out = evaluateDecisionSummary(
        base({ institutional_is_proxy: true }),
        DEFAULT_DS_CONFIG,
        0,
    );
    assert.ok(out.risk_flags.some((r) => r.includes('PROXY')));
    assert.ok(!out.confirmed_reasons.some((r) => /外資正在/.test(r)));
    pass('Institutional PROXY labeled, no 外資正在買');
}

// CA uses adjusted
{
    const out = evaluateDecisionSummary(
        base({
            has_ca_today: true,
            adjusted_change_pct: 1.2,
            raw_change_pct: -5.5,
        }),
        DEFAULT_DS_CONFIG,
        0,
    );
    assert.ok(out.confirmed_reasons.some((r) => /Adjusted Change/.test(r)));
    assert.ok(out.risk_flags.some((r) => /除權息|Adjusted/.test(r)));
    pass('Corporate action uses Adjusted Change');
}

console.log(`\ndecision-summary: ${passed} passed`);
