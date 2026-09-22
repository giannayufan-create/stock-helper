// server/src/lib/radar-rescue/early-trigger.ts

import type { BuyPressureItem } from '../buy-pressure/types.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';
import type { RadarRescueConfig } from './config.ts';
import type { DataConfidence, EarlyEvidence } from './types.ts';

export interface EarlyTriggerResult {
    early: boolean;
    evidence: EarlyEvidence[];
    evidence_count: number;
}

/**
 * EARLY does NOT require change_pct > 0, heat >= 45, C >= 80, or BP >= 70.
 * Needs >= early_min_evidence + healthy data.
 */
export function evaluateEarlyTrigger(
    cfg: RadarRescueConfig,
    opts: {
        c?: IntradayRankItem | null;
        bp?: BuyPressureItem | null;
        dataConfidence: DataConfidence;
        coreReady: boolean;
        stale: boolean;
        bpRising?: boolean;
        aggressionRising?: boolean;
        vwapReclaim?: boolean;
    },
): EarlyTriggerResult {
    if (cfg.early_block_stale && opts.stale) {
        return { early: false, evidence: [], evidence_count: 0 };
    }
    if (
        cfg.early_block_low_confidence &&
        (opts.dataConfidence === 'LOW' || !opts.coreReady)
    ) {
        return { early: false, evidence: [], evidence_count: 0 };
    }

    const evidence: EarlyEvidence[] = [];
    const c = opts.c;
    const bp = opts.bp;
    const m = c?.metrics;

    if ((c?.rank_velocity ?? bp?.rank_velocity ?? 0) >= 5) {
        evidence.push('RANK_ACCEL');
    }
    if ((m?.momentum_acceleration ?? bp?.momentum_acceleration ?? 0) > 0) {
        evidence.push('MOMENTUM_ACCEL');
    }
    if ((m?.volume_acceleration ?? bp?.volume_acceleration ?? 0) >= 15) {
        evidence.push('VOLUME_ACCEL');
    }
    if (
        opts.bpRising ||
        (bp?.rvol_accel === 'ACCELERATING' &&
            (bp?.buy_pressure_score ?? 0) >= 35) ||
        (bp?.volume_acceleration_slope ?? 0) > 0
    ) {
        evidence.push('BP_RISING');
    }
    if (
        opts.vwapReclaim ||
        ((m?.vwap_pos_pct ?? bp?.distance_from_vwap_pct ?? -1) >= 0 &&
            (m?.return_1m ?? 0) > (m?.return_3m ?? -99))
    ) {
        evidence.push('VWAP_RECLAIM');
    }
    if (
        m?.breakout_type === 'breakout' ||
        m?.breakout_type === 'attempt' ||
        m?.breakout_type === 'rebreak'
    ) {
        evidence.push('BREAKOUT');
    }
    if (bp?.primary_state === 'BUY_SURGE' || bp?.states?.includes('BUY_SURGE')) {
        evidence.push('BUY_SURGE');
    }
    if (bp?.primary_state === 'ASK_EATING' || bp?.states?.includes('ASK_EATING')) {
        evidence.push('ASK_EATING');
    }
    if (
        opts.aggressionRising ||
        (m?.trade_aggression_score ?? bp?.trade_aggression ?? 0) >= 50
    ) {
        evidence.push('TRADE_AGGRESSION_RISING');
    }
    if ((m?.relative_strength_score ?? 0) >= 55) {
        evidence.push('RELATIVE_STRENGTH_RISING');
    }

    const unique = [...new Set(evidence)];
    return {
        early: unique.length >= cfg.early_min_evidence,
        evidence: unique,
        evidence_count: unique.length,
    };
}
