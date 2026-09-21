// Recall / precision for Top-N vs same-day limit-up labels.

import type { BoardScoredRow, DayBacktestResult } from './types.ts';

function avg(nums: number[]): number | null {
    if (!nums.length) return null;
    return (
        Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) /
        1000
    );
}

export function evaluateDay(
    date: string,
    ranked: BoardScoredRow[],
    topN: number,
): DayBacktestResult {
    const limitUps = ranked.filter((r) => r.is_limit_up);
    const top = ranked.slice(0, Math.max(1, topN));
    const hits = top.filter((r) => r.is_limit_up);
    const limit_up_count = limitUps.length;
    const hit_in_top_n = hits.length;
    const recall =
        limit_up_count > 0
            ? Math.round((hit_in_top_n / limit_up_count) * 1000) / 1000
            : null;
    const precision =
        top.length > 0
            ? Math.round((hit_in_top_n / top.length) * 1000) / 1000
            : null;
    const gaps = hits
        .map((h) => h.gap_pct)
        .filter((v): v is number => v != null);
    return {
        date,
        limit_up_count,
        universe_count: ranked.length,
        top_n: topN,
        hit_in_top_n,
        recall,
        precision,
        avg_gap_pct_hits: avg(gaps),
        rows: ranked,
    };
}

export function meanMetric(
    days: DayBacktestResult[],
    key: 'recall' | 'precision',
): number | null {
    const vals = days
        .map((d) => d[key])
        .filter((v): v is number => v != null);
    return avg(vals);
}
