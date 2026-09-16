// server/src/lib/buy-pressure/ranking.ts
// Radar sort only — never writes back to C score / Heat / Rank.
// OVERHEATED is a label — never excludes or demotes by default.

import type { BuyPressureConfig } from './config.ts';
import type {
    BuyPressureFeatures,
    BuyPressureItem,
    BuyPressureState,
} from './types.ts';

export type BpChaseRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

export type BpSortMode =
    | 'strongest'
    | 'early'
    | 'rank_surge'
    | 'volume_surge'
    | 'ask_eating'
    | 'overheated_strong';

/** Independent chase risk — NOT folded into Buy Pressure Score. */
export function computeBpChaseRisk(
    f: Pick<
        BuyPressureFeatures,
        | 'distance_from_vwap_pct'
        | 'change_pct'
        | 'heat_score'
        | 'momentum_acceleration'
        | 'last_price'
        | 'high'
    >,
): BpChaseRisk {
    let pts = 0;
    const dist = Math.abs(f.distance_from_vwap_pct ?? 0);
    const chg = f.change_pct ?? 0;
    const heat = f.heat_score ?? 0;
    const mom = f.momentum_acceleration.value ?? 0;
    const ext =
        f.last_price != null && f.high != null && f.high > 0
            ? ((f.last_price - f.high * 0.98) / f.high) * 100
            : 0;

    if (dist >= 5) pts += 3;
    else if (dist >= 3) pts += 2;
    else if (dist >= 1.5) pts += 1;

    if (chg >= 9) pts += 3;
    else if (chg >= 7) pts += 2;
    else if (chg >= 4) pts += 1;

    if (heat >= 95) pts += 3;
    else if (heat >= 90) pts += 2;
    else if (heat >= 80) pts += 1;

    if (mom >= 80) pts += 2;
    else if (mom >= 40) pts += 1;

    if (ext >= 2) pts += 1;

    if (pts >= 8) return 'EXTREME';
    if (pts >= 5) return 'HIGH';
    if (pts >= 3) return 'MEDIUM';
    return 'LOW';
}

/**
 * Default radar strength — Buy Pressure + velocity/accel/aggression/freshness.
 * Does NOT subtract for OVERHEATED or chase risk.
 */
export function computeRadarRankScore(input: {
    buy_pressure_score: number;
    states: BuyPressureState[];
    rank_velocity: number | null;
    volume_acceleration: number | null;
    trade_aggression: number | null;
    cfg: BuyPressureConfig;
    /** When true (only early sort mode), apply soft early preference — not exclusion. */
    early_mode?: boolean;
    heat_score?: number | null;
    chase_risk?: BpChaseRisk | null;
}): { radar_rank_score: number; chase_penalty: number } {
    const { cfg } = input;
    let score = input.buy_pressure_score;
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
    if (input.trade_aggression != null && input.trade_aggression > 0) {
        score += Math.min(8, input.trade_aggression * 0.05);
    }
    // Freshness: prefer non-cooling action states slightly
    if (
        input.states.some((s) =>
            ['EARLY', 'BUY_SURGE', 'ASK_EATING', 'VOLUME_BREAKOUT'].includes(s),
        )
    ) {
        score += 3;
    }

    if (input.early_mode) {
        if (input.states.includes('EARLY')) score += cfg.ranking.early_bonus;
        const heat = input.heat_score ?? 50;
        if (heat <= 70) score += 8;
        else if (heat <= 85) score += 3;
        const chase = (input.chase_risk ?? 'LOW').toUpperCase();
        if (chase === 'LOW') score += 6;
        else if (chase === 'MEDIUM') score += 2;
        // HIGH/EXTREME: no bonus — still not excluded
    }

    return {
        radar_rank_score: Math.round(score * 10) / 10,
        chase_penalty: 0,
    };
}

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

export function isOverheatedStrong(it: {
    overheated: boolean;
    heat_score: number | null;
    buy_pressure_score: number;
}): boolean {
    return (
        it.overheated &&
        (it.heat_score ?? 0) >= 90 &&
        it.buy_pressure_score >= 80
    );
}

export function sortBuyPressureItems(
    items: BuyPressureItem[],
    mode: BpSortMode,
): BuyPressureItem[] {
    const copy = [...items];
    switch (mode) {
        case 'early':
            return copy.sort((a, b) => {
                const ae = a.states.includes('EARLY') ? 1 : 0;
                const be = b.states.includes('EARLY') ? 1 : 0;
                if (ae !== be) return be - ae;
                return b.radar_rank_score - a.radar_rank_score;
            });
        case 'rank_surge':
            return copy.sort(
                (a, b) => (b.rank_velocity ?? -999) - (a.rank_velocity ?? -999),
            );
        case 'volume_surge':
            return copy.sort(
                (a, b) =>
                    (b.volume_acceleration ?? -999) -
                    (a.volume_acceleration ?? -999),
            );
        case 'ask_eating':
            return copy
                .filter((i) => i.states.includes('ASK_EATING'))
                .sort((a, b) => b.buy_pressure_score - a.buy_pressure_score);
        case 'overheated_strong':
            return copy
                .filter((i) => isOverheatedStrong(i))
                .sort((a, b) => b.buy_pressure_score - a.buy_pressure_score);
        case 'strongest':
        default:
            // Pure strength — OVERHEATED may rank #1
            return copy.sort(
                (a, b) => b.buy_pressure_score - a.buy_pressure_score ||
                    b.radar_rank_score - a.radar_rank_score,
            );
    }
}
