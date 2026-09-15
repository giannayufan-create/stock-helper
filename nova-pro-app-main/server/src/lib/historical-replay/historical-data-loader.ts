// server/src/lib/historical-replay/historical-data-loader.ts
// Loads 1m OHLCV(+Amount). Gaps classified as NO_TRADE vs DATA_MISSING.

import type { MarketManager } from '../../providers/manager.ts';
import type { KBars } from '../../types/dto.ts';
import {
    DEFAULT_BAR_TIMESTAMP_SEMANTICS,
    resolveBarTimeWindow,
    type BarTimestampSemantics,
} from './bar-time.ts';

export type GapKind = 'NO_TRADE' | 'DATA_MISSING';

export interface MinuteBar {
    symbol: string;
    /** Provider datetime label "YYYY-MM-DD HH:mm:ss" */
    datetime: string;
    /** @deprecated use bar_start — kept as alias of bar_start for older callers */
    timestamp: number;
    bar_start: number;
    bar_end: number;
    known_at: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    amount: number;
    amount_available: boolean;
    /** Present only for synthetic fill bars. */
    gap_kind?: GapKind;
}

export interface GapRecord {
    symbol: string;
    session_minute: number;
    hhmm: string;
    kind: GapKind;
}

export interface DayBars {
    symbol: string;
    date: string;
    bars: MinuteBar[];
    amount_available: boolean;
    /** True DATA_MISSING only (not no-trade). */
    data_missing_count: number;
    data_missing_ranges: string[];
    no_trade_count: number;
    no_trade_ranges: string[];
    /** @deprecated alias of data_missing_count for older report fields */
    missing_bar_count: number;
    missing_bar_ranges: string[];
    gaps: GapRecord[];
}

export interface IndexDayBars extends DayBars {
    prev_close: number | null;
}

export interface KBarFetcher {
    kbars(
        key: {
            code: string;
            security_type: 'STK' | 'IND' | 'FUT' | 'OPT';
            exchange: string | null;
        },
        start: string,
        end: string,
    ): Promise<KBars>;
}

const SESSION_START_MIN = 9 * 60;
const SESSION_END_MIN = 13 * 60 + 30;

/** Continuous DATA_MISSING above this → quality pressure. */
const DATA_MISSING_STREAK_SOFT = 15;

export function parseBarTs(dt: string): number {
    const iso = dt.includes('T')
        ? dt
        : dt.replace(' ', 'T') + '+08:00';
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : Date.parse(dt);
}

function sessionMinuteFromLabel(dt: string): number | null {
    const m = dt.match(/(\d{2}):(\d{2})/);
    if (!m) return null;
    const mins = Number(m[1]) * 60 + Number(m[2]);
    if (mins < SESSION_START_MIN || mins > SESSION_END_MIN) return null;
    return mins - SESSION_START_MIN;
}

function expectedSessionMins(): number[] {
    const out: number[] = [];
    for (let m = 0; m <= SESSION_END_MIN - SESSION_START_MIN; m++) out.push(m);
    return out;
}

function hhmm(sessionMin: number): string {
    const total = SESSION_START_MIN + sessionMin;
    const hh = String(Math.floor(total / 60)).padStart(2, '0');
    const mm = String(total % 60).padStart(2, '0');
    return `${hh}:${mm}`;
}

function collapseRanges(mins: number[]): string[] {
    if (!mins.length) return [];
    const sorted = [...mins].sort((a, b) => a - b);
    const ranges: string[] = [];
    let start = sorted[0]!;
    let prev = sorted[0]!;
    for (let i = 1; i < sorted.length; i++) {
        const cur = sorted[i]!;
        if (cur === prev + 1) {
            prev = cur;
            continue;
        }
        ranges.push(
            start === prev ? hhmm(start) : `${hhmm(start)}-${hhmm(prev)}`,
        );
        start = cur;
        prev = cur;
    }
    ranges.push(start === prev ? hhmm(start) : `${hhmm(start)}-${hhmm(prev)}`);
    return ranges;
}

function maxStreak(mins: number[]): number {
    if (!mins.length) return 0;
    const sorted = [...mins].sort((a, b) => a - b);
    let max = 1;
    let cur = 1;
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === sorted[i - 1]! + 1) {
            cur += 1;
            max = Math.max(max, cur);
        } else cur = 1;
    }
    return max;
}

function kbarsToMinuteBars(
    symbol: string,
    date: string,
    kbars: KBars,
    semantics: BarTimestampSemantics,
): { bars: MinuteBar[]; amount_available: boolean } {
    const bars: MinuteBar[] = [];
    let anyAmount = false;
    let allAmount = true;
    for (let i = 0; i < kbars.datetime.length; i++) {
        const dt = kbars.datetime[i];
        if (!dt || !dt.startsWith(date)) continue;
        if (sessionMinuteFromLabel(dt) == null) continue;
        const amount = Number(kbars.Amount[i]) || 0;
        const vol = Number(kbars.Volume[i]) || 0;
        const hasAmountField =
            Array.isArray(kbars.Amount) && kbars.Amount.length > i;
        const avail = hasAmountField && amount > 0;
        if (avail) anyAmount = true;
        else if (vol > 0) allAmount = false;

        const labelTs = parseBarTs(dt);
        const win = resolveBarTimeWindow(labelTs, semantics);
        bars.push({
            symbol,
            datetime: dt,
            timestamp: win.bar_start,
            bar_start: win.bar_start,
            bar_end: win.bar_end,
            known_at: win.known_at,
            open: Number(kbars.Open[i]) || 0,
            high: Number(kbars.High[i]) || 0,
            low: Number(kbars.Low[i]) || 0,
            close: Number(kbars.Close[i]) || 0,
            volume: vol,
            amount,
            amount_available: avail,
        });
    }
    bars.sort((a, b) => a.known_at - b.known_at || a.symbol.localeCompare(b.symbol));
    return {
        bars,
        amount_available: anyAmount && allAmount,
    };
}

/**
 * Classify absent minutes:
 * - Symbol has ≥1 real bar that day → absent minutes = NO_TRADE (source omits empty minutes)
 * - Symbol has 0 bars → entire session DATA_MISSING
 * - Long streak of absent after sparse coverage may upgrade to DATA_MISSING when
 *   max streak ≥ DATA_MISSING_STREAK_SOFT and coverage < 50%
 */
function classifyAndFillGaps(
    symbol: string,
    date: string,
    rawBars: MinuteBar[],
    amount_available: boolean,
): DayBars {
    const bySm = new Map<number, MinuteBar>();
    for (const b of rawBars) {
        const sm = sessionMinuteFromLabel(b.datetime);
        if (sm != null) bySm.set(sm, b);
    }

    const gaps: GapRecord[] = [];
    const noTrade: number[] = [];
    const dataMissing: number[] = [];

    if (rawBars.length === 0) {
        for (const sm of expectedSessionMins()) {
            dataMissing.push(sm);
            gaps.push({
                symbol,
                session_minute: sm,
                hhmm: hhmm(sm),
                kind: 'DATA_MISSING',
            });
        }
        return {
            symbol,
            date,
            bars: [],
            amount_available,
            data_missing_count: dataMissing.length,
            data_missing_ranges: collapseRanges(dataMissing),
            no_trade_count: 0,
            no_trade_ranges: [],
            missing_bar_count: dataMissing.length,
            missing_bar_ranges: collapseRanges(dataMissing),
            gaps,
        };
    }

    const coverage =
        bySm.size / (SESSION_END_MIN - SESSION_START_MIN + 1);
    const absent: number[] = [];
    for (const sm of expectedSessionMins()) {
        if (!bySm.has(sm)) absent.push(sm);
    }
    const streak = maxStreak(absent);
    const treatAbsentAsMissing =
        coverage < 0.5 && streak >= DATA_MISSING_STREAK_SOFT;

    // Build filled series with NO_TRADE carry-forward
    const filled: MinuteBar[] = [];
    let last: MinuteBar | null = null;
    for (const sm of expectedSessionMins()) {
        const existing = bySm.get(sm);
        if (existing) {
            filled.push(existing);
            last = existing;
            continue;
        }
        const kind: GapKind = treatAbsentAsMissing
            ? 'DATA_MISSING'
            : 'NO_TRADE';
        gaps.push({
            symbol,
            session_minute: sm,
            hhmm: hhmm(sm),
            kind,
        });
        if (kind === 'NO_TRADE') noTrade.push(sm);
        else dataMissing.push(sm);

        if (!last) continue; // before first trade — skip synthetic until open
        const total = SESSION_START_MIN + sm;
        const hh = String(Math.floor(total / 60)).padStart(2, '0');
        const mm = String(total % 60).padStart(2, '0');
        const datetime = `${date} ${hh}:${mm}:00`;
        const labelTs = parseBarTs(datetime);
        const win = resolveBarTimeWindow(
            labelTs,
            DEFAULT_BAR_TIMESTAMP_SEMANTICS,
        );
        const px = last.close;
        filled.push({
            symbol,
            datetime,
            timestamp: win.bar_start,
            bar_start: win.bar_start,
            bar_end: win.bar_end,
            known_at: win.known_at,
            open: px,
            high: px,
            low: px,
            close: px,
            volume: 0,
            amount: 0,
            amount_available: amount_available,
            gap_kind: kind,
        });
    }

    return {
        symbol,
        date,
        bars: filled.length ? filled : rawBars,
        amount_available,
        data_missing_count: dataMissing.length,
        data_missing_ranges: collapseRanges(dataMissing),
        no_trade_count: noTrade.length,
        no_trade_ranges: collapseRanges(noTrade),
        missing_bar_count: dataMissing.length,
        missing_bar_ranges: collapseRanges(dataMissing),
        gaps,
    };
}

export class HistoricalDataLoader {
    constructor(
        private fetcher: KBarFetcher | MarketManager,
        private semantics: BarTimestampSemantics = DEFAULT_BAR_TIMESTAMP_SEMANTICS,
    ) {}

    async loadStockDay(date: string, symbol: string): Promise<DayBars> {
        const kbars = await this.fetcher.kbars(
            {
                code: symbol,
                security_type: 'STK',
                exchange: null,
            },
            date,
            date,
        );
        const { bars, amount_available } = kbarsToMinuteBars(
            symbol,
            date,
            kbars,
            this.semantics,
        );
        return classifyAndFillGaps(symbol, date, bars, amount_available);
    }

    async loadStocks(
        date: string,
        symbols: string[],
    ): Promise<Map<string, DayBars>> {
        const out = new Map<string, DayBars>();
        for (const s of symbols) {
            out.set(s, await this.loadStockDay(date, s));
        }
        return out;
    }

    async loadIndexDay(
        date: string,
        symbol: string,
    ): Promise<IndexDayBars | null> {
        try {
            const kbars = await this.fetcher.kbars(
                {
                    code: symbol,
                    security_type: 'IND',
                    exchange: null,
                },
                date,
                date,
            );
            const { bars, amount_available } = kbarsToMinuteBars(
                symbol,
                date,
                kbars,
                this.semantics,
            );
            if (!bars.length) return null;
            const day = classifyAndFillGaps(
                symbol,
                date,
                bars,
                amount_available,
            );
            const first = day.bars[0] ?? bars[0]!;
            return {
                ...day,
                prev_close: first.open > 0 ? first.open : null,
            };
        } catch {
            return null;
        }
    }
}

export function buildSyntheticDayBars(opts: {
    symbol: string;
    date: string;
    startPrice: number;
    skipMinutes?: number[];
    mutateAfter?: (sessionMin: number, close: number) => number;
    volumePerBar?: number;
    withAmount?: boolean;
    /** Minutes treated as NO_TRADE (volume=0 carry). */
    noTradeMinutes?: number[];
}): DayBars {
    const skip = new Set(opts.skipMinutes ?? []);
    const noTrade = new Set(opts.noTradeMinutes ?? []);
    const bars: MinuteBar[] = [];
    let px = opts.startPrice;
    const vol = opts.volumePerBar ?? 1000;
    for (let sm = 0; sm <= SESSION_END_MIN - SESSION_START_MIN; sm++) {
        if (skip.has(sm)) continue;
        if (noTrade.has(sm)) continue; // omit → classify as NO_TRADE fill
        const drift = ((sm % 7) - 3) * 0.05;
        const open = px;
        let close = Math.round((px + drift) * 100) / 100;
        if (opts.mutateAfter) close = opts.mutateAfter(sm, close);
        const high = Math.max(open, close) + 0.1;
        const low = Math.min(open, close) - 0.1;
        const total = SESSION_START_MIN + sm;
        const hh = String(Math.floor(total / 60)).padStart(2, '0');
        const mm = String(total % 60).padStart(2, '0');
        const datetime = `${opts.date} ${hh}:${mm}:00`;
        const labelTs = parseBarTs(datetime);
        const win = resolveBarTimeWindow(
            labelTs,
            DEFAULT_BAR_TIMESTAMP_SEMANTICS,
        );
        const barVol = vol;
        const amount = opts.withAmount === false ? 0 : close * barVol;
        bars.push({
            symbol: opts.symbol,
            datetime,
            timestamp: win.bar_start,
            bar_start: win.bar_start,
            bar_end: win.bar_end,
            known_at: win.known_at,
            open,
            high,
            low,
            close,
            volume: barVol,
            amount,
            amount_available: opts.withAmount !== false,
        });
        px = close;
    }
    return classifyAndFillGaps(
        opts.symbol,
        opts.date,
        bars,
        opts.withAmount !== false,
    );
}

export {
    SESSION_START_MIN,
    SESSION_END_MIN,
    sessionMinuteFromLabel as sessionMinute,
};
