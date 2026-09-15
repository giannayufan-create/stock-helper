// server/src/lib/historical-replay/bar-time.ts
// Explicit 1m bar time semantics — NEVER guess provider timestamp meaning.
//
// TW kbars (Shioaji / Fugle historical candles) label datetime as BAR START:
//   "2026-06-15 09:00:00" → [09:00:00, 09:01:00)
// Complete OHLC/V known only at known_at = bar_end = bar_start + 60s.
//
// If a future provider uses bar-end labels, set BarTimestampSemantics = 'bar_end'.

export type BarTimestampSemantics = 'bar_start' | 'bar_end';

/** Documented default for current TW providers used by HistoricalDataLoader. */
export const DEFAULT_BAR_TIMESTAMP_SEMANTICS: BarTimestampSemantics =
    'bar_start';

export const BAR_MS = 60_000;

export interface BarTimeWindow {
    /** Inclusive start of the minute interval. */
    bar_start: number;
    /** Exclusive end of the minute interval (= next minute :00). */
    bar_end: number;
    /**
     * Earliest clock time when the full bar (H/L/C/V) is knowable.
     * Replay may apply + evaluate only when ReplayClock >= known_at.
     */
    known_at: number;
}

/**
 * Map provider datetime label → bar window.
 * @param labelTs epoch ms of the provider's datetime field
 */
export function resolveBarTimeWindow(
    labelTs: number,
    semantics: BarTimestampSemantics = DEFAULT_BAR_TIMESTAMP_SEMANTICS,
): BarTimeWindow {
    if (semantics === 'bar_start') {
        const bar_start = labelTs;
        const bar_end = labelTs + BAR_MS;
        return { bar_start, bar_end, known_at: bar_end };
    }
    // bar_end label: datetime is the close of the minute
    const bar_end = labelTs;
    const bar_start = labelTs - BAR_MS;
    return { bar_start, bar_end, known_at: bar_end };
}
