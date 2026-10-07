// src/lib/preopen-live.ts — 盤前即時名單 client (read-only research)

import { apiGet } from './api';

export interface PreopenLiveItem {
    rank: number;
    code: string;
    name: string;
    trial_price: number;
    trial_pct: number | null;
    limit_up_price: number | null;
    at_limit: boolean;
    trial_volume: number;
    top10_minutes: number;
    locked: boolean | null;
    queue_lots: number | null;
    last_price: number | null;
}

export interface PreopenLiveDto {
    date: string;
    phase: 'before' | 'trial' | 'open' | 'after';
    ranked_at: string | null;
    source: string | null;
    queue_at: string | null;
    queue_source?: string | null;
    items: PreopenLiveItem[];
}

export function sourceLabel(source: string | null | undefined): string {
    return source === 'fugle' ? '富果' : source === 'shioaji' ? '永豐' : '';
}

export function fetchPreopenLive(timeoutMs = 15_000) {
    return apiGet<PreopenLiveDto>('/api/v1/research/preopen-live', timeoutMs);
}

const taipeiClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});

/** Weekdays 08:28–09:12 Taipei; the server decides trading days and phase. */
export function inPreopenUiWindow(d: Date = new Date()): boolean {
    const parts = taipeiClock.formatToParts(d);
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
    if (wd === 'Sat' || wd === 'Sun') return false;
    const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    const m = hh * 60 + mm;
    return m >= 8 * 60 + 28 && m < 9 * 60 + 12;
}
