// server/src/lib/radar-rescue/opportunity-chase.ts
// Opportunity and Chase Risk are SEPARATE — chase never reduces opportunity.

import type { BuyPressureItem } from '../buy-pressure/types.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';
import type { RadarRescueConfig } from './config.ts';
import type { ChaseRiskLevel } from './types.ts';

function clamp(n: number, lo = 0, hi = 100): number {
    return Math.max(lo, Math.min(hi, n));
}

function nz(v: number | null | undefined): number {
    return v == null || Number.isNaN(v) ? 0 : v;
}

export function computeOpportunityScore(
    cfg: RadarRescueConfig,
    opts: {
        c?: IntradayRankItem | null;
        bp?: BuyPressureItem | null;
        sectorSupport?: boolean;
        newsAdj?: number;
    },
): number {
    const w = cfg.opportunity_weights;
    const c = opts.c;
    const bp = opts.bp;
    const m = c?.metrics;

    const feats: Record<string, number> = {
        momentum: clamp(nz(m?.momentum_acceleration) + 50),
        volume_acceleration: clamp(nz(m?.volume_acceleration ?? bp?.volume_acceleration)),
        relative_strength: clamp(nz(m?.relative_strength_score)),
        vwap: clamp(50 + nz(m?.vwap_pos_pct ?? bp?.distance_from_vwap_pct) * 20),
        breakout: clamp(nz(m?.breakout_score)),
        trade_aggression: clamp(
            nz(m?.trade_aggression_score ?? bp?.trade_aggression),
        ),
        rank_velocity: clamp(50 + nz(c?.rank_velocity ?? bp?.rank_velocity) * 2),
        bp_trend: clamp(nz(bp?.buy_pressure_score)),
        sector_support: opts.sectorSupport ? 80 : 40,
    };

    let sumW = 0;
    let sum = 0;
    for (const [k, weight] of Object.entries(w)) {
        if (weight <= 0) continue;
        sumW += weight;
        sum += weight * (feats[k] ?? 50);
    }
    let score = sumW > 0 ? sum / sumW : 0;
    const adj = Math.max(
        -cfg.news_adjustment_max,
        Math.min(cfg.news_adjustment_max, opts.newsAdj ?? 0),
    );
    return clamp(score + adj);
}

export function computeChaseRisk(
    cfg: RadarRescueConfig,
    opts: {
        changePct?: number | null;
        gapPct?: number | null;
        vwapExtPct?: number | null;
        distFromLocalLowPct?: number | null;
        distFromBreakoutPct?: number | null;
        moveCompletedPct?: number | null; // 0..1 of day range already used
    },
): ChaseRiskLevel {
    const chg = nz(opts.changePct);
    const gap = nz(opts.gapPct);
    const vwap = Math.abs(nz(opts.vwapExtPct));
    const fromLow = nz(opts.distFromLocalLowPct);
    const completed = nz(opts.moveCompletedPct);

    if (
        gap >= cfg.chase_thresholds.extreme_gap_pct ||
        vwap >= cfg.chase_thresholds.extreme_vwap_ext_pct ||
        chg >= 9 ||
        completed >= 0.85
    ) {
        return 'EXTREME';
    }
    if (chg >= cfg.chase_thresholds.high_max_pct || fromLow >= 6 || completed >= 0.7) {
        return 'HIGH';
    }
    if (chg >= cfg.chase_thresholds.medium_max_pct || fromLow >= 3.5) {
        return 'MEDIUM';
    }
    if (chg >= cfg.chase_thresholds.low_max_pct) {
        return 'LOW';
    }
    return 'LOW';
}
