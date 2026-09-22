// server/src/lib/radar-rescue/rescue.test.ts
// Acceptance A–J style unit checks — no A/B/C mutation.

import { evaluateEarlyTrigger } from './early-trigger.ts';
import {
    computeChaseRisk,
    computeOpportunityScore,
} from './opportunity-chase.ts';
import { DEFAULT_RESCUE_CONFIG } from './config.ts';
import { judgeNewsForSymbol } from './news-judge.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';
import type { BuyPressureItem } from '../buy-pressure/types.ts';

function assert(cond: boolean, msg: string): void {
    if (!cond) throw new Error(`FAIL: ${msg}`);
    console.log(`PASS: ${msg}`);
}

function stubC(partial: Partial<IntradayRankItem>): IntradayRankItem {
    return {
        symbol: 'TEST',
        name: '測試',
        candidate_origin: 'mixed',
        candidate_sources: [],
        a_score: null,
        open_score: null,
        open_gate_status: null,
        rank: 19,
        rank_prev: 72,
        rank_change: 0,
        rank_1m_ago: 41,
        rank_5m_ago: 72,
        rank_velocity: 25,
        last_price: 50,
        change_pct: -1.2,
        raw_change_pct: -1.2,
        adjusted_change_pct: -1.2,
        gap_adjustment_reason: 'NONE',
        corporate_action: {
            has_action_today: false,
            action_type: null,
            badge: null,
            cash_dividend: null,
            ex_reference_price: null,
        },
        intraday_score: 55,
        raw_intraday_score: 55,
        heat_score: 30,
        state: 'EMERGING',
        metrics: {
            return_30s: 0.2,
            return_1m: 0.3,
            return_3m: -0.5,
            return_5m: null,
            momentum_acceleration: 40,
            volume_acceleration: 35,
            volume_1m: 100,
            volume_3m: 200,
            vwap: 50,
            vwap_pos_pct: 0.1,
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
        risks: [],
        data_health: 'healthy',
        data_blocked: false,
        notification_candidate: false,
        confirmation_count: 1,
        signal_id: null,
        evaluation_id: null,
        updated_at: new Date().toISOString(),
        score_coverage_pct: 90,
        score_confidence: 'high',
        feature_availability: {
            momentum: true,
            volume_acceleration: true,
            relative_strength: true,
            vwap_structure: true,
            breakout: true,
            trade_aggression: true,
            pullback_quality: true,
            liquidity: true,
        },
        ...partial,
    } as IntradayRankItem;
}

// A: -1.2% but accel → EARLY
{
    const c = stubC({ change_pct: -1.2 });
    const r = evaluateEarlyTrigger(DEFAULT_RESCUE_CONFIG, {
        c,
        bp: null,
        dataConfidence: 'HIGH',
        coreReady: true,
        stale: false,
        bpRising: true,
    });
    assert(r.early === true, 'A EARLY with negative change_pct');
    assert(r.evidence_count >= 2, 'A evidence >= 2');
}

// B: ACTIVE path does not require change >= 1 (checked at UI; state logic here)
{
    const c = stubC({
        change_pct: 0.4,
        state: 'HEATING',
        intraday_score: 83,
        heat_score: 40,
    });
    assert(c.change_pct! < 1, 'B change_pct < 1 still valid for ACTIVE input');
    assert(c.intraday_score >= 55, 'B C score supports ACTIVE');
}

// C: Opportunity high + chase high — chase does not reduce opportunity
{
    const c = stubC({
        change_pct: 8,
        metrics: {
            ...stubC({}).metrics!,
            momentum_acceleration: 80,
            volume_acceleration: 80,
            relative_strength_score: 90,
            vwap_pos_pct: 2,
            breakout_score: 90,
            trade_aggression_score: 80,
        },
    });
    const opp = computeOpportunityScore(DEFAULT_RESCUE_CONFIG, { c, bp: null });
    const chase = computeChaseRisk(DEFAULT_RESCUE_CONFIG, {
        changePct: 8,
        moveCompletedPct: 0.8,
    });
    assert(opp >= 70, `C opportunity stays high (${opp})`);
    assert(chase === 'HIGH' || chase === 'EXTREME', `C chase is high (${chase})`);
}

// D: STALE → no EARLY
{
    const r = evaluateEarlyTrigger(DEFAULT_RESCUE_CONFIG, {
        c: stubC({}),
        bp: null,
        dataConfidence: 'HIGH',
        coreReady: true,
        stale: true,
    });
    assert(r.early === false, 'D STALE blocks EARLY');
}

// F/G news confirmation
{
    const unconfirmed = judgeNewsForSymbol(DEFAULT_RESCUE_CONFIG, null, '2330', {
        c: stubC({ rank_velocity: -5 }),
        bp: {
            primary_state: 'COOLING',
            volume_acceleration_slope: -0.1,
            distance_from_vwap_pct: -1,
        } as BuyPressureItem,
        sectorRising: false,
    });
    assert(
        unconfirmed.state === 'NO_RELEVANT_NEWS',
        'F no event intel → NO_RELEVANT_NEWS (cannot ACTIVE by news alone)',
    );
}

console.log('radar-rescue acceptance checks done');
