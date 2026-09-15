// server/src/lib/intraday-rank/metric-engines.ts
// Momentum, volume accel, VWAP structure, RS, breakout, pullback, aggression, heat

import type { SymbolMarketState } from '../open-gate-v2/types.ts';
import type {
    BreakoutType,
    ChaseRisk,
    PullbackState,
} from './types.ts';

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

function returnSince(
    pts: Array<{ t: number; p: number; v: number }>,
    ms: number,
    now: number,
): number | null {
    if (!pts.length) return null;
    const last = pts[pts.length - 1]!;
    const target = now - ms;
    let best = pts[0]!;
    for (const p of pts) {
        if (p.t <= target) best = p;
        else break;
    }
    if (best.p <= 0 || last.p <= 0) return null;
    if (last.t - best.t < ms * 0.4) return null;
    return ((last.p - best.p) / best.p) * 100;
}

function volInWindow(
    pts: Array<{ t: number; p: number; v: number }>,
    ms: number,
    now: number,
): number {
    const from = now - ms;
    return pts.filter((p) => p.t >= from).reduce((a, p) => a + p.v, 0);
}

export function computeMomentum(
    state: SymbolMarketState | undefined,
    nowMs: number,
): {
    return_30s: number | null;
    return_1m: number | null;
    return_3m: number | null;
    return_5m: number | null;
    momentum_acceleration: number;
    score: number | null;
    available: boolean;
} {
    if (!state?.recent_prices.length) {
        return {
            return_30s: null,
            return_1m: null,
            return_3m: null,
            return_5m: null,
            momentum_acceleration: 0,
            score: null,
            available: false,
        };
    }
    const now = nowMs;
    const pts = state.recent_prices;
    const r30 = returnSince(pts, 30_000, now);
    const r1 = returnSince(pts, 60_000, now);
    const r3 = returnSince(pts, 180_000, now);
    const r5 = returnSince(pts, 300_000, now);

    if (r1 == null && r3 == null && r30 == null) {
        return {
            return_30s: r30,
            return_1m: r1,
            return_3m: r3,
            return_5m: r5,
            momentum_acceleration: 0,
            score: null,
            available: false,
        };
    }

    let accel = 50;
    if (r1 != null && r3 != null) {
        const expected = r3 / 3;
        accel = clamp(50 + (r1 - expected) * 40, 0, 100);
    } else if (r30 != null) {
        accel = clamp(50 + r30 * 25, 0, 100);
    }

    let score = 50;
    if (r1 != null) score += clamp(r1 * 12, -20, 25);
    if (r3 != null) score += clamp(r3 * 6, -15, 20);
    score += (accel - 50) * 0.3;

    return {
        return_30s: r30,
        return_1m: r1,
        return_3m: r3,
        return_5m: r5,
        momentum_acceleration: Math.round(accel),
        score: Math.round(clamp(score, 0, 100)),
        available: true,
    };
}

export function computeVolumeAcceleration(
    state: SymbolMarketState | undefined,
    rvolSameTime: number | null,
    nowMs: number,
): {
    volume_1m: number | null;
    volume_3m: number | null;
    volume_acceleration: number | null;
    score: number | null;
    available: boolean;
} {
    if (!state?.recent_prices.length && rvolSameTime == null) {
        return {
            volume_1m: null,
            volume_3m: null,
            volume_acceleration: null,
            score: null,
            available: false,
        };
    }
    if (!state?.recent_prices.length) {
        // rvol-only path still available
        return {
            volume_1m: null,
            volume_3m: null,
            volume_acceleration: rvolSameTime,
            score: Math.round(clamp(40 + (rvolSameTime ?? 0) * 20, 0, 100)),
            available: true,
        };
    }
    const now = nowMs;
    const pts = state.recent_prices;
    const v1 = volInWindow(pts, 60_000, now);
    const v3 = volInWindow(pts, 180_000, now);
    const vPrev = volInWindow(pts, 300_000, now) - v1;
    const prevPerMin = vPrev > 0 ? vPrev / 4 : 0;
    const burst = prevPerMin > 0 ? v1 / prevPerMin : v1 > 0 ? 2 : 0;
    if (burst <= 0 && rvolSameTime == null) {
        return {
            volume_1m: v1,
            volume_3m: v3,
            volume_acceleration: null,
            score: null,
            available: false,
        };
    }
    const rvolPart =
        rvolSameTime != null ? clamp(rvolSameTime / 2.5, 0, 1.5) : 0.5;
    const accel = burst > 0 ? burst : rvolSameTime;
    const score = clamp(
        30 + Math.min(burst || 0, 4) * 12 + rvolPart * 25,
        0,
        100,
    );
    return {
        volume_1m: v1,
        volume_3m: v3,
        volume_acceleration:
            accel != null ? Math.round(accel * 100) / 100 : null,
        score: Math.round(score),
        available: true,
    };
}

export function computeVwapStructure(
    state: SymbolMarketState | undefined,
    vwap: number | null,
    vwapValid: boolean,
): { vwap_pos_pct: number | null; score: number | null; available: boolean } {
    if (!state || !vwapValid || vwap == null || vwap <= 0 || state.last_price <= 0) {
        return { vwap_pos_pct: null, score: null, available: false };
    }
    const pos = ((state.last_price - vwap) / vwap) * 100;
    let score = 50;
    if (pos >= 0 && pos <= 1.5) score = 90;
    else if (pos > 1.5 && pos <= 3) score = 70;
    else if (pos > 3) score = 45;
    else if (pos > -0.8) score = 55;
    else score = 25;

    const pts = state.recent_prices;
    if (pts.length >= 5) {
        const mid = pts[Math.floor(pts.length / 2)]!;
        if (mid.p < vwap && state.last_price >= vwap) score = Math.max(score, 88);
    }
    return {
        vwap_pos_pct: Math.round(pos * 100) / 100,
        score: Math.round(clamp(score, 0, 100)),
        available: true,
    };
}

export function computeRelativeStrength(
    stockRet3m: number | null,
    marketRetHint: number | null,
): { score: number | null; available: boolean } {
    if (stockRet3m == null || marketRetHint == null) {
        return { score: null, available: false };
    }
    const rs = stockRet3m - marketRetHint;
    return {
        score: Math.round(clamp(50 + rs * 20, 0, 100)),
        available: true,
    };
}

export function computeBreakout(state: SymbolMarketState | undefined): {
    score: number | null;
    type: BreakoutType;
    available: boolean;
} {
    if (!state || state.recent_prices.length < 8) {
        return { score: null, type: 'none', available: false };
    }
    const pts = state.recent_prices;
    const last = pts[pts.length - 1]!.p;
    const highDay = state.high || Math.max(...pts.map((p) => p.p));
    const high5 = Math.max(...pts.slice(-Math.min(pts.length, 40)).map((p) => p.p));
    const earlier = pts.slice(0, Math.floor(pts.length * 0.6));
    const baseHigh = earlier.length
        ? Math.max(...earlier.map((p) => p.p))
        : high5;

    if (last >= highDay * 0.998 && last >= baseHigh) {
        return { score: 90, type: 'breakout', available: true };
    }
    if (last >= baseHigh * 0.998 && last < highDay * 0.995) {
        return { score: 85, type: 'rebreak', available: true };
    }
    if (last >= baseHigh * 0.99) {
        return { score: 65, type: 'attempt', available: true };
    }
    if (high5 > baseHigh * 1.01 && last < baseHigh * 0.985) {
        return { score: 25, type: 'failed_breakout', available: true };
    }
    return { score: 45, type: 'none', available: true };
}

export function computePullback(
    state: SymbolMarketState | undefined,
    vwap: number | null,
): { score: number | null; state: PullbackState; available: boolean } {
    if (!state || state.recent_prices.length < 6) {
        return { score: null, state: 'none', available: false };
    }
    const pts = state.recent_prices;
    const last = pts[pts.length - 1]!.p;
    const peak = Math.max(...pts.map((p) => p.p));
    const pull = peak > 0 ? ((peak - last) / peak) * 100 : 0;
    const aboveVwap = vwap != null && last >= vwap * 0.998;

    if (pull < 0.3) return { score: 50, state: 'none', available: true };
    if (pull >= 0.3 && pull <= 1.8 && aboveVwap) {
        const recentVol =
            pts.slice(-3).reduce((a, p) => a + p.v, 0) /
            Math.max(1, pts.slice(-8, -3).reduce((a, p) => a + p.v, 0) / 5);
        if (recentVol < 0.85) {
            return { score: 82, state: 'holding', available: true };
        }
        if (recentVol > 1.1 && last > pts[pts.length - 4]!.p) {
            return { score: 88, state: 'reclaiming', available: true };
        }
        return { score: 70, state: 'pullback', available: true };
    }
    if (pull > 2.5 && !aboveVwap) {
        return { score: 25, state: 'failed', available: true };
    }
    return { score: 55, state: 'pullback', available: true };
}

export function computeTradeAggression(
    state: SymbolMarketState | undefined,
): { score: number | null; available: boolean } {
    // tick_type on stream not stored in recent_prices — use proxy: upticks via price path
    if (!state || state.recent_prices.length < 6) {
        return { score: null, available: false };
    }
    const pts = state.recent_prices.slice(-20);
    let up = 0;
    let down = 0;
    for (let i = 1; i < pts.length; i++) {
        if (pts[i]!.p > pts[i - 1]!.p) up += pts[i]!.v;
        else if (pts[i]!.p < pts[i - 1]!.p) down += pts[i]!.v;
    }
    const tot = up + down;
    if (tot <= 0) return { score: null, available: false };
    const ratio = up / tot;
    return {
        score: Math.round(clamp(ratio * 100, 0, 100)),
        available: true,
    };
}

export function computeChaseRisk(
    dayChgPct: number,
    vwapPos: number | null,
    ret1m: number | null,
    pullbackPct: number,
): ChaseRisk {
    const ext = Math.max(
        Math.abs(dayChgPct),
        Math.abs(vwapPos ?? 0),
        Math.abs(ret1m ?? 0) * 3,
    );
    if (ext >= 6.5 || (dayChgPct >= 5 && pullbackPct < 0.3)) return 'extreme';
    if (ext >= 4) return 'high';
    if (ext >= 2) return 'medium';
    return 'low';
}

export function computeHeat(opts: {
    volAccelScore: number;
    momAccel: number;
    rankVelocity: number | null;
    ret1m: number | null;
}): number {
    const rv = opts.rankVelocity != null ? clamp(opts.rankVelocity / 30, 0, 1) : 0;
    return Math.round(
        clamp(
            opts.volAccelScore * 0.35 +
                opts.momAccel * 0.3 +
                rv * 100 * 0.25 +
                clamp((opts.ret1m ?? 0) * 20, 0, 20) * 0.1,
            0,
            100,
        ),
    );
}

export function computeLiquidityScore(
    state: SymbolMarketState | undefined,
): { score: number | null; spread_pct: number | null; available: boolean } {
    if (!state || (state.last_price <= 0 && state.tick_count === 0)) {
        return { score: null, spread_pct: null, available: false };
    }
    const mid =
        state.best_bid > 0 && state.best_ask > 0
            ? (state.best_bid + state.best_ask) / 2
            : state.last_price;
    const spread =
        state.best_bid > 0 && state.best_ask > 0 && mid > 0
            ? ((state.best_ask - state.best_bid) / mid) * 100
            : null;
    let score = 50;
    if ((state.total_amount || state.turnover) > 20_000_000) score += 25;
    else if ((state.total_amount || state.turnover) > 5_000_000) score += 12;
    if (spread != null) {
        if (spread <= 0.2) score += 20;
        else if (spread <= 0.5) score += 8;
        else score -= 15;
    }
    if (state.tick_count >= 20) score += 10;
    return {
        score: Math.round(clamp(score, 0, 100)),
        spread_pct: spread,
        available: true,
    };
}

/** Rank at a lookback window using timestamped history. */
export function rankAtLookback(
    hist: Array<{ t: number; rank: number }>,
    nowMs: number,
    lookbackMs: number,
): number | null {
    if (!hist.length) return null;
    const target = nowMs - lookbackMs;
    let best: { t: number; rank: number } | null = null;
    for (const h of hist) {
        if (h.t <= target) best = h;
        else break;
    }
    return best?.rank ?? null;
}
