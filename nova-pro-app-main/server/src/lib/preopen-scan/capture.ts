// Pre-open market-wide rankings, recorded scan by scan, so the post-close
// analysis (server/py/preopen_limitup.py) can check which pre-open names
// actually went limit-up. Read-only research data; nothing here feeds A/B/C/BP/Rank.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScannerItem, ScannerType } from '../../types/dto.ts';
import { isTradingDay } from '../market-calendar/trading-day.ts';
import { sessionMinuteTaipei, taipeiYmd } from '../shadow/session.ts';
import { serverDataDir } from '../data-janitor.ts';

export const PREOPEN_SCAN_DIR = 'preopen-scans';

export type PreopenScanSource = 'shioaji' | 'fugle' | 'overnight';

/** 08:30–09:00: trial matching; market-wide ranks must come from a live source. */
export function isPreopenRankWindow(d: Date = new Date()): boolean {
    if (!isTradingDay(taipeiYmd(d))) return false;
    const sm = sessionMinuteTaipei(d);
    return sm >= -30 && sm < 0;
}

/** 08:25–09:10: recorded window (a little either side of the trial session). */
export function isPreopenCaptureWindow(d: Date = new Date()): boolean {
    if (!isTradingDay(taipeiYmd(d))) return false;
    const sm = sessionMinuteTaipei(d);
    return sm >= -35 && sm < 10;
}

export function preopenScanFile(ymd: string, dataDir = serverDataDir()): string {
    return join(dataDir, PREOPEN_SCAN_DIR, `${ymd}.jsonl`);
}

/** Discovery polls every 15s; one row per type/source per minute is enough except right before 09:00. */
const MIN_GAP_MS = 55_000;
const lastRecordedAt = new Map<string, number>();

export function resetPreopenCaptureThrottle(): void {
    lastRecordedAt.clear();
}

function throttled(type: ScannerType, source: PreopenScanSource, d: Date): boolean {
    const sm = sessionMinuteTaipei(d);
    if (sm >= -3 && sm < 0) return false;
    const key = `${type}|${source}`;
    const prev = lastRecordedAt.get(key);
    if (prev !== undefined && d.getTime() - prev < MIN_GAP_MS && d.getTime() >= prev) return true;
    lastRecordedAt.set(key, d.getTime());
    return false;
}

export interface PreopenRankItem {
    rank: number;
    code: string;
    name: string;
    date: string;
    close: number;
    open: number;
    high: number;
    low: number;
    change_price: number;
    total_volume: number;
    total_amount: number;
    volume_ratio: number;
    buy_price: number;
    sell_price: number;
}

export interface PreopenLiveState {
    date: string;
    at: string;
    source: PreopenScanSource;
    items: PreopenRankItem[];
    /** Distinct pre-open minutes each code sat in the top 10. */
    top10_minutes: Record<string, number>;
}

let live: PreopenLiveState | null = null;
let liveTop10: Map<string, Set<number>> = new Map();

export function resetPreopenLiveState(): void {
    live = null;
    liveTop10 = new Map();
}

/** Latest live (non-overnight) pre-open change ranking for `ymd`, from memory or the day's file. */
export function preopenLiveState(ymd: string = taipeiYmd(), dataDir = serverDataDir()): PreopenLiveState | null {
    if (live?.date === ymd) return live;
    const restored = restoreFromFile(ymd, dataDir);
    if (restored) live = restored;
    return restored;
}

function restoreFromFile(ymd: string, dataDir: string): PreopenLiveState | null {
    let text: string;
    try {
        text = readFileSync(preopenScanFile(ymd, dataDir), 'utf8');
    } catch {
        return null;
    }
    let last: PreopenLiveState | null = null;
    const top10 = new Map<string, Set<number>>();
    for (const line of text.split('\n')) {
        if (!line.includes('"ChangePercentRank"')) continue;
        try {
            const row = JSON.parse(line) as {
                t: string;
                type: string;
                source: PreopenScanSource;
                role?: string;
                items: PreopenRankItem[];
            };
            const d = new Date(row.t);
            if (row.type !== 'ChangePercentRank' || row.source === 'overnight' || row.role === 'shadow') continue;
            if (sessionMinuteTaipei(d) >= 0) continue;
            noteTop10(top10, row.items, d);
            last = { date: ymd, at: row.t, source: row.source, items: row.items, top10_minutes: {} };
        } catch {
            continue;
        }
    }
    if (!last) return null;
    liveTop10 = top10;
    last.top10_minutes = top10Counts(top10);
    return last;
}

function noteTop10(map: Map<string, Set<number>>, items: readonly { code: string }[], d: Date): void {
    const minute = sessionMinuteTaipei(d);
    for (const it of items.slice(0, 10)) {
        let set = map.get(it.code);
        if (!set) map.set(it.code, (set = new Set()));
        set.add(minute);
    }
}

function top10Counts(map: Map<string, Set<number>>): Record<string, number> {
    return Object.fromEntries([...map].map(([code, set]) => [code, set.size]));
}

function toRankItems(items: readonly ScannerItem[]): PreopenRankItem[] {
    return items.map((it, i) => ({
        rank: i + 1,
        code: it.code,
        name: it.name,
        date: it.date,
        close: it.close,
        open: it.open,
        high: it.high,
        low: it.low,
        change_price: it.change_price,
        total_volume: it.total_volume,
        total_amount: it.total_amount,
        volume_ratio: it.volume_ratio,
        buy_price: it.buy_price,
        sell_price: it.sell_price,
    }));
}

export function appendPreopenRow(
    row: { t: string; type: string; source: string; role?: 'shadow'; items: unknown[] },
    dataDir = serverDataDir(),
): void {
    try {
        const file = preopenScanFile(taipeiYmd(new Date(row.t)), dataDir);
        mkdirSync(join(dataDir, PREOPEN_SCAN_DIR), { recursive: true });
        appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    } catch {
        // research capture must never break discovery
    }
}

export function recordPreopenScan(
    type: ScannerType,
    source: PreopenScanSource,
    items: readonly ScannerItem[],
    ascending: boolean,
    d: Date = new Date(),
    dataDir = serverDataDir(),
): void {
    if (ascending || !items.length || !isPreopenCaptureWindow(d)) return;
    const rows = toRankItems(items);
    if (type === 'ChangePercentRank' && source !== 'overnight' && sessionMinuteTaipei(d) < 0) {
        const ymd = taipeiYmd(d);
        if (live?.date !== ymd) liveTop10 = new Map();
        noteTop10(liveTop10, rows, d);
        live = { date: ymd, at: d.toISOString(), source, items: rows, top10_minutes: top10Counts(liveTop10) };
    }
    if (throttled(type, source, d)) return;
    appendPreopenRow({ t: d.toISOString(), type, source, items: rows }, dataDir);
}

/** Second source recorded for comparison only: never touches the live list. */
export function shadowScanDue(type: ScannerType, source: PreopenScanSource, d: Date = new Date()): boolean {
    if (!isPreopenCaptureWindow(d)) return false;
    const prev = lastRecordedAt.get(`shadow|${type}|${source}`);
    return prev === undefined || d.getTime() - prev >= MIN_GAP_MS || d.getTime() < prev;
}

export function recordShadowScan(
    type: ScannerType,
    source: PreopenScanSource,
    items: readonly ScannerItem[],
    d: Date = new Date(),
    dataDir = serverDataDir(),
): void {
    if (!items.length || !isPreopenCaptureWindow(d)) return;
    lastRecordedAt.set(`shadow|${type}|${source}`, d.getTime());
    appendPreopenRow({ t: d.toISOString(), type, source, role: 'shadow', items: toRankItems(items) }, dataDir);
}
