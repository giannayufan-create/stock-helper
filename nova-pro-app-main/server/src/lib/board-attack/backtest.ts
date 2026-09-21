// Offline BoardAttack backtest orchestrator.

import { buildOpenFeatures } from './features.ts';
import { FinMindDailyPriceStore } from './finmind-daily.ts';
import { evaluateDay, meanMetric } from './metrics.ts';
import {
    attachRanksAndLabels,
    DEFAULT_SCORE_FEATURES,
    scoreEqualWeight,
    scoreSingleFeature,
    type ScoreFeatureKey,
} from './score.ts';
import {
    BOARD_ATTACK_NOTES,
    type BacktestSummary,
    type DailyBar,
    type DayBacktestResult,
    type FeatureSweepResult,
} from './types.ts';

function addDays(ymd: string, delta: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y!, m! - 1, d! + delta));
    return dt.toISOString().slice(0, 10);
}

function listDatesInclusive(from: string, to: string): string[] {
    const out: string[] = [];
    let cur = from;
    while (cur <= to) {
        out.push(cur);
        cur = addDays(cur, 1);
    }
    return out;
}

export interface BacktestOptions {
    from: string;
    to: string;
    topN?: number;
    /** Warmup calendar days before `from` for vol / streak features. */
    lookbackDays?: number;
    store?: FinMindDailyPriceStore;
    /** Injected day map for tests — skips FinMind. */
    dayBars?: Map<string, DailyBar[]>;
    mode?: 'equal_weight' | 'single_feature';
    feature?: ScoreFeatureKey;
    /** Min previous closes required in history. */
    minHistory?: number;
}

function indexBySymbol(bars: DailyBar[]): Map<string, DailyBar> {
    const m = new Map<string, DailyBar>();
    for (const b of bars) m.set(b.symbol, b);
    return m;
}

function historyForSymbol(
    byDate: Map<string, Map<string, DailyBar>>,
    datesAsc: string[],
    symbol: string,
    beforeDate: string,
): DailyBar[] {
    const out: DailyBar[] = [];
    for (const d of datesAsc) {
        if (d >= beforeDate) break;
        const bar = byDate.get(d)?.get(symbol);
        if (bar) out.push(bar);
    }
    return out;
}

export async function runBoardAttackBacktest(
    opts: BacktestOptions,
): Promise<BacktestSummary> {
    const topN = opts.topN ?? 20;
    const lookback = opts.lookbackDays ?? 30;
    const minHistory = opts.minHistory ?? 5;
    const mode = opts.mode ?? 'equal_weight';
    const store = opts.store ?? new FinMindDailyPriceStore();

    const warmupFrom = addDays(opts.from, -lookback);
    const allDates = listDatesInclusive(warmupFrom, opts.to);
    const byDate = new Map<string, Map<string, DailyBar>>();

    for (const d of allDates) {
        const bars =
            opts.dayBars?.get(d) ?? (await store.fetchDay(d).catch(() => []));
        if (bars.length) byDate.set(d, indexBySymbol(bars));
    }

    const evalDates = listDatesInclusive(opts.from, opts.to).filter((d) =>
        byDate.has(d),
    );
    const days: DayBacktestResult[] = [];

    for (const date of evalDates) {
        const todayMap = byDate.get(date)!;
        const features = [];
        const prevCloseBySymbol = new Map<string, number | null>();

        for (const [symbol, today] of todayMap) {
            const hist = historyForSymbol(byDate, allDates, symbol, date);
            if (hist.length < minHistory) continue;
            const prev = hist[hist.length - 1] ?? null;
            prevCloseBySymbol.set(symbol, prev?.close ?? null);
            features.push(buildOpenFeatures(today, hist));
        }

        if (!features.length) continue;

        const scores =
            mode === 'single_feature' && opts.feature
                ? scoreSingleFeature(features, opts.feature)
                : scoreEqualWeight(features, DEFAULT_SCORE_FEATURES);

        const ranked = attachRanksAndLabels(
            features,
            scores,
            todayMap,
            prevCloseBySymbol,
        );
        days.push(evaluateDay(date, ranked, topN));
    }

    const total_limit_ups = days.reduce((a, d) => a + d.limit_up_count, 0);
    const total_hits = days.reduce((a, d) => a + d.hit_in_top_n, 0);

    return {
        from: opts.from,
        to: opts.to,
        top_n: topN,
        mode,
        feature: opts.feature,
        days,
        mean_recall: meanMetric(days, 'recall'),
        mean_precision: meanMetric(days, 'precision'),
        total_limit_ups,
        total_hits,
        notes: [...BOARD_ATTACK_NOTES],
    };
}

export async function sweepSingleFeatures(
    opts: Omit<BacktestOptions, 'mode' | 'feature'>,
): Promise<FeatureSweepResult[]> {
    const out: FeatureSweepResult[] = [];
    for (const feature of DEFAULT_SCORE_FEATURES) {
        const summary = await runBoardAttackBacktest({
            ...opts,
            mode: 'single_feature',
            feature,
        });
        out.push({
            feature,
            top_n: summary.top_n,
            days: summary.days.length,
            mean_recall: summary.mean_recall,
            mean_precision: summary.mean_precision,
        });
    }
    out.sort(
        (a, b) => (b.mean_recall ?? -1) - (a.mean_recall ?? -1),
    );
    return out;
}
