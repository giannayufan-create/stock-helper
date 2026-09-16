// server/src/lib/market-context/gap-layers/passive-flow.ts
// Marker only — NEVER feeds BuyPressure score.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMeta } from '../freshness.ts';
import type {
    LayerEnvelope,
    PassiveFlowData,
    PassiveFlowEvent,
} from './types.ts';

function resolvePath(): string | null {
    const here = dirname(fileURLToPath(import.meta.url));
    const cands = [
        join(here, '../../../../config/passive_flow_calendar.json'),
        join(process.cwd(), 'config/passive_flow_calendar.json'),
        join(process.cwd(), 'server/config/passive_flow_calendar.json'),
    ];
    for (const p of cands) if (existsSync(p)) return p;
    return null;
}

export function evaluatePassiveFlowCalendar(
    fetchedAt: string,
    nowMs = Date.now(),
): LayerEnvelope<PassiveFlowData> {
    const path = resolvePath();
    let events: PassiveFlowEvent[] = [];
    if (path) {
        try {
            const raw = JSON.parse(readFileSync(path, 'utf8')) as PassiveFlowEvent[];
            events = Array.isArray(raw) ? raw : [];
        } catch {
            events = [];
        }
    }

    const horizon = 7 * 86400_000;
    const near = events.filter((e) => {
        const t = Date.parse(e.effective_at);
        return Number.isFinite(t) && Math.abs(t - nowMs) <= horizon;
    });
    const affected = [...new Set(near.flatMap((e) => e.symbols ?? []))];
    const hasNamedImpact = affected.length > 0;

    return {
        layer: 'PassiveFlowCalendar',
        completeness: events.length > 0 ? 'PARTIAL' : 'UNAVAILABLE',
        available: events.length > 0,
        proxy: false,
        note: 'Phase-1 marker only. PASSIVE_FLOW_EVENT must not be treated as BuyPressure evidence.',
        meta: buildMeta({
            source: 'curated_passive_flow_calendar.json',
            source_type: 'passive_flow',
            fetched_at: fetchedAt,
            available: events.length > 0,
            realtime_level: 'EOD',
            confidence: hasNamedImpact ? 'MEDIUM' : 'LOW',
            coverage_pct: hasNamedImpact ? 40 : 10,
        }),
        data: {
            events,
            affected_symbols: affected,
            passive_flow_event: hasNamedImpact,
            note: hasNamedImpact
                ? 'PASSIVE_FLOW_EVENT — do not treat as BP evidence'
                : 'No symbol-level impact list for near-term events',
        },
    };
}
