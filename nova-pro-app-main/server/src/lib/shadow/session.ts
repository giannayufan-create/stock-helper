// Shared Taipei session helpers — one formatter per process.

import { isTradingDay } from '../market-calendar/trading-day.ts';

const TAIPEI = 'Asia/Taipei';

const clockFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TAIPEI,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
});

const ymdFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TAIPEI,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

/** Minutes since 09:00 Taipei (0 at open; negative before open). */
export function sessionMinuteTaipei(d: Date): number {
    const parts = clockFmt.formatToParts(d);
    const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return hh * 60 + mm - 9 * 60;
}

export function taipeiYmd(d: Date = new Date()): string {
    return ymdFmt.format(d);
}

/** Cash session 09:00–13:30 on TW trading days. */
export function isShadowCashSession(d: Date = new Date()): boolean {
    const ymd = taipeiYmd(d);
    if (!isTradingDay(ymd)) return false;
    const sm = sessionMinuteTaipei(d);
    return sm >= 0 && sm <= 4 * 60 + 30;
}
