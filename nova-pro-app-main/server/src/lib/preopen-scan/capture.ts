// Pre-open market-wide rankings, recorded scan by scan, so the post-close
// analysis (server/py/preopen_limitup.py) can check which pre-open names
// actually went limit-up. Read-only research data; nothing here feeds A/B/C/BP/Rank.

import { appendFileSync, mkdirSync } from 'node:fs';
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

export function recordPreopenScan(
    type: ScannerType,
    source: PreopenScanSource,
    items: readonly ScannerItem[],
    ascending: boolean,
    d: Date = new Date(),
    dataDir = serverDataDir(),
): void {
    if (ascending || !items.length || !isPreopenCaptureWindow(d)) return;
    if (throttled(type, source, d)) return;
    const row = {
        t: d.toISOString(),
        type,
        source,
        items: items.map((it, i) => ({
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
        })),
    };
    try {
        const file = preopenScanFile(taipeiYmd(d), dataDir);
        mkdirSync(join(dataDir, PREOPEN_SCAN_DIR), { recursive: true });
        appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    } catch {
        // research capture must never break discovery
    }
}
