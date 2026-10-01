// server/src/lib/data-janitor.ts
// Retention for high-volume operational logs on the persistent data disk.
// Research records (signals, raw signals, outcomes, EARLY shadow/reports) are never touched.

import {
    readdirSync,
    rmSync,
    statSync,
    statfsSync,
    unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory under server/data → days of dated files to keep (today counts as day 1). */
export const LOG_RETENTION_DAYS: Readonly<Record<string, number>> = {
    'open-confirm-logs': 14,
    'intraday-rank-logs': 14,
    'open-gate-logs': 14,
    'market-intelligence': 14,
    'live-acceptance': 14,
    radar_funnel_trace: 2,
    // Re-fetchable bar cache (dated subfolders), not research records.
    strategy_validation_bars: 45,
};

const DATE_IN_NAME = /(\d{4}-\d{2}-\d{2})/;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function serverDataDir(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', 'data');
}

function taipeiYmd(ms: number): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(ms));
}

export interface SweepResult {
    deleted_files: number;
    freed_bytes: number;
    errors: number;
}

export function sweepOldLogs(
    dataDir: string,
    nowMs = Date.now(),
    retention: Readonly<Record<string, number>> = LOG_RETENTION_DAYS,
): SweepResult {
    const out: SweepResult = { deleted_files: 0, freed_bytes: 0, errors: 0 };
    for (const [sub, keepDays] of Object.entries(retention)) {
        const cutoff = taipeiYmd(nowMs - (keepDays - 1) * 86_400_000);
        const dir = join(dataDir, sub);
        let names: string[];
        try {
            names = readdirSync(dir);
        } catch {
            continue;
        }
        for (const name of names) {
            const day = DATE_IN_NAME.exec(name)?.[1];
            if (!day || day >= cutoff) continue;
            const file = join(dir, name);
            try {
                const st = statSync(file);
                if (st.isFile()) {
                    unlinkSync(file);
                    out.deleted_files++;
                    out.freed_bytes += st.size;
                } else if (st.isDirectory()) {
                    const size = dirSize(file);
                    rmSync(file, { recursive: true, force: true });
                    out.deleted_files++;
                    out.freed_bytes += size;
                }
            } catch {
                out.errors++;
            }
        }
    }
    return out;
}

export function startDataJanitor(dataDir: string): void {
    const run = () => {
        const r = sweepOldLogs(dataDir);
        if (r.deleted_files || r.errors) {
            console.log(
                `data-janitor: deleted=${r.deleted_files} freed_mb=${(r.freed_bytes / 1048576).toFixed(1)} errors=${r.errors}`,
            );
        }
    };
    run();
    setInterval(run, SWEEP_INTERVAL_MS).unref();
}

function dirSize(path: string): number {
    let total = 0;
    let entries: import('node:fs').Dirent[];
    try {
        entries = readdirSync(path, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const e of entries) {
        const p = join(path, e.name);
        try {
            if (e.isDirectory()) total += dirSize(p);
            else if (e.isFile()) total += statSync(p).size;
        } catch {
            /* vanished mid-walk */
        }
    }
    return total;
}

export interface DiskUsage {
    total_mb: number | null;
    free_mb: number | null;
    used_pct: number | null;
    data_mb: number;
    by_dir_mb: Record<string, number>;
    retention_days: Readonly<Record<string, number>>;
    measured_at: string;
}

const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;

export function measureDisk(dataDir: string): DiskUsage {
    const by: Record<string, number> = {};
    let data = 0;
    let entries: import('node:fs').Dirent[] = [];
    try {
        entries = readdirSync(dataDir, { withFileTypes: true });
    } catch {
        /* no data dir yet */
    }
    for (const e of entries) {
        const p = join(dataDir, e.name);
        let size = 0;
        try {
            size = e.isDirectory() ? dirSize(p) : statSync(p).size;
        } catch {
            continue;
        }
        data += size;
        by[e.name] = mb(size);
    }
    let total: number | null = null;
    let free: number | null = null;
    try {
        const fs = statfsSync(dataDir);
        total = fs.blocks * fs.bsize;
        free = fs.bavail * fs.bsize;
    } catch {
        /* statfs unsupported */
    }
    return {
        total_mb: total == null ? null : mb(total),
        free_mb: free == null ? null : mb(free),
        used_pct:
            total && free != null
                ? Math.round(((total - free) / total) * 1000) / 10
                : null,
        data_mb: mb(data),
        by_dir_mb: Object.fromEntries(
            Object.entries(by).sort((a, b) => b[1] - a[1]),
        ),
        retention_days: LOG_RETENTION_DAYS,
        measured_at: new Date().toISOString(),
    };
}
