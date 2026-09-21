// Limit-up labels from daily bars (TW cash session).

import type { DailyBar } from './types.ts';

/** Prefer ~10% board; treat >=9.5% as limit-up proxy (tick rounding). */
export const LIMIT_UP_PCT = 9.5;

export function dayChangePct(
    bar: DailyBar,
    prevClose: number | null | undefined,
): number | null {
    if (prevClose == null || !(prevClose > 0) || !(bar.close > 0)) return null;
    return ((bar.close - prevClose) / prevClose) * 100;
}

export function openGapPct(
    bar: DailyBar,
    prevClose: number | null | undefined,
): number | null {
    if (prevClose == null || !(prevClose > 0) || !(bar.open > 0)) return null;
    return ((bar.open - prevClose) / prevClose) * 100;
}

export function isLimitUp(
    bar: DailyBar,
    prevClose: number | null | undefined,
    thresholdPct = LIMIT_UP_PCT,
): boolean {
    const chg = dayChangePct(bar, prevClose);
    if (chg == null) return false;
    if (chg >= thresholdPct) return true;
    // Locked at high == close and near theoretical +10%
    if (
        bar.high > 0 &&
        bar.close > 0 &&
        Math.abs(bar.high - bar.close) / bar.close < 0.001 &&
        chg >= thresholdPct - 0.3
    ) {
        return true;
    }
    return false;
}
