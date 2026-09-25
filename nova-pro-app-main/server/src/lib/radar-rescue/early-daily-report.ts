// EARLY daily validation report — read-only aggregation by trade_date + source.
// Never mix replay / synthetic / live into one success rate.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
    EarlyBacktestOutcome,
    EarlyBacktestSummary,
    MetricBucket,
    MetricVerdict,
    TargetMetric,
} from './early-backtest.ts';

export type EarlyReportSource = 'replay' | 'synthetic' | 'live';

export const EARLY_REPORT_SOURCE_LABEL: Record<EarlyReportSource, string> = {
    replay: '歷史重播',
    synthetic: '模擬資料',
    live: '實盤歷史',
};

export interface MetricBucketView {
    success: number;
    fail: number;
    incomplete: number;
    unknown: number;
    /** SUCCESS + FAIL — rate denominator. */
    denominator: number;
    rate: number | null;
    /** "xx.x%" or "資料不足" when denominator is 0. Never "0%" for empty denom. */
    rate_label: string;
}

export interface ActiveUpgradeBucketView extends MetricBucketView {
    /** Explicit: not a trading win-rate. */
    kind: 'state_upgrade_rate';
    label: '狀態升級率';
}

export interface EarlySignalReportRow {
    signal_id: string;
    symbol: string;
    triggered_at: string;
    triggered_at_ms: number;
    trigger_price: number;
    day_reference_price: number | null;
    change_pct_at_trigger: number | null;
    state_at_trigger: string;
    terminal_state: string;
    day_plus_3pct: SignalMetricCell;
    day_plus_5pct: SignalMetricCell;
    post_trigger_plus_3pct: SignalMetricCell;
    post_trigger_plus_5pct: SignalMetricCell;
    active_upgrade: SignalMetricCell & { reached: boolean };
    max_price: number | null;
    max_return_vs_trigger_pct: number | null;
    max_return_vs_day_ref_pct: number | null;
    tracking_to_close: boolean;
}

export interface SignalMetricCell {
    verdict: MetricVerdict;
    first_hit_after_min: number | null;
    first_hit_bar_known_at_ms: number | null;
    time_precision: '1m_bar' | 'none';
}

export interface EarlyDailyReport {
    trade_date: string;
    source: EarlyReportSource;
    source_label: string;
    signal_count: number;
    unique_symbol_count: number;
    data_completeness_rate: number | null;
    data_completeness_label: string;
    day_plus_3pct: MetricBucketView;
    day_plus_5pct: MetricBucketView;
    post_trigger_plus_3pct: MetricBucketView;
    post_trigger_plus_5pct: MetricBucketView;
    active_upgrade: ActiveUpgradeBucketView;
    signals: EarlySignalReportRow[];
    note: string;
}

const RATE_INSUFFICIENT = '資料不足';

export function formatRateLabel(rate: number | null, denominator: number): string {
    if (denominator <= 0 || rate == null || !Number.isFinite(rate)) {
        return RATE_INSUFFICIENT;
    }
    return `${(rate * 100).toFixed(1)}%`;
}

export function toBucketView(b: MetricBucket): MetricBucketView {
    const denominator = b.success + b.fail;
    return {
        success: b.success,
        fail: b.fail,
        incomplete: b.incomplete,
        unknown: b.unknown,
        denominator,
        rate: b.rate,
        rate_label: formatRateLabel(b.rate, denominator),
    };
}

function cellFrom(m: TargetMetric): SignalMetricCell {
    return {
        verdict: m.verdict,
        first_hit_after_min: m.first_hit_after_min,
        first_hit_bar_known_at_ms: m.first_hit_bar_known_at_ms,
        time_precision: m.time_precision,
    };
}

function rowFrom(o: EarlyBacktestOutcome): EarlySignalReportRow {
    return {
        signal_id: o.signal_id,
        symbol: o.symbol,
        triggered_at: new Date(o.triggered_at_ms).toISOString(),
        triggered_at_ms: o.triggered_at_ms,
        trigger_price: o.trigger_price,
        day_reference_price: o.day_reference_price,
        change_pct_at_trigger: o.change_pct_at_trigger,
        state_at_trigger: o.state_at_trigger,
        terminal_state: o.terminal_state,
        day_plus_3pct: cellFrom(o.day_plus_3pct),
        day_plus_5pct: cellFrom(o.day_plus_5pct),
        post_trigger_plus_3pct: cellFrom(o.post_trigger_plus_3pct),
        post_trigger_plus_5pct: cellFrom(o.post_trigger_plus_5pct),
        active_upgrade: {
            ...cellFrom(o.active_upgrade),
            reached: o.active_upgrade.reached,
        },
        max_price: o.max_price,
        max_return_vs_trigger_pct: o.max_return_vs_trigger_pct,
        max_return_vs_day_ref_pct: o.max_return_vs_day_ref_pct,
        tracking_to_close: o.tracking_to_close,
    };
}

/**
 * Build a single-source daily report. Callers must pass outcomes from ONE source only.
 */
export function buildEarlyDailyReport(
    summary: EarlyBacktestSummary,
    opts: { trade_date: string; source: EarlyReportSource },
): EarlyDailyReport {
    const day3 = toBucketView(summary.day_plus_3pct);
    // Completeness denom excludes UNKNOWN; if nothing resolved (SUCCESS+FAIL=0),
    // treat as insufficient — never show "0%" when only INCOMPLETE/UNKNOWN remain.
    const resolved =
        summary.day_plus_3pct.success + summary.day_plus_3pct.fail;
    const completenessDenom =
        resolved + summary.day_plus_3pct.incomplete;
    const data_completeness_rate = summary.data_completeness_rate;
    const active = toBucketView(summary.active_upgrade);

    return {
        trade_date: opts.trade_date,
        source: opts.source,
        source_label: EARLY_REPORT_SOURCE_LABEL[opts.source],
        signal_count: summary.signal_count,
        unique_symbol_count: summary.unique_symbol_count,
        data_completeness_rate,
        data_completeness_label:
            resolved <= 0 ||
            completenessDenom <= 0 ||
            data_completeness_rate == null
                ? RATE_INSUFFICIENT
                : `${(data_completeness_rate * 100).toFixed(1)}%`,
        day_plus_3pct: day3,
        day_plus_5pct: toBucketView(summary.day_plus_5pct),
        post_trigger_plus_3pct: toBucketView(summary.post_trigger_plus_3pct),
        post_trigger_plus_5pct: toBucketView(summary.post_trigger_plus_5pct),
        active_upgrade: {
            ...active,
            kind: 'state_upgrade_rate',
            label: '狀態升級率',
        },
        signals: summary.outcomes.map(rowFrom),
        note:
            '成功率 = SUCCESS / (SUCCESS + FAIL)。INCOMPLETE／UNKNOWN 不進分母。' +
            'ACTIVE 為狀態升級率，不是交易勝率。' +
            '不同資料來源（歷史重播／模擬／實盤）必須分開查看，不可混算。',
    };
}

function reportFileName(date: string, source: EarlyReportSource): string {
    return `${date}.${source}.json`;
}

export class EarlyDailyReportStore {
    constructor(private dataDir: string) {}

    private dir(): string {
        return join(this.dataDir, 'early_daily_reports');
    }

    save(report: EarlyDailyReport): string {
        const dir = this.dir();
        mkdirSync(dir, { recursive: true });
        const path = join(dir, reportFileName(report.trade_date, report.source));
        writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
        return path;
    }

    load(date: string, source: EarlyReportSource): EarlyDailyReport | null {
        const path = join(this.dir(), reportFileName(date, source));
        if (!existsSync(path)) return null;
        try {
            return JSON.parse(readFileSync(path, 'utf8')) as EarlyDailyReport;
        } catch {
            return null;
        }
    }

    listSources(date: string): EarlyReportSource[] {
        const dir = this.dir();
        if (!existsSync(dir)) return [];
        const out: EarlyReportSource[] = [];
        const prefix = `${date}.`;
        for (const name of readdirSync(dir)) {
            if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
            const src = name.slice(prefix.length, -'.json'.length);
            if (src === 'replay' || src === 'synthetic' || src === 'live') {
                out.push(src);
            }
        }
        return out.sort();
    }

    /** All reports for a date, one object per source — never merged rates. */
    loadAllForDate(date: string): EarlyDailyReport[] {
        return this.listSources(date)
            .map((s) => this.load(date, s))
            .filter((r): r is EarlyDailyReport => r != null);
    }
}
