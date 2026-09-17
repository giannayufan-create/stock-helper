// Trading-day helpers (Taipei). Official holiday overrides preferred over weekends-only.

import type { ConfidenceLevel, TradingDayInfo } from './types.ts';

const TAIPEI = 'Asia/Taipei';

/** Known TWSE/TPEx closed dates (YYYY-MM-DD) + name. Extend via official calendar merge. */
const STATIC_HOLIDAYS: Record<string, string> = {
    // 2025–2026 core holidays (static fallback; official list overrides when present)
    '2025-01-01': '元旦',
    '2025-01-27': '春節休市',
    '2025-01-28': '春節休市',
    '2025-01-29': '春節休市',
    '2025-01-30': '春節休市',
    '2025-01-31': '春節休市',
    '2025-02-28': '和平紀念日',
    '2025-04-03': '兒童節補假',
    '2025-04-04': '清明連假',
    '2025-05-01': '勞動節',
    '2025-05-30': '端午節',
    '2025-10-06': '中秋節',
    '2025-10-10': '國慶日',
    '2026-01-01': '元旦',
    '2026-02-16': '春節休市',
    '2026-02-17': '春節休市',
    '2026-02-18': '春節休市',
    '2026-02-19': '春節休市',
    '2026-02-20': '春節休市',
    '2026-02-27': '和平紀念日補假',
    '2026-04-03': '兒童節',
    '2026-04-06': '清明連假',
    '2026-05-01': '勞動節',
    '2026-06-19': '端午節',
    '2026-09-25': '中秋節',
    '2026-10-09': '國慶日連假',
    '2026-10-12': '國慶日補假',
};

/** Official overrides merged at runtime (holiday closed OR make-up trading). */
export type HolidayOverrides = {
    closed: Map<string, string>;
    /** Extra trading days that fall on weekends (rare make-up sessions). */
    open: Set<string>;
    source: string;
    confidence: ConfidenceLevel;
};

export function taipeiYmd(d: Date = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: TAIPEI,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

export function parseYmd(ymd: string): { y: number; m: number; d: number } {
    const [ys, ms, ds] = ymd.split('-');
    return { y: Number(ys), m: Number(ms), d: Number(ds) };
}

/** Weekday in Taipei for YYYY-MM-DD (0=Sun … 6=Sat). */
export function weekdayTaipei(ymd: string): number {
    // Noon UTC+8 avoids DST edge (TW has none) and parse ambiguity
    const { y, m, d } = parseYmd(ymd);
    const utc = Date.UTC(y, m - 1, d, 4, 0, 0); // 12:00 Taipei
    const wd = new Intl.DateTimeFormat('en-US', {
        timeZone: TAIPEI,
        weekday: 'short',
    }).format(new Date(utc));
    const map: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
    };
    return map[wd] ?? new Date(utc).getUTCDay();
}

export function monthBounds(ymd: string): { from: string; to: string } {
    const { y, m } = parseYmd(ymd);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mm = String(m).padStart(2, '0');
    return {
        from: `${y}-${mm}-01`,
        to: `${y}-${mm}-${String(last).padStart(2, '0')}`,
    };
}

export function nextMonthBounds(ymd: string): { from: string; to: string } {
    const { y, m } = parseYmd(ymd);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return monthBounds(`${ny}-${String(nm).padStart(2, '0')}-01`);
}

export function addCalendarDays(ymd: string, delta: number): string {
    const { y, m, d } = parseYmd(ymd);
    const dt = new Date(Date.UTC(y, m - 1, d + delta));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

export function emptyOverrides(): HolidayOverrides {
    return {
        closed: new Map(Object.entries(STATIC_HOLIDAYS)),
        open: new Set(),
        source: 'static_holiday_table',
        confidence: 'MEDIUM',
    };
}

export function mergeOfficialHolidays(
    base: HolidayOverrides,
    closed: Array<{ date: string; name?: string }>,
    source: string,
): HolidayOverrides {
    const next = {
        closed: new Map(base.closed),
        open: new Set(base.open),
        source,
        confidence: 'HIGH' as ConfidenceLevel,
    };
    for (const h of closed) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(h.date)) {
            next.closed.set(h.date, h.name ?? '休市');
        }
    }
    return next;
}

export function isTradingDay(
    ymd: string,
    overrides: HolidayOverrides = emptyOverrides(),
): boolean {
    if (overrides.open.has(ymd)) return true;
    if (overrides.closed.has(ymd)) return false;
    const wd = weekdayTaipei(ymd);
    return wd !== 0 && wd !== 6;
}

export function tradingDayInfo(
    ymd: string,
    overrides: HolidayOverrides = emptyOverrides(),
): TradingDayInfo {
    const wd = weekdayTaipei(ymd);
    const is_weekend = wd === 0 || wd === 6;
    const holiday_name = overrides.closed.get(ymd) ?? null;
    const is_holiday = holiday_name != null && !overrides.open.has(ymd);
    const is_trading_day = isTradingDay(ymd, overrides);
    return {
        date: ymd,
        is_trading_day,
        is_weekend,
        is_holiday,
        holiday_name,
        source: overrides.source,
        confidence: overrides.confidence,
    };
}

/** Previous trading day strictly before ymd. */
export function prevTradingDay(
    ymd: string,
    overrides: HolidayOverrides = emptyOverrides(),
    maxLookback = 20,
): string {
    let cur = ymd;
    for (let i = 0; i < maxLookback; i++) {
        cur = addCalendarDays(cur, -1);
        if (isTradingDay(cur, overrides)) return cur;
    }
    return addCalendarDays(ymd, -1);
}

/** Next trading day strictly after ymd. */
export function nextTradingDay(
    ymd: string,
    overrides: HolidayOverrides = emptyOverrides(),
    maxLookahead = 20,
): string {
    let cur = ymd;
    for (let i = 0; i < maxLookahead; i++) {
        cur = addCalendarDays(cur, 1);
        if (isTradingDay(cur, overrides)) return cur;
    }
    return addCalendarDays(ymd, 1);
}

/** Count trading days from fromYmd (exclusive) to toYmd (inclusive). Negative if to < from. */
export function tradingDaysBetween(
    fromYmd: string,
    toYmd: string,
    overrides: HolidayOverrides = emptyOverrides(),
): number {
    if (fromYmd === toYmd) return 0;
    const forward = fromYmd < toYmd;
    let cur = fromYmd;
    let n = 0;
    const guard = 400;
    for (let i = 0; i < guard; i++) {
        cur = addCalendarDays(cur, forward ? 1 : -1);
        if (isTradingDay(cur, overrides)) n += forward ? 1 : -1;
        if (cur === toYmd) return n;
        if (forward && cur > toYmd) break;
        if (!forward && cur < toYmd) break;
    }
    return n;
}
