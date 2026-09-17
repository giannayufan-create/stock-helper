// server/src/lib/radar-quality/radar-quality.test.ts
// Acceptance tests A–J for Radar Quality Upgrade v1.

import assert from 'node:assert/strict';
import { DEFAULT_RQ_CONFIG } from './config.ts';
import {
    computeFocusScore,
    selectFocusTop3,
} from './focus.ts';
import {
    classifyForeignBackground,
    containsForbiddenForeignWording,
    evaluateContinuation,
    FORBIDDEN_FOREIGN_PHRASES,
} from './institutional.ts';
import {
    applyHysteresis,
    evaluateMomentum,
    evaluateRawMomentum,
} from './momentum.ts';
import type {
    InstitutionalSnapshot,
    RadarQualityInput,
    RadarQualityItem,
} from './types.ts';

const cfg = { ...DEFAULT_RQ_CONFIG, active_enter_confirmations: 2, active_exit_confirmations: 3 };

function emptyInst(
    partial?: Partial<InstitutionalSnapshot>,
): InstitutionalSnapshot {
    return {
        foreign_net_buy_shares: null,
        foreign_buy_shares: null,
        foreign_sell_shares: null,
        investment_trust_net_buy: null,
        dealer_net_buy: null,
        foreign_net_buy_1d: null,
        foreign_net_buy_3d: null,
        foreign_net_buy_5d: null,
        institutional_net_buy_3d: null,
        institutional_net_buy_5d: null,
        foreign_buy_streak_days: null,
        foreign_net_buy_rank: null,
        foreign_net_buy_to_volume_ratio: null,
        source_trade_date: '2026-09-16',
        freshness: 'PREVIOUS_DAY',
        background: 'FOREIGN_NEUTRAL',
        continuation: 'WAITING_CONFIRMATION',
        note: 'test',
        ...partial,
    };
}

function base(partial: Partial<RadarQualityInput> = {}): RadarQualityInput {
    return {
        symbol: '2330',
        name: 'TSMC',
        last_price: 100,
        change_pct: 1,
        short_momentum: 0.5,
        momentum_acceleration: 0.2,
        c_score: 80,
        c_state: 'HEATING',
        bp_score: 75,
        bp_states: ['BUY_SURGE'],
        bp_trend_up: true,
        rank: 10,
        rank_prev: 20,
        rank_change: 10,
        rank_velocity: 5,
        vwap_pos_pct: 1,
        vwap_reclaim: true,
        rvol: 1.5,
        volume_acceleration: 0.5,
        trade_aggression: 0.5,
        breakout_type: 'BREAKOUT',
        events: ['BREAKOUT'],
        pullback_state: null,
        sector_state: 'ROTATING_IN',
        taiwan_regime: 'RISK_ON',
        data_health: 'ok',
        data_blocked: false,
        data_stale: false,
        score_coverage_pct: 80,
        chase_risk: 'LOW',
        decision_status: 'WATCH',
        ai_score: null,
        institutional: emptyInst(),
        ...partial,
    };
}

function itemFrom(
    symbol: string,
    score: number,
    state: RadarQualityItem['momentum_state'],
): RadarQualityItem {
    return {
        symbol,
        name: symbol,
        eligibility: 'ELIGIBLE',
        momentum_state: state,
        momentum_reason: 't',
        active_confirmations: ['a', 'b'],
        missing_confirmations: [],
        focus_score: score,
        focus_rank: null,
        is_focus: false,
        focus_reasons: ['✓ ACTIVE'],
        raw_rank: 1,
        raw_rank_change: 0,
        institutional: emptyInst(),
        decision_status: 'WATCH',
        ai_score: null,
        data_confidence: 'HIGH',
        updated_at: new Date().toISOString(),
        version: 'rq_v1',
        mutates_strategy: false,
    };
}

let passed = 0;
function pass(name: string) {
    passed += 1;
    console.log(`PASS ${name}`);
}

console.log('radar-quality tests');

// TEST A — high C/rank but no momentum → INACTIVE
{
    const raw = evaluateRawMomentum(
        base({
            c_score: 86,
            rank: 3,
            change_pct: -1,
            short_momentum: -0.5,
            momentum_acceleration: -0.3,
            bp_score: 28,
            bp_states: [],
            bp_trend_up: false,
            volume_acceleration: -0.2,
            rank_velocity: -2,
            vwap_pos_pct: -2,
            vwap_reclaim: false,
            events: [],
            breakout_type: '',
            sector_state: null,
            rvol: 0.8,
        }),
        cfg,
    );
    assert.equal(raw.raw_state, 'INACTIVE');
    assert.notEqual(raw.raw_state, 'ACTIVE');
    pass('TEST A INACTIVE high-rank no-momentum');
}

// TEST B — negative change but recovering → ACTIVE raw
{
    const raw = evaluateRawMomentum(
        base({
            change_pct: -1.2,
            short_momentum: 0.1,
            momentum_acceleration: 0.4,
            bp_score: 81,
            bp_states: ['BUY_SURGE'],
            bp_trend_up: true,
            rank: 7,
            rank_prev: 30,
            rank_velocity: 8,
            volume_acceleration: 0.6,
            vwap_reclaim: true,
            vwap_pos_pct: 0.5,
        }),
        cfg,
    );
    assert.ok(
        raw.raw_state === 'ACTIVE' || raw.raw_state === 'WATCH',
        'expected ACTIVE or WATCH',
    );
    pass('TEST B negative but recovering');
}

// TEST C — pullback protection
{
    const raw = evaluateRawMomentum(
        base({
            change_pct: -0.8,
            short_momentum: -0.2,
            momentum_acceleration: -0.1,
            bp_score: 55,
            bp_states: [],
            bp_trend_up: false,
            rank_velocity: 0,
            volume_acceleration: -0.1,
            vwap_reclaim: false,
            vwap_pos_pct: -0.5,
            events: ['PULLBACK_READY'],
            pullback_state: 'READY',
            c_state: 'STRONG',
            c_score: 82,
            sector_state: 'ROTATING_IN',
            breakout_type: '',
            rvol: 0.9,
        }),
        cfg,
    );
    assert.equal(raw.raw_state, 'PULLBACK');
    pass('TEST C PULLBACK protection');
}

// TEST D — momentum expiry via hysteresis
{
    let h = applyHysteresis('ACTIVE', undefined, cfg);
    assert.equal(h.displayed, 'WATCH'); // need enter confirmations first
    h = applyHysteresis('ACTIVE', h, cfg);
    assert.equal(h.displayed, 'ACTIVE');
    h = applyHysteresis('INACTIVE', h, cfg);
    assert.equal(h.displayed, 'ACTIVE'); // exit 1
    h = applyHysteresis('INACTIVE', h, cfg);
    assert.equal(h.displayed, 'ACTIVE'); // exit 2
    h = applyHysteresis('INACTIVE', h, cfg);
    assert.ok(h.displayed === 'INACTIVE' || h.displayed === 'WATCH');
    pass('TEST D momentum expiry hysteresis');
}

// TEST E — raw rank #1 but weak → not ACTIVE / focus score < 0 path
{
    const raw = evaluateRawMomentum(
        base({
            c_score: 90,
            rank: 1,
            bp_score: 25,
            bp_states: [],
            bp_trend_up: false,
            short_momentum: -0.2,
            momentum_acceleration: -0.2,
            volume_acceleration: -0.3,
            rank_velocity: -1,
            vwap_pos_pct: -1,
            vwap_reclaim: false,
            events: [],
            breakout_type: '',
            sector_state: null,
            rvol: 0.5,
        }),
        cfg,
    );
    assert.notEqual(raw.raw_state, 'ACTIVE');
    const score = computeFocusScore({
        momentum_state: raw.raw_state,
        active_confirmations: raw.active_confirmations,
        bp_score: 25,
    });
    assert.ok(score < 0 || raw.raw_state === 'INACTIVE' || raw.raw_state === 'WATCH');
    pass('TEST E weak #1 not ACTIVE/Focus');
}

// TEST F — sticky leader within hold window
{
    const items = [
        itemFrom('A', 50, 'ACTIVE'),
        itemFrom('B', 52, 'ACTIVE'),
    ];
    const t0 = 1_000_000;
    const r1 = selectFocusTop3(
        items,
        cfg,
        { symbol: 'A', sinceMs: t0, challenger: null, challengerHits: 0 },
        t0 + 10_000, // < 60s
    );
    assert.equal(r1.slots[0]?.symbol, 'A');
    pass('TEST F sticky leader hold');
}

// TEST G — challenger switch after margin + confirmations
{
    const items = [
        itemFrom('A', 50, 'ACTIVE'),
        itemFrom('B', 60, 'ACTIVE'),
    ];
    const t0 = 1_000_000;
    let leader = {
        symbol: 'A',
        sinceMs: t0,
        challenger: null as string | null,
        challengerHits: 0,
    };
    const afterHold = t0 + 61_000;
    for (let i = 0; i < 3; i++) {
        const r = selectFocusTop3(items, cfg, leader, afterHold);
        leader = r.leader!;
    }
    assert.equal(leader.symbol, 'B');
    pass('TEST G challenger switch');
}

// TEST H — confirmed continuation
{
    const cont = evaluateContinuation('FOREIGN_STRONG_ACCUMULATION', {
        c_score: 88,
        bp_score: 85,
        vwap_pos_pct: 1,
        volume_acceleration: 0.5,
        sector_state: 'ROTATING_IN',
        momentum_acceleration: 0.2,
        rank_velocity: 3,
    });
    assert.equal(cont, 'CONFIRMED_CONTINUATION');
    pass('TEST H CONFIRMED_CONTINUATION');
}

// TEST I — divergence / rejected
{
    const cont = evaluateContinuation('FOREIGN_STRONG_ACCUMULATION', {
        c_score: 50,
        bp_score: 25,
        vwap_pos_pct: -2,
        volume_acceleration: -0.2,
        sector_state: 'ROTATING_OUT',
        momentum_acceleration: -0.1,
        rank_velocity: -2,
    });
    assert.ok(cont === 'DIVERGENCE' || cont === 'REJECTED');
    pass('TEST I DIVERGENCE/REJECTED');
}

// TEST J — forbidden realtime foreign wording
{
    for (const p of FORBIDDEN_FOREIGN_PHRASES) {
        assert.equal(containsForbiddenForeignWording(p), true);
    }
    assert.equal(
        containsForbiddenForeignWording('昨日外資大幅買超，今日盤中續強'),
        false,
    );
    const bg = classifyForeignBackground(
        {
            code: '2330',
            name: 'T',
            market: 'tse',
            asOf: '2026-09-16',
            foreignNet: 600_000,
            trustNet: 0,
            dealerNet: 0,
            instNet: 600_000,
            marginBal: 0,
            marginPrev: 0,
            marginDelta: 0,
            shortBal: 0,
            shortPrev: 0,
            shortDelta: 0,
        },
        cfg,
    );
    assert.equal(bg, 'FOREIGN_STRONG_ACCUMULATION');
    pass('TEST J no realtime foreign wording');
}

// Extra: hysteresis enter ACTIVE
{
    const m1 = evaluateMomentum(base(), cfg, undefined);
    assert.notEqual(m1.state, 'ACTIVE'); // first hit → WATCH/PULLBACK
    const m2 = evaluateMomentum(base(), cfg, {
        displayed: m1.state,
        enter_hits: m1.enter_hits,
        exit_hits: m1.exit_hits,
    });
    assert.equal(m2.state, 'ACTIVE');
    pass('hysteresis enter ACTIVE');
}

console.log(`\nradar-quality: ${passed} passed`);
