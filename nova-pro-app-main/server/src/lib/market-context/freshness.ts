// server/src/lib/market-context/freshness.ts

import type {
    ConfidenceLevel,
    ContextDataPointMeta,
    RealtimeLevel,
} from './types.ts';

export function buildMeta(input: {
    source: string;
    source_type: string;
    observed_at?: string | null;
    published_at?: string | null;
    fetched_at?: string;
    available: boolean;
    coverage_pct?: number | null;
    confidence?: ConfidenceLevel;
    realtime_level: RealtimeLevel;
    nowMs?: number;
}): ContextDataPointMeta {
    const fetched = input.fetched_at ?? new Date().toISOString();
    const now = input.nowMs ?? Date.now();
    const anchor =
        input.observed_at ?? input.published_at ?? fetched;
    const anchorMs = Date.parse(anchor);
    const age_ms = Number.isFinite(anchorMs) ? Math.max(0, now - anchorMs) : null;
    const freshness =
        input.realtime_level === 'REALTIME'
            ? 'realtime'
            : input.realtime_level === 'NEAR_REALTIME'
              ? 'near_realtime'
              : input.realtime_level === 'DELAYED'
                ? 'delayed'
                : input.realtime_level === 'EOD'
                  ? 'eod'
                  : input.realtime_level === 'PREVIOUS_DAY'
                    ? 'previous_day'
                    : 'unknown';
    return {
        source: input.source,
        source_type: input.source_type,
        observed_at: input.observed_at ?? null,
        published_at: input.published_at ?? null,
        fetched_at: fetched,
        freshness,
        age_ms,
        available: input.available,
        coverage_pct: input.coverage_pct ?? null,
        confidence: input.confidence ?? (input.available ? 'MEDIUM' : 'NONE'),
        realtime_level: input.realtime_level,
    };
}

export function confidenceFromCoverage(coveragePct: number): ConfidenceLevel {
    if (coveragePct >= 80) return 'HIGH';
    if (coveragePct >= 50) return 'MEDIUM';
    if (coveragePct > 0) return 'LOW';
    return 'NONE';
}

/** Classify TW day-quote session date vs today (Asia/Taipei). */
export function dayQuoteRealtimeLevel(
    sessionDate: string | null | undefined,
    now = new Date(),
): RealtimeLevel {
    if (!sessionDate) return 'UNKNOWN';
    const taipei = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(now);
    if (sessionDate === taipei) {
        // STOCK_DAY_ALL is cumulative session tape, not tick stream
        return 'DELAYED';
    }
    return 'PREVIOUS_DAY';
}
