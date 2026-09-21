// Open-time features from daily history — no same-day close in score inputs.

import { dayChangePct, isLimitUp, openGapPct } from './labels.ts';
import type { BoardOpenFeatures, DailyBar } from './types.ts';

function mean(nums: number[]): number | null {
    if (!nums.length) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Build features for `today` using only bars with date < today,
 * plus today's open (gap). Never uses today's close/high for scoring inputs.
 */
export function buildOpenFeatures(
    today: DailyBar,
    historyAsc: DailyBar[],
): BoardOpenFeatures {
    const prior = historyAsc.filter((b) => b.date < today.date);
    const prev = prior[prior.length - 1] ?? null;
    const prevClose = prev?.close ?? null;

    const window = prior.slice(-20);
    const vols = window.map((b) => b.volume).filter((v) => v > 0);
    const avgVol = mean(vols);
    const prev_vol_ratio_20d =
        prev && avgVol && avgVol > 0 ? prev.volume / avgVol : null;

    const prev_chg_pct = prev
        ? dayChangePct(prev, prior[prior.length - 2]?.close ?? null)
        : null;

    let streak = 0;
    for (let i = prior.length - 1; i >= 1; i--) {
        const bar = prior[i]!;
        const pClose = prior[i - 1]!.close;
        if (isLimitUp(bar, pClose)) streak += 1;
        else break;
    }

    const prev_range_pct =
        prev && prev.close > 0
            ? ((prev.high - prev.low) / prev.close) * 100
            : null;

    return {
        symbol: today.symbol,
        date: today.date,
        gap_pct: openGapPct(today, prevClose),
        prev_chg_pct,
        prev_vol_ratio_20d,
        prev_was_limit_up: Boolean(
            prev &&
                prior.length >= 2 &&
                isLimitUp(prev, prior[prior.length - 2]!.close),
        ),
        prev_limit_streak: streak,
        prev_range_pct,
    };
}
