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

/** Max age for a trade print to enter a live observation bar. */
export const LIVE_TRADE_MAX_AGE_MS = 90_000;

export type LiveTradeRejectReason =
    | 'invalid'
    | 'stale'
    | 'duplicate'
    | 'missing_timestamp'
    | 'missing_source';

/** Confirmed trade/print — wall-clock poll time alone is not enough. */
export interface LiveTradeTick {
    price: number;
    /** Exchange/print timestamp. */
    trade_ts_ms: number;
    source: LivePriceFeedSource;
}

export type LiveSettlementStatus =
    | 'none'
    | 'pending'
    | 'settled'
    | 'waiting_session_end';

export interface LiveSettlementState {
    trade_date: string;
    status: LiveSettlementStatus;
    live_report_ready: boolean;
    last_attempt_at_ms: number | null;
    run_id: string | null;
    /** UI copy when report must not be treated as complete. */
    message: string | null;
}

/**
 * Only accept trades with timestamp + source that are fresh and not a replayed last_price.
 */
export function evaluateLiveTradeTick(
    tick: Partial<LiveTradeTick> | null | undefined,
    nowMs: number,
    lastAccepted: { trade_ts_ms: number; price: number } | null,
):
    | { ok: true; tick: LiveTradeTick }
    | { ok: false; reason: LiveTradeRejectReason } {
    if (!tick) return { ok: false, reason: 'invalid' };
    if (tick.trade_ts_ms == null || !(Number(tick.trade_ts_ms) > 0)) {
        return { ok: false, reason: 'missing_timestamp' };
    }
    if (!tick.source) return { ok: false, reason: 'missing_source' };
    if (!(typeof tick.price === 'number' && tick.price > 0)) {
        return { ok: false, reason: 'invalid' };
    }
    const trade_ts_ms = Number(tick.trade_ts_ms);
    if (trade_ts_ms > nowMs + 1_000) {
        return { ok: false, reason: 'invalid' };
    }
    if (nowMs - trade_ts_ms > LIVE_TRADE_MAX_AGE_MS) {
        return { ok: false, reason: 'stale' };
    }
    if (
        lastAccepted &&
        lastAccepted.price === tick.price &&
        trade_ts_ms <= lastAccepted.trade_ts_ms
    ) {
        return { ok: false, reason: 'duplicate' };
    }
    if (
        lastAccepted &&
        lastAccepted.trade_ts_ms === trade_ts_ms &&
        lastAccepted.price === tick.price
    ) {
        return { ok: false, reason: 'duplicate' };
    }
    return {
        ok: true,
        tick: {
            price: tick.price,
            trade_ts_ms,
            source: tick.source,
        },
    };
}

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
    /** Last accepted trade print timestamp for this signal's symbol stream. */
    last_trade_ts_ms: number;
    /** Last time we considered observation (accepted trade or gap mark). */
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
    /** Per-symbol last accepted trade — blocks duplicate last_price. */
    private lastTradeBySymbol = new Map<
        string,
        { trade_ts_ms: number; price: number }
    >();
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
                if (r?.signal_id) {
                    if (r.last_trade_ts_ms == null) {
                        r.last_trade_ts_ms =
                            r.last_sample_at_ms ?? r.triggered_at_ms;
                    }
                    this.byId.set(r.signal_id, r);
                    const prev = this.lastTradeBySymbol.get(r.symbol);
                    if (
                        !prev ||
                        r.last_trade_ts_ms > prev.trade_ts_ms
                    ) {
                        this.lastTradeBySymbol.set(r.symbol, {
                            trade_ts_ms: r.last_trade_ts_ms,
                            price: r.trigger_price,
                        });
                    }
                }
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
            last_trade_ts_ms: input.triggered_at_ms,
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
     * Accept only fresh, timestamped trades into 1m bars.
     * Stale quotes / duplicate last_price are rejected; silence → DATA_MISSING.
     */
    sampleTrade(
        symbol: string,
        tick: Partial<LiveTradeTick> | null | undefined,
        nowMs = this.now(),
    ): { accepted: boolean; reason?: LiveTradeRejectReason } {
        const last = this.lastTradeBySymbol.get(symbol) ?? null;
        const judged = evaluateLiveTradeTick(tick, nowMs, last);
        if (!judged.ok) {
            this.markSilentGaps(symbol, nowMs);
            return { accepted: false, reason: judged.reason };
        }
        const { price, trade_ts_ms, source } = judged.tick;
        const knownAt = sampleToBarKnownAt(trade_ts_ms);
        let dirty = false;

        for (const row of this.byId.values()) {
            if (row.symbol !== symbol || row.settled) continue;
            if (knownAt <= row.triggered_at_ms) continue;

            this.fillMissingBars(
                row,
                knownAt,
                /*placeholderPrice*/ price,
                nowMs,
            );

            const existing = row.bars.find((b) => b.t === knownAt);
            if (existing) {
                if (existing.gap_kind === 'DATA_MISSING') {
                    // Do not overwrite a missing slot with a late print for that minute.
                    continue;
                }
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

            row.last_trade_ts_ms = trade_ts_ms;
            row.last_sample_at_ms = nowMs;
            if (row.price_feed_source !== source) {
                row.price_feed_source =
                    row.price_feed_source === 'injected' ? source : 'mixed';
            }
            dirty = true;
            this.persistDate(row.trade_date);
        }

        this.lastTradeBySymbol.set(symbol, { trade_ts_ms, price });
        if (!dirty) {
            // No open tracks — still record dedupe cursor.
            return { accepted: true };
        }
        return { accepted: true };
    }

    /** @deprecated use sampleTrade — bare last_price without trade_ts is rejected. */
    samplePrice(
        symbol: string,
        price: number | null,
        nowMs = this.now(),
        feed: LivePriceFeedSource = 'injected',
        tradeTsMs?: number,
    ): { accepted: boolean; reason?: LiveTradeRejectReason } {
        if (tradeTsMs == null) {
            this.markSilentGaps(symbol, nowMs);
            return { accepted: false, reason: 'missing_timestamp' };
        }
        return this.sampleTrade(
            symbol,
            { price: price ?? undefined, trade_ts_ms: tradeTsMs, source: feed },
            nowMs,
        );
    }

    /** Fill DATA_MISSING for elapsed minutes with no accepted trade. */
    markSilentGaps(symbol: string | null, nowMs = this.now()): void {
        const knownAt = sampleToBarKnownAt(nowMs);
        for (const row of this.byId.values()) {
            if (symbol && row.symbol !== symbol) continue;
            if (row.settled) continue;
            if (nowMs - row.last_trade_ts_ms <= LIVE_TRADE_MAX_AGE_MS) continue;
            this.fillMissingBars(row, knownAt, row.trigger_price, nowMs);
            row.last_sample_at_ms = nowMs;
            this.persistDate(row.trade_date);
        }
    }

    private fillMissingBars(
        row: LiveEarlyShadowRecord,
        upToKnownAt: number,
        placeholderPrice: number,
        nowMs: number,
    ): void {
        if (!(row.last_trade_ts_ms > 0)) return;
        if (nowMs - row.last_trade_ts_ms <= LIVE_TRADE_MAX_AGE_MS) return;
        const gapStart = sampleToBarKnownAt(row.last_trade_ts_ms) + 60_000;
        for (let t = gapStart; t < upToKnownAt; t += 60_000) {
            if (t <= row.triggered_at_ms) continue;
            if (row.bars.some((b) => b.t === t)) continue;
            row.bars.push({
                t,
                open: placeholderPrice,
                high: placeholderPrice,
                low: placeholderPrice,
                close: placeholderPrice,
                gap_kind: 'DATA_MISSING',
            });
        }
        row.bars.sort((a, b) => a.t - b.t);
    }

    /**
     * Trade dates that still need post-close settlement (unsettled rows, session ended).
     */
    datesNeedingSettlement(nowMs = this.now()): string[] {
        const dates = new Set<string>();
        for (const row of this.byId.values()) {
            if (row.settled) continue;
            if (nowMs >= expectedSessionEndKnownAt(row.trade_date)) {
                dates.add(row.trade_date);
            }
        }
        return [...dates].sort();
    }

    private settleMetaPath(date: string): string {
        return join(this.dir(), `${date}.settle.json`);
    }

    writeSettlementState(state: LiveSettlementState): void {
        mkdirSync(this.dir(), { recursive: true });
        writeFileSync(
            this.settleMetaPath(state.trade_date),
            JSON.stringify(state, null, 2),
            'utf8',
        );
    }

    getSettlementStatus(
        tradeDate: string,
        nowMs = this.now(),
    ): LiveSettlementState {
        const path = this.settleMetaPath(tradeDate);
        let saved: LiveSettlementState | null = null;
        if (existsSync(path)) {
            try {
                saved = JSON.parse(
                    readFileSync(path, 'utf8'),
                ) as LiveSettlementState;
            } catch {
                saved = null;
            }
        }
        const rows = this.list(tradeDate);
        const anyUnsettled = rows.some((r) => !r.settled);
        const sessionEnded = nowMs >= expectedSessionEndKnownAt(tradeDate);
        const reportReady =
            saved?.live_report_ready === true ||
            rows.some((r) => r.settled && r.settlement_run_id);

        if (reportReady && !anyUnsettled) {
            return {
                trade_date: tradeDate,
                status: 'settled',
                live_report_ready: true,
                last_attempt_at_ms: saved?.last_attempt_at_ms ?? null,
                run_id: saved?.run_id ?? rows[0]?.settlement_run_id ?? null,
                message: null,
            };
        }
        if (rows.length === 0) {
            return {
                trade_date: tradeDate,
                status: 'none',
                live_report_ready: false,
                last_attempt_at_ms: saved?.last_attempt_at_ms ?? null,
                run_id: null,
                message: null,
            };
        }
        if (!sessionEnded) {
            return {
                trade_date: tradeDate,
                status: 'waiting_session_end',
                live_report_ready: false,
                last_attempt_at_ms: saved?.last_attempt_at_ms ?? null,
                run_id: null,
                message: null,
            };
        }
        return {
            trade_date: tradeDate,
            status: 'pending',
            live_report_ready: false,
            last_attempt_at_ms: saved?.last_attempt_at_ms ?? null,
            run_id: null,
            message: '當日實盤日報尚未結算完成',
        };
    }

    markSettlementAttempt(
        tradeDate: string,
        nowMs: number,
        result: { live_report_ready: boolean; run_id: string | null },
    ): LiveSettlementState {
        const state: LiveSettlementState = {
            trade_date: tradeDate,
            status: result.live_report_ready ? 'settled' : 'pending',
            live_report_ready: result.live_report_ready,
            last_attempt_at_ms: nowMs,
            run_id: result.run_id,
            message: result.live_report_ready
                ? null
                : '當日實盤日報尚未結算完成',
        };
        this.writeSettlementState(state);
        return state;
    }

    /**
     * Patch day reference (e.g. from EOD Yahoo) without creating a new signal.
     * Caller must only pass refs from the exact settlement trade date.
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
            this.markSettlementAttempt(opts.trade_date, nowMs, {
                live_report_ready: true,
                run_id,
            });
        } else if (rows.length > 0) {
            for (const row of rows) {
                row.settlement_run_id = null;
            }
            this.persistDate(opts.trade_date);
            this.markSettlementAttempt(opts.trade_date, nowMs, {
                live_report_ready: false,
                run_id: null,
            });
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
