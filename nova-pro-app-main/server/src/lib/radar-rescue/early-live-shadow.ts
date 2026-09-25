// EARLY live shadow — read-only day-horizon tracking for live EARLY signals.
// Keeps 30s–5m observation in EarlySignalStore; this module tracks to session close.
// NEVER places orders. NEVER mutates A/B/C/BP. NEVER marks FAIL before session end.

import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    evaluatePriceTarget,
    expectedSessionEndKnownAt,
    isTrackingCompleteToClose,
    type EarlyBacktestOutcome,
    type EarlyBacktestSummary,
    type EarlyTrackingBar,
    type MetricBucket,
    type MetricVerdict,
    type TargetMetric,
} from './early-backtest.ts';
import {
    buildEarlyDailyReport,
    EarlyDailyReportStore,
    type EarlyDailyReport,
} from './early-daily-report.ts';

export type LivePriceFeedSource =
    | 'opengate_last'
    | 'c_last'
    | 'bp_last'
    | 'injected'
    | 'eod_daily'
    | 'mixed';

export type DayReferenceSource =
    | 'opengate_prev_close'
    | 'eod_yahoo'
    | 'injected'
    | 'none';

export interface LiveEarlyShadowRecord {
    signal_id: string;
    symbol: string;
    name: string;
    trade_date: string;
    source: 'live';
    triggered_at_ms: number;
    trigger_price: number;
    change_pct_at_trigger: number | null;
    state_at_trigger: string;
    trigger_score: number;
    day_reference_price: number | null;
    day_reference_source: DayReferenceSource;
    /** 1m bars accumulated from live samples (known_at = bar end). */
    bars: EarlyTrackingBar[];
    active_at_ms: number | null;
    terminal_state: string;
    price_feed_source: LivePriceFeedSource;
    /** Last sample wall clock — restart must not invent bars in the gap. */
    last_sample_at_ms: number;
    settled: boolean;
    settlement_run_id: string | null;
}

export interface LiveEarlySettleResult {
    trade_date: string;
    summary: EarlyBacktestSummary;
    report: EarlyDailyReport | null;
    report_path: string | null;
    /** True when a readable live report was written. */
    live_report_written: boolean;
    retried: boolean;
}

function taipeiYmdFromMs(ms: number): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(ms));
}

function emptyTarget(verdict: MetricVerdict): TargetMetric {
    return {
        verdict,
        first_hit_bar_known_at_ms: null,
        first_hit_after_min: null,
        time_precision: 'none',
    };
}

function rate(success: number, fail: number): number | null {
    const d = success + fail;
    return d > 0 ? Math.round((success / d) * 1000) / 1000 : null;
}

function bucket(outcomes: TargetMetric[]): MetricBucket {
    let success = 0;
    let fail = 0;
    let incomplete = 0;
    let unknown = 0;
    for (const o of outcomes) {
        if (o.verdict === 'SUCCESS') success += 1;
        else if (o.verdict === 'FAIL') fail += 1;
        else if (o.verdict === 'INCOMPLETE') incomplete += 1;
        else unknown += 1;
    }
    return { success, fail, incomplete, unknown, rate: rate(success, fail) };
}

/** Snap sample time to 1m bar known_at (bar_end = start+60s). */
export function sampleToBarKnownAt(sampleMs: number): number {
    const barStart = Math.floor(sampleMs / 60_000) * 60_000;
    return barStart + 60_000;
}

function summarize(outcomes: EarlyBacktestOutcome[]): EarlyBacktestSummary {
    const day3 = bucket(outcomes.map((o) => o.day_plus_3pct));
    const scored = day3.success + day3.fail + day3.incomplete;
    return {
        signal_count: outcomes.length,
        unique_symbol_count: new Set(outcomes.map((o) => o.symbol)).size,
        day_plus_3pct: day3,
        day_plus_5pct: bucket(outcomes.map((o) => o.day_plus_5pct)),
        post_trigger_plus_3pct: bucket(
            outcomes.map((o) => o.post_trigger_plus_3pct),
        ),
        post_trigger_plus_5pct: bucket(
            outcomes.map((o) => o.post_trigger_plus_5pct),
        ),
        active_upgrade: bucket(outcomes.map((o) => o.active_upgrade)),
        data_completeness_rate:
            scored > 0
                ? Math.round(((day3.success + day3.fail) / scored) * 1000) / 1000
                : null,
        outcomes,
    };
}

/**
 * Live EARLY day-horizon shadow store.
 * One record per signal_id; state upgrades do not create a second count.
 */
export class EarlyLiveShadowStore {
    private byId = new Map<string, LiveEarlyShadowRecord>();
    private now: () => number;

    constructor(
        private dataDir: string,
        clock: () => number = () => Date.now(),
    ) {
        this.now = clock;
        this.hydrateToday();
    }

    private dir(): string {
        return join(this.dataDir, 'early_live_shadow');
    }

    private fileFor(date: string): string {
        return join(this.dir(), `${date}.json`);
    }

    private hydrateToday(): void {
        const date = taipeiYmdFromMs(this.now());
        this.loadDate(date);
    }

    loadDate(date: string): LiveEarlyShadowRecord[] {
        const path = this.fileFor(date);
        if (!existsSync(path)) return [];
        try {
            const rows = JSON.parse(
                readFileSync(path, 'utf8'),
            ) as LiveEarlyShadowRecord[];
            for (const r of rows) {
                if (r?.signal_id) this.byId.set(r.signal_id, r);
            }
            return rows;
        } catch {
            return [];
        }
    }

    private persistDate(date: string): void {
        mkdirSync(this.dir(), { recursive: true });
        const rows = [...this.byId.values()].filter(
            (r) => r.trade_date === date,
        );
        writeFileSync(this.fileFor(date), JSON.stringify(rows, null, 2), 'utf8');
    }

    list(date?: string): LiveEarlyShadowRecord[] {
        const d = date ?? taipeiYmdFromMs(this.now());
        return [...this.byId.values()].filter((r) => r.trade_date === d);
    }

    get(signalId: string): LiveEarlyShadowRecord | null {
        return this.byId.get(signalId) ?? null;
    }

    /**
     * Record first EARLY appearance. Same signal_id is idempotent (no double count).
     * Different triggers (new signal_id) for the same symbol are kept separately.
     */
    recordTrigger(input: {
        signal_id: string;
        symbol: string;
        name?: string;
        triggered_at_ms: number;
        trigger_price: number;
        change_pct_at_trigger?: number | null;
        state_at_trigger: string;
        trigger_score?: number;
        day_reference_price?: number | null;
        day_reference_source?: DayReferenceSource;
        price_feed_source?: LivePriceFeedSource;
        trade_date?: string;
    }): LiveEarlyShadowRecord {
        const existing = this.byId.get(input.signal_id);
        if (existing) return existing;

        const trade_date =
            input.trade_date ?? taipeiYmdFromMs(input.triggered_at_ms);
        const row: LiveEarlyShadowRecord = {
            signal_id: input.signal_id,
            symbol: input.symbol,
            name: input.name ?? input.symbol,
            trade_date,
            source: 'live',
            triggered_at_ms: input.triggered_at_ms,
            trigger_price: input.trigger_price,
            change_pct_at_trigger: input.change_pct_at_trigger ?? null,
            state_at_trigger: input.state_at_trigger,
            trigger_score: input.trigger_score ?? 0,
            day_reference_price:
                input.day_reference_price != null &&
                input.day_reference_price > 0
                    ? input.day_reference_price
                    : null,
            day_reference_source:
                input.day_reference_source ??
                (input.day_reference_price != null &&
                input.day_reference_price > 0
                    ? 'injected'
                    : 'none'),
            bars: [],
            active_at_ms: null,
            terminal_state: input.state_at_trigger,
            price_feed_source: input.price_feed_source ?? 'injected',
            last_sample_at_ms: input.triggered_at_ms,
            settled: false,
            settlement_run_id: null,
        };
        this.byId.set(row.signal_id, row);
        this.persistDate(trade_date);
        return row;
    }

    /** First ACTIVE / NEAR_LIMIT / LIMIT_UP only once per signal_id. */
    noteActive(signalId: string, nowMs = this.now()): void {
        const row = this.byId.get(signalId);
        if (!row || row.settled) return;
        if (row.active_at_ms != null) return;
        row.active_at_ms = nowMs;
        row.terminal_state = 'ACTIVE';
        this.persistDate(row.trade_date);
    }

    noteState(signalId: string, state: string): void {
        const row = this.byId.get(signalId);
        if (!row || row.settled) return;
        row.terminal_state = state;
        if (
            (state === 'ACTIVE' ||
                state === 'NEAR_LIMIT' ||
                state === 'LIMIT_UP') &&
            row.active_at_ms == null
        ) {
            row.active_at_ms = this.now();
        }
        this.persistDate(row.trade_date);
    }

    /**
     * Accumulate live price into 1m bars. Does not backfill minutes missed while down.
     */
    samplePrice(
        symbol: string,
        price: number | null,
        nowMs = this.now(),
        feed: LivePriceFeedSource = 'injected',
    ): void {
        if (price == null || !(price > 0)) return;
        const knownAt = sampleToBarKnownAt(nowMs);

        for (const row of this.byId.values()) {
            if (row.symbol !== symbol || row.settled) continue;
            if (knownAt <= row.triggered_at_ms) continue;

            // Mark gap after restart / silence as DATA_MISSING (→ INCOMPLETE, not FAIL).
            if (
                row.last_sample_at_ms > 0 &&
                nowMs - row.last_sample_at_ms > 90_000
            ) {
                const gapStart = sampleToBarKnownAt(row.last_sample_at_ms) + 60_000;
                for (let t = gapStart; t < knownAt; t += 60_000) {
                    if (t <= row.triggered_at_ms) continue;
                    if (row.bars.some((b) => b.t === t)) continue;
                    row.bars.push({
                        t,
                        open: price,
                        high: price,
                        low: price,
                        close: price,
                        gap_kind: 'DATA_MISSING',
                    });
                }
            }

            const existing = row.bars.find((b) => b.t === knownAt);
            if (existing) {
                if (existing.gap_kind === 'DATA_MISSING') continue;
                existing.high = Math.max(existing.high, price);
                existing.low = Math.min(existing.low, price);
                existing.close = price;
            } else {
                row.bars.push({
                    t: knownAt,
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    gap_kind: null,
                });
                row.bars.sort((a, b) => a.t - b.t);
            }

            row.last_sample_at_ms = nowMs;
            if (row.price_feed_source !== feed) {
                row.price_feed_source =
                    row.price_feed_source === 'injected' ? feed : 'mixed';
            }
            this.persistDate(row.trade_date);
        }
    }

    /**
     * Patch day reference (e.g. from EOD Yahoo) without creating a new signal.
     */
    patchDayReference(
        signalId: string,
        dayRef: number | null,
        source: DayReferenceSource,
    ): void {
        const row = this.byId.get(signalId);
        if (!row || row.settled) return;
        if (dayRef != null && dayRef > 0) {
            row.day_reference_price = dayRef;
            row.day_reference_source = source;
        } else {
            row.day_reference_price = null;
            row.day_reference_source = 'none';
        }
        this.persistDate(row.trade_date);
    }

    /**
     * Settle day metrics for a trade date.
     * - Before session end: unmet → INCOMPLETE (never FAIL).
     * - Missing day ref → day metrics UNKNOWN.
     * - Missing bars / DATA_MISSING gaps → INCOMPLETE (never FAIL).
     * - Retryable: already-settled rows keep outcomes; re-settle rebuilds summary without duplicating signal_ids.
     */
    settleDay(opts: {
        trade_date: string;
        nowMs?: number;
        /** Force session-ended (tests). Default: now >= expected session end. */
        sessionEnded?: boolean;
        eodFetchFailed?: boolean;
    }): EarlyBacktestSummary {
        const nowMs = opts.nowMs ?? this.now();
        const sessionEnd = expectedSessionEndKnownAt(opts.trade_date);
        const sessionEnded =
            opts.sessionEnded ?? nowMs >= sessionEnd;
        const rows = this.list(opts.trade_date);
        const outcomes: EarlyBacktestOutcome[] = [];

        for (const row of rows) {
            const futureBars = row.bars.filter(
                (b) => b.t > row.triggered_at_ms && b.t <= sessionEnd,
            );

            // EOD fetch failure or pre-close → cannot claim FAIL-to-close.
            const trackingToClose =
                sessionEnded &&
                !opts.eodFetchFailed &&
                isTrackingCompleteToClose(
                    row.triggered_at_ms,
                    futureBars,
                    sessionEnd,
                );

            const dayOk =
                row.day_reference_price != null &&
                row.day_reference_price > 0;
            const dayRef = row.day_reference_price;

            const day_plus_3pct = evaluatePriceTarget({
                threshold: dayOk ? dayRef! * 1.03 : null,
                triggerMs: row.triggered_at_ms,
                futureBars,
                trackingToClose,
                referenceAvailable: dayOk,
            });
            const day_plus_5pct = evaluatePriceTarget({
                threshold: dayOk ? dayRef! * 1.05 : null,
                triggerMs: row.triggered_at_ms,
                futureBars,
                trackingToClose,
                referenceAvailable: dayOk,
            });
            const post_trigger_plus_3pct = evaluatePriceTarget({
                threshold:
                    row.trigger_price > 0 ? row.trigger_price * 1.03 : null,
                triggerMs: row.triggered_at_ms,
                futureBars,
                trackingToClose,
                referenceAvailable: row.trigger_price > 0,
            });
            const post_trigger_plus_5pct = evaluatePriceTarget({
                threshold:
                    row.trigger_price > 0 ? row.trigger_price * 1.05 : null,
                triggerMs: row.triggered_at_ms,
                futureBars,
                trackingToClose,
                referenceAvailable: row.trigger_price > 0,
            });

            let active_upgrade: TargetMetric & { reached: boolean };
            if (row.active_at_ms != null && row.active_at_ms <= sessionEnd) {
                const afterMin = Math.floor(
                    (row.active_at_ms - row.triggered_at_ms) / 60_000,
                );
                active_upgrade = {
                    verdict: 'SUCCESS',
                    reached: true,
                    first_hit_bar_known_at_ms: row.active_at_ms,
                    first_hit_after_min: Math.max(0, afterMin),
                    time_precision: '1m_bar',
                };
            } else if (trackingToClose) {
                active_upgrade = { ...emptyTarget('FAIL'), reached: false };
            } else {
                active_upgrade = {
                    ...emptyTarget('INCOMPLETE'),
                    reached: false,
                };
            }

            let peak = row.trigger_price;
            for (const b of futureBars) {
                if (b.gap_kind === 'DATA_MISSING') continue;
                peak = Math.max(peak, b.high);
            }

            outcomes.push({
                signal_id: row.signal_id,
                symbol: row.symbol,
                triggered_at_ms: row.triggered_at_ms,
                trigger_price: row.trigger_price,
                change_pct_at_trigger: row.change_pct_at_trigger,
                state_at_trigger: row.state_at_trigger,
                trigger_score: row.trigger_score,
                day_reference_price: dayRef,
                day_plus_3pct,
                day_plus_5pct,
                post_trigger_plus_3pct,
                post_trigger_plus_5pct,
                active_upgrade,
                max_price: peak,
                max_return_vs_trigger_pct:
                    row.trigger_price > 0
                        ? Math.round(
                              ((peak - row.trigger_price) /
                                  row.trigger_price) *
                                  10000,
                          ) / 100
                        : null,
                max_return_vs_day_ref_pct: dayOk
                    ? Math.round(((peak - dayRef!) / dayRef!) * 10000) / 100
                    : null,
                tracking_to_close: trackingToClose,
                terminal_state: row.terminal_state,
            });
        }

        return summarize(outcomes);
    }

    /**
     * Settle and persist a live daily report (one run_id per date — retries overwrite, no double count).
     * Only writes when session has ended (or sessionEnded forced for tests).
     */
    settleAndPersist(opts: {
        trade_date: string;
        nowMs?: number;
        sessionEnded?: boolean;
        eodFetchFailed?: boolean;
        reportsDir?: string;
    }): LiveEarlySettleResult {
        const nowMs = opts.nowMs ?? this.now();
        const sessionEnd = expectedSessionEndKnownAt(opts.trade_date);
        const sessionEnded = opts.sessionEnded ?? nowMs >= sessionEnd;
        const rows = this.list(opts.trade_date);
        const retried = rows.some((r) => r.settled);

        const summary = this.settleDay({
            trade_date: opts.trade_date,
            nowMs,
            sessionEnded,
            eodFetchFailed: opts.eodFetchFailed,
        });

        // Annotate outcomes with live feed metadata via report note + tracking_to_close.
        const run_id = `live_${opts.trade_date}_eod`;
        let report: EarlyDailyReport | null = null;
        let report_path: string | null = null;
        let live_report_written = false;

        if (sessionEnded && rows.length > 0) {
            report = buildEarlyDailyReport(summary, {
                trade_date: opts.trade_date,
                source: 'live',
                run_id,
                coverage: 'full',
                observation_cutoff_ms: sessionEnd,
                until_label: null,
                symbols: [...new Set(rows.map((r) => r.symbol))].sort(),
                created_at: new Date(nowMs).toISOString(),
            });
            const feeds = [...new Set(rows.map((r) => r.price_feed_source))];
            const tracked = summary.outcomes.filter((o) => o.tracking_to_close)
                .length;
            const eodNote = opts.eodFetchFailed
                ? '盤後價格抓取失敗→未達標項為 INCOMPLETE。'
                : '';
            report.note =
                `實盤影子觀察。價格來源=${feeds.join(',')}` +
                `；追蹤到收盤=${tracked}/${summary.outcomes.length}。` +
                eodNote +
                report.note;

            const store = new EarlyDailyReportStore(
                opts.reportsDir ?? this.dataDir,
            );
            report_path = store.save(report);
            live_report_written = true;

            for (const row of rows) {
                row.settled = true;
                row.settlement_run_id = run_id;
            }
            this.persistDate(opts.trade_date);
        } else if (rows.length > 0) {
            for (const row of rows) {
                row.settlement_run_id = null;
            }
            this.persistDate(opts.trade_date);
        }

        return {
            trade_date: opts.trade_date,
            summary,
            report,
            report_path,
            live_report_written,
            retried,
        };
    }
}
