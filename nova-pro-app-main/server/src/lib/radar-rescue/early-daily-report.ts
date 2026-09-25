// EARLY daily validation report — read-only aggregation by trade_date + source.
// Never mix replay / synthetic / live into one success rate.
// Full vs partial (--until) runs are stored separately and never overwrite each other.

import {
    mkdirSync,
    writeFileSync,
    readFileSync,
    existsSync,
    readdirSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import type {
    EarlyBacktestOutcome,
    EarlyBacktestSummary,
    MetricBucket,
    MetricVerdict,
    TargetMetric,
} from './early-backtest.ts';

export type EarlyReportSource = 'replay' | 'synthetic' | 'live';
export type EarlyReportCoverage = 'full' | 'partial';

/**
 * True once the live EARLY shadow settle path writes source=live daily reports
 * (see EarlyLiveShadowStore.settleAndPersist + RadarRescueService.runEodTruthAndRecall).
 */
export const LIVE_EARLY_DAILY_REPORT_WIRED = true as const;

export const LIVE_EARLY_DAILY_REPORT_MESSAGE = '實盤日報尚未接入';

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
    /** Unique per execution — full and partial runs never share a file. */
    run_id: string;
    /** full = session-end observation; partial = --until before close. */
    coverage: EarlyReportCoverage;
    /** True only for full session runs (default UI / rate display). */
    evaluable: boolean;
    observation_cutoff_ms: number;
    observation_cutoff_iso: string;
    /** HH:mm when cut from --until; null for full session. */
    until_label: string | null;
    /** Stock universe for this run. */
    symbols: string[];
    created_at: string;
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

export interface EarlyDailyReportListResult {
    date: string;
    sources: EarlyReportSource[];
    /** Default: full + evaluable only (partial excluded). */
    reports: EarlyDailyReport[];
    /** Partial / non-evaluable runs — clearly separate from default rates. */
    partial_reports: EarlyDailyReport[];
    live_pipeline: {
        wired: boolean;
        message: string | null;
    };
    note: string;
}

const RATE_INSUFFICIENT = '資料不足';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;

export function isValidTradeDate(date: string): boolean {
    if (typeof date !== 'string' || !DATE_RE.test(date)) return false;
    if (date.includes('..') || date.includes('/') || date.includes('\\')) {
        return false;
    }
    const y = Number(date.slice(0, 4));
    const m = Number(date.slice(5, 7));
    const d = Number(date.slice(8, 10));
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
        return false;
    }
    const dt = new Date(Date.UTC(y, m - 1, d));
    return (
        dt.getUTCFullYear() === y &&
        dt.getUTCMonth() === m - 1 &&
        dt.getUTCDate() === d
    );
}

export function isValidReportSource(
    source: string,
): source is EarlyReportSource {
    return source === 'replay' || source === 'synthetic' || source === 'live';
}

export function isValidRunId(runId: string): boolean {
    return typeof runId === 'string' && RUN_ID_RE.test(runId);
}

export function sanitizeRunId(runId: string): string {
    const cleaned = runId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
    if (!cleaned || !isValidRunId(cleaned)) {
        throw new Error(`invalid_run_id:${runId}`);
    }
    return cleaned;
}

/** Parse API date query; empty/undefined → Taipei today (always valid format). */
export function resolveTradeDateParam(
    raw: string | undefined,
): { ok: true; date: string } | { ok: false; error: string } {
    if (raw == null || raw === '') {
        const today = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Taipei',
        }).format(new Date());
        return { ok: true, date: today };
    }
    if (!isValidTradeDate(raw)) {
        return {
            ok: false,
            error: 'invalid_date',
        };
    }
    return { ok: true, date: raw };
}

/**
 * Route-facing date gate for EARLY daily-report.
 * Invalid values must become HTTP 400 — never used in filesystem paths.
 */
export function gateEarlyDailyReportDate(
    raw: string | undefined,
):
    | { ok: true; date: string }
    | {
          ok: false;
          httpStatus: 400;
          error: 'invalid_date';
          received: string | undefined;
          message: string;
      } {
    const dateRes = resolveTradeDateParam(raw);
    if (!dateRes.ok) {
        return {
            ok: false,
            httpStatus: 400,
            error: 'invalid_date',
            received: raw,
            message: 'date 僅接受有效 YYYY-MM-DD 交易日期',
        };
    }
    return { ok: true, date: dateRes.date };
}

export function formatRateLabel(
    rate: number | null,
    denominator: number,
): string {
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

export interface BuildEarlyDailyReportOpts {
    trade_date: string;
    source: EarlyReportSource;
    run_id: string;
    coverage: EarlyReportCoverage;
    observation_cutoff_ms: number;
    until_label?: string | null;
    symbols: string[];
    created_at?: string;
}

/**
 * Build a single-source daily report. Callers must pass outcomes from ONE source only.
 */
export function buildEarlyDailyReport(
    summary: EarlyBacktestSummary,
    opts: BuildEarlyDailyReportOpts,
): EarlyDailyReport {
    if (!isValidTradeDate(opts.trade_date)) {
        throw new Error(`invalid_trade_date:${opts.trade_date}`);
    }
    if (!isValidReportSource(opts.source)) {
        throw new Error(`invalid_source:${opts.source}`);
    }
    const run_id = sanitizeRunId(opts.run_id);
    const day3 = toBucketView(summary.day_plus_3pct);
    const resolved =
        summary.day_plus_3pct.success + summary.day_plus_3pct.fail;
    const completenessDenom = resolved + summary.day_plus_3pct.incomplete;
    const data_completeness_rate = summary.data_completeness_rate;
    const active = toBucketView(summary.active_upgrade);
    const evaluable = opts.coverage === 'full';
    const symbols = [...opts.symbols].map(String).sort();

    const partialNote =
        opts.coverage === 'partial'
            ? '【部分重播】觀測截止早於收盤，不可與完整日報混算成功率。'
            : '';

    return {
        trade_date: opts.trade_date,
        source: opts.source,
        source_label: EARLY_REPORT_SOURCE_LABEL[opts.source],
        run_id,
        coverage: opts.coverage,
        evaluable,
        observation_cutoff_ms: opts.observation_cutoff_ms,
        observation_cutoff_iso: new Date(
            opts.observation_cutoff_ms,
        ).toISOString(),
        until_label: opts.until_label ?? null,
        symbols,
        created_at: opts.created_at ?? new Date().toISOString(),
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
            partialNote +
            '成功率 = SUCCESS / (SUCCESS + FAIL)。INCOMPLETE／UNKNOWN 不進分母。' +
            'ACTIVE 為狀態升級率，不是交易勝率。' +
            '不同資料來源（歷史重播／模擬／實盤）必須分開查看，不可混算。' +
            '完整與部分重播分開存檔，不會互相覆蓋。',
    };
}

/**
 * Layout: early_daily_reports/{date}/{source}/{coverage}/{run_id}.json
 * Each run keeps its own file — full and partial never collide.
 */
export class EarlyDailyReportStore {
    constructor(private dataDir: string) {}

    private root(): string {
        return join(this.dataDir, 'early_daily_reports');
    }

    private reportPath(
        date: string,
        source: EarlyReportSource,
        coverage: EarlyReportCoverage,
        runId: string,
    ): string {
        if (!isValidTradeDate(date)) {
            throw new Error(`invalid_trade_date:${date}`);
        }
        if (!isValidReportSource(source)) {
            throw new Error(`invalid_source:${source}`);
        }
        if (coverage !== 'full' && coverage !== 'partial') {
            throw new Error(`invalid_coverage:${coverage}`);
        }
        const safeRun = sanitizeRunId(runId);
        return join(this.root(), date, source, coverage, `${safeRun}.json`);
    }

    save(report: EarlyDailyReport): string {
        if (!isValidTradeDate(report.trade_date)) {
            throw new Error(`invalid_trade_date:${report.trade_date}`);
        }
        if (!isValidReportSource(report.source)) {
            throw new Error(`invalid_source:${report.source}`);
        }
        const path = this.reportPath(
            report.trade_date,
            report.source,
            report.coverage,
            report.run_id,
        );
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
        return path;
    }

    loadByRun(
        date: string,
        source: EarlyReportSource,
        coverage: EarlyReportCoverage,
        runId: string,
    ): EarlyDailyReport | null {
        if (!isValidTradeDate(date) || !isValidReportSource(source)) {
            return null;
        }
        let path: string;
        try {
            path = this.reportPath(date, source, coverage, runId);
        } catch {
            return null;
        }
        if (!existsSync(path)) return null;
        try {
            return JSON.parse(readFileSync(path, 'utf8')) as EarlyDailyReport;
        } catch {
            return null;
        }
    }

    /** All runs for a date (optional filters). Never merges rates. */
    listRuns(
        date: string,
        opts?: {
            source?: EarlyReportSource;
            coverage?: EarlyReportCoverage;
            includeLive?: boolean;
        },
    ): EarlyDailyReport[] {
        if (!isValidTradeDate(date)) return [];
        const root = join(this.root(), date);
        if (!existsSync(root)) return [];

        const includeLive =
            opts?.includeLive === true || LIVE_EARLY_DAILY_REPORT_WIRED;
        const out: EarlyDailyReport[] = [];

        for (const srcName of readdirSync(root)) {
            if (!isValidReportSource(srcName)) continue;
            if (opts?.source && srcName !== opts.source) continue;
            if (srcName === 'live' && !includeLive) continue;

            for (const covName of readdirSync(join(root, srcName))) {
                if (covName !== 'full' && covName !== 'partial') continue;
                if (opts?.coverage && covName !== opts.coverage) continue;
                const covDir = join(root, srcName, covName);
                for (const file of readdirSync(covDir)) {
                    if (!file.endsWith('.json')) continue;
                    const runId = basename(file, '.json');
                    if (!isValidRunId(runId)) continue;
                    const report = this.loadByRun(
                        date,
                        srcName,
                        covName,
                        runId,
                    );
                    if (report) out.push(report);
                }
            }
        }

        out.sort((a, b) => {
            if (a.created_at !== b.created_at) {
                return a.created_at < b.created_at ? 1 : -1;
            }
            return a.run_id < b.run_id ? 1 : -1;
        });
        return out;
    }

    /**
     * Latest full evaluable report for source (default single-source fetch).
     * Returns null for live when pipeline is not wired (unless includeLive).
     */
    loadLatestFull(
        date: string,
        source: EarlyReportSource,
        opts?: { includeLive?: boolean },
    ): EarlyDailyReport | null {
        if (!isValidTradeDate(date) || !isValidReportSource(source)) {
            return null;
        }
        if (
            source === 'live' &&
            !LIVE_EARLY_DAILY_REPORT_WIRED &&
            opts?.includeLive !== true
        ) {
            return null;
        }
        const runs = this.listRuns(date, {
            source,
            coverage: 'full',
            includeLive: opts?.includeLive,
        }).filter((r) => r.evaluable);
        return runs[0] ?? null;
    }

    listSources(
        date: string,
        opts?: { includePartial?: boolean; includeLive?: boolean },
    ): EarlyReportSource[] {
        const runs = this.listRuns(date, {
            coverage: opts?.includePartial ? undefined : 'full',
            includeLive: opts?.includeLive,
        });
        const set = new Set<EarlyReportSource>();
        for (const r of runs) {
            if (!opts?.includePartial && (!r.evaluable || r.coverage !== 'full')) {
                continue;
            }
            set.add(r.source);
        }
        return [...set].sort();
    }

    /** Default list payload for API / 績效頁. */
    listForApi(
        date: string,
        opts?: { includePartial?: boolean },
    ): EarlyDailyReportListResult {
        const includePartial = opts?.includePartial === true;
        const all = this.listRuns(date, {
            includeLive: LIVE_EARLY_DAILY_REPORT_WIRED,
        });
        const reports = all.filter(
            (r) => r.coverage === 'full' && r.evaluable,
        );
        const partial_reports = all.filter(
            (r) => r.coverage === 'partial' || !r.evaluable,
        );
        const sources = [
            ...new Set(reports.map((r) => r.source)),
        ] as EarlyReportSource[];

        return {
            date,
            sources: sources.sort(),
            reports: includePartial ? [...reports, ...partial_reports] : reports,
            partial_reports,
            live_pipeline: {
                wired: LIVE_EARLY_DAILY_REPORT_WIRED,
                message: LIVE_EARLY_DAILY_REPORT_WIRED
                    ? null
                    : LIVE_EARLY_DAILY_REPORT_MESSAGE,
            },
            note:
                '預設只列出完整且可評估的日報。部分重播見 partial_reports，不可與完整成功率混算。' +
                (LIVE_EARLY_DAILY_REPORT_WIRED
                    ? ' 實盤來源僅在當日有寫入的 live 日報時出現，與重播／模擬分開統計。'
                    : ` ${LIVE_EARLY_DAILY_REPORT_MESSAGE}，不顯示實盤成功率。`),
        };
    }

    /** @deprecated Prefer listForApi / loadLatestFull — kept for callers expecting one-per-source. */
    load(date: string, source: EarlyReportSource): EarlyDailyReport | null {
        return this.loadLatestFull(date, source);
    }

    loadAllForDate(date: string): EarlyDailyReport[] {
        return this.listForApi(date).reports;
    }
}
