// server/src/lib/signal-outcome/analytics.ts
// Group statistics only — positive_rate NOT win_rate. No ML.

import type { StrategySignal, SignalType } from '../strategy-signal/types.ts';
import type { SignalOutcome } from './types.ts';

export interface AnalyticsFilter {
    from?: string;
    to?: string;
    signal_type?: SignalType | SignalType[];
    market_regime?: string;
    score_min?: number;
    score_max?: number;
    heat_min?: number;
    heat_max?: number;
    learning_eligible?: boolean;
    source_mode?: 'live' | 'replay';
    data_resolution?: 'tick' | '1m';
    score_confidence?: 'high' | 'medium' | 'low';
    strategy_version?: string;
    high_confidence_only?: boolean;
}

export interface SignalTypeStats {
    signal_type: string;
    count: number;
    avg_forward_return_5m: number | null;
    avg_forward_return_15m: number | null;
    avg_forward_return_30m: number | null;
    avg_forward_return_60m: number | null;
    median_forward_return_15m: number | null;
    avg_MFE_15m: number | null;
    avg_MAE_15m: number | null;
    invalid_hit_rate: number | null;
    hit_1pct_rate: number | null;
    hit_2pct_rate: number | null;
    hit_3pct_rate: number | null;
    positive_5m_rate: number | null;
    positive_15m_rate: number | null;
    positive_30m_rate: number | null;
    ambiguous_count: number;
}

export interface BucketStats {
    bucket: string;
    count: number;
    positive_15m_rate: number | null;
    avg_return_15m: number | null;
    avg_MFE_15m: number | null;
    avg_MAE_15m: number | null;
}

function avg(nums: number[]): number | null {
    if (!nums.length) return null;
    return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

function median(nums: number[]): number | null {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    const v =
        s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
    return Math.round(v * 100) / 100;
}

function rate(ok: number, n: number): number | null {
    if (!n) return null;
    return Math.round((ok / n) * 1000) / 10;
}

function joinSignals(
    signals: StrategySignal[],
    outcomes: SignalOutcome[],
): Array<{ s: StrategySignal; o: SignalOutcome }> {
    const om = new Map(outcomes.map((o) => [o.signal_id, o]));
    const out: Array<{ s: StrategySignal; o: SignalOutcome }> = [];
    for (const s of signals) {
        const o = om.get(s.signal_id);
        if (o) out.push({ s, o });
    }
    return out;
}

export function applyFilters(
    rows: Array<{ s: StrategySignal; o: SignalOutcome }>,
    f: AnalyticsFilter,
): Array<{ s: StrategySignal; o: SignalOutcome }> {
    return rows.filter(({ s, o }) => {
        if (f.from && s.signal_time.slice(0, 10) < f.from) return false;
        if (f.to && s.signal_time.slice(0, 10) > f.to) return false;
        if (f.signal_type) {
            const types = Array.isArray(f.signal_type)
                ? f.signal_type
                : [f.signal_type];
            if (!types.includes(s.signal_type)) return false;
        }
        if (f.market_regime && s.market_regime !== f.market_regime)
            return false;
        if (f.score_min != null && (s.score ?? 0) < f.score_min) return false;
        if (f.score_max != null && (s.score ?? 0) > f.score_max) return false;
        if (f.heat_min != null && (s.heat_score ?? 0) < f.heat_min)
            return false;
        if (f.heat_max != null && (s.heat_score ?? 0) > f.heat_max)
            return false;
        if (
            f.learning_eligible != null &&
            s.learning_eligible !== f.learning_eligible
        ) {
            return false;
        }
        if (f.source_mode && s.source_mode !== f.source_mode) return false;
        if (f.data_resolution && s.data_resolution !== f.data_resolution)
            return false;
        if (
            f.score_confidence &&
            s.score_confidence !== f.score_confidence
        ) {
            return false;
        }
        if (
            f.strategy_version &&
            s.strategy_version !== f.strategy_version
        ) {
            return false;
        }
        if (f.high_confidence_only) {
            if (!s.learning_eligible) return false;
            if (s.score_confidence === 'low') return false;
            if (o.status === 'invalid_data') return false;
            if (o.corporate_action_crossed) return false;
        }
        // Default learning paths: exclude CA-crossed unadjusted outcomes
        if (o.corporate_action_crossed && f.learning_eligible !== false) {
            if (f.high_confidence_only || f.learning_eligible === true) {
                return false;
            }
        }
        // Default: do not mix live tick with replay 1m unless both unset
        return true;
    });
}

export function groupBySignalType(
    signals: StrategySignal[],
    outcomes: SignalOutcome[],
    filter: AnalyticsFilter = {},
): SignalTypeStats[] {
    const rows = applyFilters(joinSignals(signals, outcomes), filter);
    const groups = new Map<string, Array<{ s: StrategySignal; o: SignalOutcome }>>();
    for (const row of rows) {
        const k = row.s.signal_type;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(row);
    }

    const stats: SignalTypeStats[] = [];
    for (const [signal_type, list] of [...groups.entries()].sort()) {
        const fr5 = list
            .map((r) => r.o.forward_return_5m)
            .filter((x): x is number => x != null);
        const fr15 = list
            .map((r) => r.o.forward_return_15m)
            .filter((x): x is number => x != null);
        const fr30 = list
            .map((r) => r.o.forward_return_30m)
            .filter((x): x is number => x != null);
        const fr60 = list
            .map((r) => r.o.forward_return_60m)
            .filter((x): x is number => x != null);
        const mfe15 = list
            .map((r) => r.o.mfe_15m)
            .filter((x): x is number => x != null);
        const mae15 = list
            .map((r) => r.o.mae_15m)
            .filter((x): x is number => x != null);

        stats.push({
            signal_type,
            count: list.length,
            avg_forward_return_5m: avg(fr5),
            avg_forward_return_15m: avg(fr15),
            avg_forward_return_30m: avg(fr30),
            avg_forward_return_60m: avg(fr60),
            median_forward_return_15m: median(fr15),
            avg_MFE_15m: avg(mfe15),
            avg_MAE_15m: avg(mae15),
            invalid_hit_rate: rate(
                list.filter((r) => r.o.invalid_hit).length,
                list.filter((r) => r.o.invalid_hit != null).length,
            ),
            hit_1pct_rate: rate(
                list.filter((r) => r.o.hit_plus_1pct).length,
                list.length,
            ),
            hit_2pct_rate: rate(
                list.filter((r) => r.o.hit_plus_2pct).length,
                list.length,
            ),
            hit_3pct_rate: rate(
                list.filter((r) => r.o.hit_plus_3pct).length,
                list.length,
            ),
            positive_5m_rate: rate(
                fr5.filter((x) => x > 0).length,
                fr5.length,
            ),
            positive_15m_rate: rate(
                fr15.filter((x) => x > 0).length,
                fr15.length,
            ),
            positive_30m_rate: rate(
                fr30.filter((x) => x > 0).length,
                fr30.length,
            ),
            ambiguous_count: list.filter(
                (r) =>
                    r.o.outcome_sequence === 'ambiguous' ||
                    r.o.status === 'ambiguous',
            ).length,
        });
    }
    return stats;
}

function bucketStats(
    rows: Array<{ s: StrategySignal; o: SignalOutcome }>,
    label: (s: StrategySignal) => string | null,
): BucketStats[] {
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
        const b = label(row.s);
        if (!b) continue;
        if (!groups.has(b)) groups.set(b, []);
        groups.get(b)!.push(row);
    }
    return [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([bucket, list]) => {
            const fr15 = list
                .map((r) => r.o.forward_return_15m)
                .filter((x): x is number => x != null);
            const mfe15 = list
                .map((r) => r.o.mfe_15m)
                .filter((x): x is number => x != null);
            const mae15 = list
                .map((r) => r.o.mae_15m)
                .filter((x): x is number => x != null);
            return {
                bucket,
                count: list.length,
                positive_15m_rate: rate(
                    fr15.filter((x) => x > 0).length,
                    fr15.length,
                ),
                avg_return_15m: avg(fr15),
                avg_MFE_15m: avg(mfe15),
                avg_MAE_15m: avg(mae15),
            };
        });
}

export function scoreBucketsC(
    signals: StrategySignal[],
    outcomes: SignalOutcome[],
    filter: AnalyticsFilter = {},
): BucketStats[] {
    const rows = applyFilters(joinSignals(signals, outcomes), {
        ...filter,
        // C scores
    }).filter((r) => r.s.source === 'C');
    return bucketStats(rows, (s) => {
        const sc = s.score ?? 0;
        if (sc >= 90) return '90+';
        if (sc >= 85) return '85–89';
        if (sc >= 80) return '80–84';
        if (sc >= 70) return '70–79';
        if (sc >= 60) return '60–69';
        return null;
    });
}

export function heatBuckets(
    signals: StrategySignal[],
    outcomes: SignalOutcome[],
    filter: AnalyticsFilter = {},
): BucketStats[] {
    const rows = applyFilters(joinSignals(signals, outcomes), filter).filter(
        (r) => r.s.heat_score != null,
    );
    return bucketStats(rows, (s) => {
        const h = s.heat_score ?? 0;
        if (h >= 90) return 'Heat 90+';
        if (h >= 80) return 'Heat 80–89';
        if (h >= 70) return 'Heat 70–79';
        return 'Heat <70';
    });
}

export function openPassScoreBuckets(
    signals: StrategySignal[],
    outcomes: SignalOutcome[],
    filter: AnalyticsFilter = {},
): BucketStats[] {
    const rows = applyFilters(joinSignals(signals, outcomes), {
        ...filter,
        signal_type: 'OPEN_PASS',
    });
    return bucketStats(rows, (s) => {
        const sc = s.score ?? 0;
        if (sc >= 90) return '90+';
        if (sc >= 86) return '86–89';
        if (sc >= 82) return '82–85';
        if (sc >= 78) return '78–81';
        return null;
    });
}

export function regimeGroups(
    signals: StrategySignal[],
    outcomes: SignalOutcome[],
    filter: AnalyticsFilter = {},
): SignalTypeStats[] {
    // reuse groupBySignalType after tagging — simpler: group by regime then type
    const rows = applyFilters(joinSignals(signals, outcomes), filter);
    const byRegime = new Map<string, typeof rows>();
    for (const row of rows) {
        const k = row.s.market_regime ?? 'unknown';
        if (!byRegime.has(k)) byRegime.set(k, []);
        byRegime.get(k)!.push(row);
    }
    const out: SignalTypeStats[] = [];
    for (const [regime, list] of byRegime) {
        const fakeSignals = list.map((r) => ({
            ...r.s,
            signal_type: `${regime}::${r.s.signal_type}` as SignalType,
        }));
        const fakeOutcomes = list.map((r) => r.o);
        out.push(...groupBySignalType(fakeSignals, fakeOutcomes, {}));
    }
    return out;
}

export function formatAnalyticsTable(stats: SignalTypeStats[]): string {
    const header =
        'Signal'.padEnd(18) +
        'Count'.padStart(7) +
        ' +15mPos%'.padStart(10) +
        ' AvgMFE15'.padStart(10) +
        ' AvgMAE15'.padStart(10) +
        ' Amb'.padStart(6);
    const lines = [header, '-'.repeat(header.length)];
    for (const s of stats) {
        lines.push(
            s.signal_type.padEnd(18) +
                String(s.count).padStart(7) +
                String(s.positive_15m_rate ?? '-').padStart(10) +
                String(s.avg_MFE_15m ?? '-').padStart(10) +
                String(s.avg_MAE_15m ?? '-').padStart(10) +
                String(s.ambiguous_count).padStart(6),
        );
    }
    return lines.join('\n');
}
