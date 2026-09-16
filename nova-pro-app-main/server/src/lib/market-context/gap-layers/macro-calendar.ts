// server/src/lib/market-context/gap-layers/macro-calendar.ts

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMeta } from '../freshness.ts';
import type {
    LayerEnvelope,
    MacroEventCalendarData,
    MacroEventRow,
    MacroPhase,
} from './types.ts';

function resolvePath(): string | null {
    const here = dirname(fileURLToPath(import.meta.url));
    const cands = [
        join(here, '../../../../config/macro_event_calendar.json'),
        join(process.cwd(), 'config/macro_event_calendar.json'),
        join(process.cwd(), 'server/config/macro_event_calendar.json'),
    ];
    for (const p of cands) if (existsSync(p)) return p;
    return null;
}

function phaseOf(scheduledAt: string, nowMs: number): MacroPhase {
    const t = Date.parse(scheduledAt);
    if (!Number.isFinite(t)) return 'UNKNOWN';
    const d = t - nowMs;
    if (d > 24 * 3600_000) return 'FAR';
    if (d > 3 * 3600_000) return 'T_MINUS_24H';
    if (d > 30 * 60_000) return 'T_MINUS_3H';
    if (d > 0) return 'T_MINUS_30M';
    if (d > -60 * 60_000) return 'EVENT_WINDOW';
    if (d > -24 * 3600_000) return 'POST_EVENT';
    return 'FAR';
}

export function evaluateMacroEventCalendar(
    fetchedAt: string,
    nowMs = Date.now(),
): LayerEnvelope<MacroEventCalendarData> {
    const path = resolvePath();
    let raw: Array<Record<string, unknown>> = [];
    if (path) {
        try {
            raw = JSON.parse(readFileSync(path, 'utf8')) as Array<
                Record<string, unknown>
            >;
        } catch {
            raw = [];
        }
    }

    const upcoming: MacroEventRow[] = raw
        .map((r) => {
            const scheduled_at = String(r.scheduled_at ?? '');
            return {
                event_id: String(r.event_id ?? ''),
                scheduled_at,
                country: String(r.country ?? ''),
                event_type: String(r.event_type ?? ''),
                importance: (r.importance as MacroEventRow['importance']) ?? 'MEDIUM',
                source: String(r.source ?? 'curated'),
                freshness: 'curated_schedule',
                phase: phaseOf(scheduled_at, nowMs),
            };
        })
        .filter((e) => e.event_id && e.scheduled_at)
        .sort(
            (a, b) =>
                Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at),
        );

    const near = upcoming.find((e) => e.phase !== 'FAR') ?? upcoming[0] ?? null;

    return {
        layer: 'MacroEventCalendar',
        completeness: upcoming.length > 0 ? 'PARTIAL' : 'UNAVAILABLE',
        available: upcoming.length > 0,
        proxy: false,
        note: 'Curated official-schedule skeleton — not live scrape. Update config/macro_event_calendar.json from Fed/BLS/CBC etc.',
        meta: buildMeta({
            source: 'curated_macro_event_calendar.json',
            source_type: 'macro_calendar',
            fetched_at: fetchedAt,
            available: upcoming.length > 0,
            realtime_level: 'EOD',
            confidence: 'MEDIUM',
            coverage_pct: upcoming.length > 0 ? 60 : 0,
        }),
        data: {
            upcoming: upcoming.slice(0, 20),
            active_phase: near?.phase ?? null,
            nearest: near,
        },
    };
}
