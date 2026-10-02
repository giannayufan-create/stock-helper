// server/src/lib/live-acceptance/runtime-timeline.ts
// Streams a day's live-acceptance JSONL and folds runtime samples into per-minute
// buckets plus sampling gaps (process down / restarting / event loop frozen).

import { dateTimeFormat } from '../intl-cache.ts';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

export interface TimelineMinute {
    minute: string;
    samples: number;
    rss_mb_max: number | null;
    heap_mb_max: number | null;
    lag_ms_max: number | null;
    cpu_pct_max: number | null;
}

export interface TimelineGap {
    from: string;
    to: string;
    seconds: number;
}

export interface RuntimeTimeline {
    file_exists: boolean;
    samples: number;
    first_at: string | null;
    last_at: string | null;
    minutes: TimelineMinute[];
    gaps: TimelineGap[];
}

const TAIPEI_MINUTE = dateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});

function maxOf(a: number | null, b: unknown): number | null {
    const n = typeof b === 'number' && Number.isFinite(b) ? b : null;
    if (n == null) return a;
    return a == null ? n : Math.max(a, n);
}

export async function readRuntimeTimeline(
    file: string,
    opts: { gapSec?: number } = {},
): Promise<RuntimeTimeline> {
    const gapMs = (opts.gapSec ?? 60) * 1000;
    const out: RuntimeTimeline = {
        file_exists: existsSync(file),
        samples: 0,
        first_at: null,
        last_at: null,
        minutes: [],
        gaps: [],
    };
    if (!out.file_exists) return out;

    const byMinute = new Map<string, TimelineMinute>();
    let prevMs: number | null = null;
    let prevAt: string | null = null;
    const rl = createInterface({
        input: createReadStream(file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        if (!line.includes('"kind":"runtime"')) continue;
        let row: Record<string, unknown>;
        try {
            row = JSON.parse(line) as Record<string, unknown>;
        } catch {
            continue;
        }
        const at = typeof row.at === 'string' ? row.at : null;
        const ms = at ? Date.parse(at) : NaN;
        if (!at || !Number.isFinite(ms)) continue;
        out.samples += 1;
        out.first_at ??= at;
        out.last_at = at;
        if (prevMs != null && prevAt && ms - prevMs >= gapMs) {
            out.gaps.push({
                from: prevAt,
                to: at,
                seconds: Math.round((ms - prevMs) / 1000),
            });
        }
        prevMs = ms;
        prevAt = at;
        const key = TAIPEI_MINUTE.format(new Date(ms));
        const b = byMinute.get(key) ?? {
            minute: key,
            samples: 0,
            rss_mb_max: null,
            heap_mb_max: null,
            lag_ms_max: null,
            cpu_pct_max: null,
        };
        b.samples += 1;
        b.rss_mb_max = maxOf(b.rss_mb_max, row.rss_mb);
        b.heap_mb_max = maxOf(b.heap_mb_max, row.heap_mb);
        b.lag_ms_max = maxOf(b.lag_ms_max, row.event_loop_lag_ms);
        b.cpu_pct_max = maxOf(b.cpu_pct_max, row.cpu_pct_approx);
        byMinute.set(key, b);
    }
    out.minutes = [...byMinute.values()];
    return out;
}
