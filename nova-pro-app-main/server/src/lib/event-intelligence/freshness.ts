// server/src/lib/event-intelligence/freshness.ts

import type { EventFreshness } from './types.ts';
import type { EventIntelligenceConfig } from './config.ts';

export function ageMs(
    publishedAt: string | null | undefined,
    nowMs = Date.now(),
): number | null {
    if (!publishedAt) return null;
    const t = Date.parse(publishedAt);
    if (!Number.isFinite(t)) return null;
    return Math.max(0, nowMs - t);
}

export function classifyFreshness(
    age: number | null,
    cfg: EventIntelligenceConfig,
): EventFreshness {
    if (age == null) return 'STALE';
    if (age <= cfg.fresh_ms) return 'FRESH';
    if (age <= cfg.recent_ms) return 'RECENT';
    if (age <= cfg.stale_ms) return 'STALE';
    return 'ARCHIVED';
}

export function isToastableFresh(freshness: EventFreshness): boolean {
    return freshness === 'FRESH' || freshness === 'RECENT';
}
