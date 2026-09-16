// server/src/lib/buy-pressure/ranking.ts
// Radar sort only — never writes back to C score / Heat / Rank.

import type { BuyPressureConfig } from './config.ts';
import type { BuyPressureState } from './types.ts';

export function chasePenalty(
    chaseRisk: string | null | undefined,
    cfg: BuyPressureConfig,
): number {
    const r = (chaseRisk ?? 'low').toLowerCase();
    const scale = cfg.ranking.chase_penalty_scale;
    if (r === 'extreme') return scale * 2;
    if (r === 'high') return scale * 1.5;
    if (r === 'medium') return scale * 0.6;
    return 0;
}

export function computeRadarRankScore(input: {
    buy_pressure_score: number;
    states: BuyPressureState[];
    rank_velocity: number | null;
    volume_acceleration: number | null;
    chase_risk: string | null;
    overheated: boolean;
    cfg: BuyPressureConfig;
}): { radar_rank_score: number; chase_penalty: number } {
    const { cfg } = input;
    let score = input.buy_pressure_score;
    if (input.states.includes('EARLY')) score += cfg.ranking.early_bonus;
    if (input.rank_velocity != null && input.rank_velocity > 0) {
        score += Math.min(
            15,
            input.rank_velocity * cfg.ranking.rank_velocity_bonus_scale,
        );
    }
    if (input.volume_acceleration != null && input.volume_acceleration > 0) {
        score += Math.min(
            12,
            input.volume_acceleration * cfg.ranking.fresh_accel_bonus_scale,
        );
    }
    const penalty = chasePenalty(input.chase_risk, cfg);
    score -= penalty;
    if (input.overheated) score -= cfg.ranking.overheated_penalty;
    return {
        radar_rank_score: Math.round(score * 10) / 10,
        chase_penalty: penalty,
    };
}

/** Price filters must not alter score inputs — helper for tests. */
export function applyPriceFilter<T extends { last_price: number | null }>(
    items: T[],
    minPrice?: number,
    maxPrice?: number,
): T[] {
    return items.filter((it) => {
        const p = it.last_price;
        if (p == null || !Number.isFinite(p)) return false;
        if (minPrice != null && p < minPrice) return false;
        if (maxPrice != null && p > maxPrice) return false;
        return true;
    });
}
