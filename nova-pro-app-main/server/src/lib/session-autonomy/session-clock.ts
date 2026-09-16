// server/src/lib/session-autonomy/session-clock.ts
// Taipei wall-clock → TradingSessionState. Inject nowMs for headless tests.

import type { TradingSessionState } from './types.ts';

export interface SessionClockParts {
    ymd: string;
    hm: number;
    weekday: number; // 0=Sun … 6=Sat
}

export function taipeiParts(nowMs: number): SessionClockParts {
    const d = new Date(nowMs);
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        weekday: 'short',
    });
    const parts = fmt.formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
    const m = parts.find((p) => p.type === 'month')?.value ?? '01';
    const day = parts.find((p) => p.type === 'day')?.value ?? '01';
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const map: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
    };
    return {
        ymd: `${y}-${m}-${day}`,
        hm: hour * 60 + minute,
        weekday: map[wd] ?? -1,
    };
}

/** Resolve session from Taipei time. Pure — no UI. */
export function resolveTradingSession(nowMs: number): TradingSessionState {
    const { hm, weekday } = taipeiParts(nowMs);
    if (weekday === 0 || weekday === 6) return 'WEEKEND';
    // 08:30–09:00 pre-open auction
    if (hm >= 8 * 60 + 30 && hm < 9 * 60) return 'PREOPEN';
    // 13:25–13:30 close auction (still cash session family)
    if (hm >= 13 * 60 + 25 && hm < 13 * 60 + 30) return 'CLOSE_AUCTION';
    // 09:00–13:25 cash continuous
    if (hm >= 9 * 60 && hm < 13 * 60 + 25) return 'CASH_LIVE';
    // else night / after hours
    return 'NIGHT_LIVE';
}

/** Build a Taipei-local instant for tests (approx via Intl offset sample). */
export function taipeiMs(
    y: number,
    mo: number,
    d: number,
    h: number,
    mi: number,
): number {
    // Interpret as Taipei wall time via Date with fixed +08:00
    const pad = (n: number) => String(n).padStart(2, '0');
    return Date.parse(
        `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00+08:00`,
    );
}
