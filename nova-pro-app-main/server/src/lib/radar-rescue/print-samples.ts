// Convert market recent_prices (live ticks or 1m closes) into breakout print samples.

import type { BreakoutPrintSample } from './attack-state.ts';

export type RecentPricePoint = { t: number; p: number; v?: number };

/**
 * Map engine recent_prices → distinct BreakoutPrintSample[].
 * Live: real ticks. Replay 1m: one sample per completed bar close.
 */
export function printsFromRecentPrices(
    recent: RecentPricePoint[] | null | undefined,
    nowMs: number,
    maxAgeMs = 90_000,
): BreakoutPrintSample[] {
    if (!recent?.length) return [];
    const out: BreakoutPrintSample[] = [];
    const seen = new Set<string>();
    for (const r of recent) {
        if (!(r.p > 0) || !(r.t > 0)) continue;
        if (nowMs - r.t > maxAgeMs || r.t > nowMs + 1_000) continue;
        const key = `${r.t}:${r.p}:${r.v ?? 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ trade_key: key, ts_ms: r.t, price: r.p });
    }
    return out;
}
