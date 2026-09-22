// server/src/lib/radar-rescue/trigger-score.ts
// Finds "changing now" — does NOT replace discovery_score.

import type { BuyPressureItem } from '../buy-pressure/types.ts';
import type { DiscoveryItem } from '../intraday-rank/types.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';
import type { RadarRescueConfig } from './config.ts';

function clamp(n: number, lo = 0, hi = 100): number {
    return Math.max(lo, Math.min(hi, n));
}

function nz(v: number | null | undefined): number {
    return v == null || Number.isNaN(v) ? 0 : v;
}

/** Map raw feature to 0..100 contribution. */
function scale(v: number, mid: number, span: number): number {
    return clamp(50 + ((v - mid) / span) * 50);
}

export function computeTriggerScore(
    cfg: RadarRescueConfig,
    opts: {
        c?: IntradayRankItem | null;
        bp?: BuyPressureItem | null;
        disc?: DiscoveryItem | null;
        bpSlope?: number | null;
        prevChangePct?: number | null;
    },
): number {
    const w = cfg.trigger_weights;
    const c = opts.c;
    const bp = opts.bp;
    const m = c?.metrics;

    const rankVel = nz(c?.rank_velocity ?? bp?.rank_velocity);
    const volAccel = nz(m?.volume_acceleration ?? bp?.volume_acceleration);
    const momAccel = nz(m?.momentum_acceleration ?? bp?.momentum_acceleration);
    const ret1m = nz(m?.return_1m);
    const ret3m = nz(m?.return_3m);
    const shortAccel = ret1m - ret3m / 3;
    const turnoverAccel = volAccel; // proxy when no separate turnover series
    const rsChange = nz(m?.relative_strength_score) - 50;
    const vwapPos = nz(m?.vwap_pos_pct ?? bp?.distance_from_vwap_pct);
    const vwapTransition =
        vwapPos >= 0 && (opts.prevChangePct ?? 0) < 0 ? 80 : scale(vwapPos, 0, 1.5);
    const breakout =
        m?.breakout_type === 'breakout' || m?.breakout_type === 'rebreak'
            ? 90
            : m?.breakout_type === 'attempt'
              ? 60
              : 30;
    const bpSlope = nz(opts.bpSlope ?? bp?.volume_acceleration_slope);

    const parts: Array<[string, number]> = [
        ['rank_velocity', scale(rankVel, 5, 20)],
        ['volume_acceleration', scale(volAccel, 20, 40)],
        ['momentum_acceleration', scale(momAccel, 0, 50)],
        ['short_return_acceleration', scale(shortAccel, 0, 1)],
        ['turnover_acceleration', scale(turnoverAccel, 20, 40)],
        ['relative_strength_change', scale(rsChange, 0, 30)],
        ['vwap_transition', vwapTransition],
        ['breakout_transition', breakout],
        ['bp_slope', scale(bpSlope * 100, 0, 5)],
    ];

    let sumW = 0;
    let sum = 0;
    for (const [k, score] of parts) {
        const weight = w[k] ?? 0;
        if (weight <= 0) continue;
        sumW += weight;
        sum += weight * score;
    }
    if (sumW <= 0) return 0;
    // Discovery-only fallback: use discovery rank as soft signal
    if (!c && opts.disc) {
        const dBonus = clamp(opts.disc.discovery_score);
        return clamp(sum / sumW * 0.7 + dBonus * 0.3);
    }
    return clamp(sum / sumW);
}
