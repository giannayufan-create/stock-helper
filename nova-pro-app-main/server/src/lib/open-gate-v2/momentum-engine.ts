// server/src/lib/open-gate-v2/momentum-engine.ts — rule-based, backtestable

import type { SymbolMarketState } from './types.ts';

export interface MomentumResult {
    momentum_score: number | null;
    available: boolean;
    higher_highs: boolean;
    higher_lows: boolean;
    volume_accel: boolean;
    notes: string[];
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

/**
 * Independent momentum module so it can be backtested alone later.
 */
export function runMomentumEngine(state: SymbolMarketState | undefined): MomentumResult {
    const notes: string[] = [];
    if (!state || state.recent_prices.length < 3) {
        return {
            momentum_score: null,
            available: false,
            higher_highs: false,
            higher_lows: false,
            volume_accel: false,
            notes: ['momentum 資料不足'],
        };
    }

    const pts = state.recent_prices;
    const n = pts.length;
    const first = pts[0]!;
    const last = pts[n - 1]!;
    const mid = pts[Math.floor(n / 2)]!;

    const slope =
        first.p > 0 ? ((last.p - first.p) / first.p) * 100 : 0;
    const slope2 =
        mid.p > 0 ? ((last.p - mid.p) / mid.p) * 100 : 0;

    // higher highs / higher lows on thirds
    const third = Math.max(1, Math.floor(n / 3));
    const seg = (a: number, b: number) => pts.slice(a, b);
    const maxP = (xs: typeof pts) => Math.max(...xs.map((x) => x.p));
    const minP = (xs: typeof pts) => Math.min(...xs.map((x) => x.p));
    const s0 = seg(0, third);
    const s1 = seg(third, third * 2);
    const s2 = seg(third * 2, n);
    const higher_highs = maxP(s2) >= maxP(s1) && maxP(s1) >= maxP(s0);
    const higher_lows = minP(s2) >= minP(s1) && minP(s1) >= minP(s0);

    const vol0 = s0.reduce((a, x) => a + x.v, 0) / Math.max(1, s0.length);
    const vol2 = s2.reduce((a, x) => a + x.v, 0) / Math.max(1, s2.length);
    const volume_accel = vol2 > vol0 * 1.15;

    const brokeShortHigh =
        last.p >= maxP(pts.slice(0, -1)) * 0.999;

    let score = 50;
    score += clamp(slope * 12, -20, 25);
    score += clamp(slope2 * 18, -15, 20);
    if (higher_highs) {
        score += 10;
        notes.push('higher highs');
    }
    if (higher_lows) {
        score += 8;
        notes.push('higher lows');
    }
    if (volume_accel) {
        score += 8;
        notes.push('量能加速');
    }
    if (brokeShortHigh) {
        score += 6;
        notes.push('突破短線高點');
    }
    if (slope < -0.4) {
        notes.push('短線斜率轉負');
        score -= 8;
    }

    return {
        momentum_score: Math.round(clamp(score, 0, 100)),
        available: true,
        higher_highs,
        higher_lows,
        volume_accel,
        notes,
    };
}
