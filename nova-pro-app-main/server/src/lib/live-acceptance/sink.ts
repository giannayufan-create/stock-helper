// Session window + JSONL sink for market-day sampling.

import { appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SessionWindow } from './types.ts';

const TAIPEI = 'Asia/Taipei';

export function taipeiHm(d: Date = new Date()): { h: number; m: number; ymd: string } {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TAIPEI,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(d);
    const get = (t: string) =>
        Number(parts.find((p) => p.type === t)?.value ?? 0);
    const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
    const mo = parts.find((p) => p.type === 'month')?.value ?? '01';
    const da = parts.find((p) => p.type === 'day')?.value ?? '01';
    return { h: get('hour'), m: get('minute'), ymd: `${y}-${mo}-${da}` };
}

export function sessionWindowAt(d: Date = new Date()): SessionWindow {
    const { h, m } = taipeiHm(d);
    const mins = h * 60 + m;
    if (mins >= 8 * 60 + 30 && mins < 9 * 60) return '08:30-09:00';
    if (mins >= 9 * 60 && mins < 9 * 60 + 10) return '09:00-09:10';
    if (mins >= 9 * 60 + 10 && mins < 9 * 60 + 30) return '09:10-09:30';
    if (mins >= 9 * 60 + 30 && mins < 11 * 60 + 30) return '09:30-11:30';
    if (mins >= 13 * 60 && mins < 13 * 60 + 30) return '13:00-13:30';
    return 'OTHER';
}

export class JsonlSink {
    constructor(private filePath: string) {
        mkdirSync(dirname(filePath), { recursive: true });
    }

    append(row: unknown): void {
        appendFileSync(this.filePath, `${JSON.stringify(row)}\n`, 'utf8');
    }

    writeJson(path: string, obj: unknown): void {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(obj, null, 2), 'utf8');
    }

    exists(): boolean {
        return existsSync(this.filePath);
    }

    path(): string {
        return this.filePath;
    }
}

export function liveAcceptanceDataDir(dataDir: string): string {
    return join(dataDir, 'live-acceptance');
}

/** Daily report artifacts: reports/live/ next to dataDir (e.g. server/reports/live). */
export function liveReportsDir(dataDir: string): string {
    return join(dataDir, '..', 'reports', 'live');
}
