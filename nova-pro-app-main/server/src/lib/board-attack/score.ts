// Placeholder scoring — equal weight / single feature until sweep picks winners.

import type { BoardOpenFeatures, BoardScoredRow } from './types.ts';
import { dayChangePct, isLimitUp } from './labels.ts';
import type { DailyBar } from './types.ts';

export type ScoreFeatureKey =
    | 'gap_pct'
    | 'prev_chg_pct'
    | 'prev_vol_ratio_20d'
    | 'prev_was_limit_up'
    | 'prev_limit_streak'
    | 'prev_range_pct';

export const DEFAULT_SCORE_FEATURES: ScoreFeatureKey[] = [
    'gap_pct',
    'prev_chg_pct',
    'prev_vol_ratio_20d',
    'prev_was_limit_up',
    'prev_limit_streak',
    'prev_range_pct',
];

function rawValue(
    f: BoardOpenFeatures,
    key: ScoreFeatureKey,
): number | null {
    if (key === 'prev_was_limit_up') return f.prev_was_limit_up ? 1 : 0;
    const v = f[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Cross-sectional z-score; missing → 0 contribution. */
function zScores(values: Array<number | null>): number[] {
    const present = values.filter((v): v is number => v != null);
    if (present.length < 2) {
        return values.map((v) => (v == null ? 0 : 0));
    }
    const mu = present.reduce((a, b) => a + b, 0) / present.length;
    const varSum = present.reduce((a, b) => a + (b - mu) ** 2, 0);
    const sd = Math.sqrt(varSum / present.length);
    if (!(sd > 1e-9)) return values.map(() => 0);
    return values.map((v) => (v == null ? 0 : (v - mu) / sd));
}

export function scoreEqualWeight(
    features: BoardOpenFeatures[],
    keys: ScoreFeatureKey[] = DEFAULT_SCORE_FEATURES,
): Array<{ symbol: string; score: number }> {
    const perKey = keys.map((k) =>
        zScores(features.map((f) => rawValue(f, k))),
    );
    return features.map((f, i) => {
        let s = 0;
        for (const col of perKey) s += col[i] ?? 0;
        return { symbol: f.symbol, score: s / keys.length };
    });
}

export function scoreSingleFeature(
    features: BoardOpenFeatures[],
    key: ScoreFeatureKey,
): Array<{ symbol: string; score: number }> {
    const zs = zScores(features.map((f) => rawValue(f, key)));
    return features.map((f, i) => ({
        symbol: f.symbol,
        score: zs[i] ?? 0,
    }));
}

export function attachRanksAndLabels(
    features: BoardOpenFeatures[],
    scores: Array<{ symbol: string; score: number }>,
    todayBars: Map<string, DailyBar>,
    prevCloseBySymbol: Map<string, number | null>,
): BoardScoredRow[] {
    const scoreMap = new Map(scores.map((s) => [s.symbol, s.score]));
    const rows: BoardScoredRow[] = features.map((f) => {
        const bar = todayBars.get(f.symbol);
        const prev = prevCloseBySymbol.get(f.symbol) ?? null;
        const day_chg_pct = bar ? dayChangePct(bar, prev) : null;
        return {
            ...f,
            score: scoreMap.get(f.symbol) ?? 0,
            rank: 0,
            is_limit_up: bar ? isLimitUp(bar, prev) : false,
            day_chg_pct,
        };
    });
    rows.sort((a, b) => b.score - a.score);
    rows.forEach((r, i) => {
        r.rank = i + 1;
    });
    return rows;
}
