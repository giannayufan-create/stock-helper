// Short in-process CPU profiles (node:inspector) taken during the session, so
// hotspots come from real load instead of guesses. Each capture writes the raw
// .cpuprofile plus a summary (self time by function and by file).

import { Session } from 'node:inspector/promises';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTradingDay } from './market-calendar/trading-day.ts';
import { sessionMinuteTaipei, taipeiYmd } from './shadow/session.ts';

export const CPU_PROFILE_DIR = 'cpu-profiles';
/** Session minutes (relative to 09:00) for the automatic captures. */
export const AUTO_CAPTURE_MINUTES = [15, 90];
const SAMPLING_INTERVAL_US = 2_000;
const MAX_SECONDS = 30;

interface ProfileNode {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    hitCount?: number;
}

interface Profile {
    nodes: ProfileNode[];
    startTime: number;
    endTime: number;
    samples?: number[];
}

export interface CpuProfileSummary {
    name: string;
    started_at: string;
    seconds: number;
    samples: number;
    busy_pct: number;
    gc_pct: number;
    top_functions: Array<{ fn: string; file: string; line: number; self_ms: number; pct: number }>;
    top_files: Array<{ file: string; self_ms: number; pct: number }>;
}

let running = false;

const shortFile = (url: string) => {
    if (!url) return '(native)';
    const i = url.indexOf('/src/');
    if (i >= 0) return url.slice(i + 1);
    const nm = url.lastIndexOf('node_modules/');
    if (nm >= 0) return url.slice(nm);
    return url.replace(/^file:\/\//, '');
};

export function summarizeProfile(name: string, startedAt: Date, p: Profile): CpuProfileSummary {
    const totalMs = Math.max(1, (p.endTime - p.startTime) / 1000);
    const hits = p.nodes.reduce((a, n) => a + (n.hitCount ?? 0), 0) || 1;
    const msPerHit = totalMs / hits;
    const byFn = new Map<string, { fn: string; file: string; line: number; hits: number }>();
    const byFile = new Map<string, number>();
    let idle = 0;
    let gc = 0;
    for (const n of p.nodes) {
        const h = n.hitCount ?? 0;
        if (!h) continue;
        const fn = n.callFrame.functionName || '(anonymous)';
        if (fn === '(idle)') {
            idle += h;
            continue;
        }
        if (fn === '(garbage collector)') gc += h;
        const file = shortFile(n.callFrame.url);
        const key = `${fn}|${file}|${n.callFrame.lineNumber}`;
        const cur = byFn.get(key) ?? { fn, file, line: n.callFrame.lineNumber + 1, hits: 0 };
        cur.hits += h;
        byFn.set(key, cur);
        byFile.set(file, (byFile.get(file) ?? 0) + h);
    }
    const pct = (h: number) => Math.round((h / hits) * 1000) / 10;
    const ms = (h: number) => Math.round(h * msPerHit);
    return {
        name,
        started_at: startedAt.toISOString(),
        seconds: Math.round(totalMs / 100) / 10,
        samples: hits,
        busy_pct: pct(hits - idle),
        gc_pct: pct(gc),
        top_functions: [...byFn.values()]
            .sort((a, b) => b.hits - a.hits)
            .slice(0, 40)
            .map((f) => ({ fn: f.fn, file: f.file, line: f.line, self_ms: ms(f.hits), pct: pct(f.hits) })),
        top_files: [...byFile.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 25)
            .map(([file, h]) => ({ file, self_ms: ms(h), pct: pct(h) })),
    };
}

export async function captureCpuProfile(
    dataDir: string,
    seconds: number,
    label = 'manual',
): Promise<CpuProfileSummary | { error: 'busy' }> {
    if (running) return { error: 'busy' };
    running = true;
    const startedAt = new Date();
    const session = new Session();
    try {
        session.connect();
        await session.post('Profiler.enable');
        await session.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
        await session.post('Profiler.start');
        await new Promise((r) => setTimeout(r, Math.min(Math.max(seconds, 1), MAX_SECONDS) * 1000));
        const { profile } = (await session.post('Profiler.stop')) as { profile: Profile };
        const hm = startedAt.toLocaleTimeString('en-GB', { timeZone: 'Asia/Taipei', hour12: false }).slice(0, 5).replace(':', '');
        const name = `${taipeiYmd(startedAt)}-${hm}-${label}`;
        const dir = join(dataDir, CPU_PROFILE_DIR);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${name}.cpuprofile`), JSON.stringify(profile));
        const summary = summarizeProfile(name, startedAt, profile);
        writeFileSync(join(dir, `${name}.summary.json`), JSON.stringify(summary));
        return summary;
    } finally {
        try {
            await session.post('Profiler.disable');
        } catch {
            /* session already closed */
        }
        session.disconnect();
        running = false;
    }
}

export function listCpuProfiles(dataDir: string): CpuProfileSummary[] {
    const dir = join(dataDir, CPU_PROFILE_DIR);
    let names: string[] = [];
    try {
        names = readdirSync(dir).filter((n) => n.endsWith('.summary.json'));
    } catch {
        return [];
    }
    const out: CpuProfileSummary[] = [];
    for (const n of names.sort()) {
        try {
            out.push(JSON.parse(readFileSync(join(dir, n), 'utf8')));
        } catch {
            continue;
        }
    }
    return out;
}

/** One 30s capture at each AUTO_CAPTURE_MINUTES on trading days. */
export function startCpuProfileScheduler(dataDir: string): () => void {
    const done = new Set<string>();
    const timer = setInterval(() => {
        const now = new Date();
        const ymd = taipeiYmd(now);
        if (!isTradingDay(ymd)) return;
        const sm = sessionMinuteTaipei(now);
        for (const m of AUTO_CAPTURE_MINUTES) {
            const key = `${ymd}|${m}`;
            if (sm >= m && sm < m + 2 && !done.has(key)) {
                done.add(key);
                void captureCpuProfile(dataDir, MAX_SECONDS, 'auto').catch((err) =>
                    console.warn('cpu-profile failed:', err instanceof Error ? err.message : err),
                );
            }
        }
    }, 20_000);
    timer.unref();
    return () => clearInterval(timer);
}
