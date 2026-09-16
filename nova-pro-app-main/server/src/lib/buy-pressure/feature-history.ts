// server/src/lib/buy-pressure/feature-history.ts
// Rolling feature samples for slope / acceleration detection.
// Slopes MUST use a timestamp window — never assume fixed sample count = N seconds.

export interface FeaturePoint {
    t: number;
    rvol: number | null;
    volume_acceleration: number | null;
    trade_aggression: number | null;
    rank_velocity: number | null;
    momentum_acceleration: number | null;
    bidask_imbalance: number | null;
    distance_from_vwap_pct: number | null;
    rank: number | null;
}

const MAX_LEN = 120;
/** Default lookback for EARLY / accel slopes (ms). */
export const DEFAULT_SLOPE_WINDOW_MS = 90_000;

export class FeatureHistoryStore {
    private map = new Map<string, FeaturePoint[]>();

    push(symbol: string, point: FeaturePoint): FeaturePoint[] {
        const prev = this.map.get(symbol) ?? [];
        const next = [...prev, point].slice(-MAX_LEN);
        this.map.set(symbol, next);
        return next;
    }

    get(symbol: string): FeaturePoint[] {
        return this.map.get(symbol) ?? [];
    }

    /** Points within [now - windowMs, now], ordered oldest→newest. */
    window(symbol: string, windowMs: number, nowMs?: number): FeaturePoint[] {
        const now = nowMs ?? Date.now();
        const cut = now - Math.max(1_000, windowMs);
        return (this.map.get(symbol) ?? []).filter((p) => p.t >= cut && p.t <= now);
    }
}

/**
 * Slope as Δvalue / Δtime_seconds over points inside a timestamp window.
 * Returns null if fewer than minPoints with finite values, or Δt < 1s.
 */
export function slopeOfTimeWindow(
    points: Array<{ t: number; v: number | null | undefined }>,
    minPoints = 3,
): number | null {
    const vals = points.filter(
        (p): p is { t: number; v: number } =>
            p.v != null && Number.isFinite(p.v) && Number.isFinite(p.t),
    );
    if (vals.length < minPoints) return null;
    const a = vals[0]!;
    const b = vals[vals.length - 1]!;
    const dtSec = (b.t - a.t) / 1000;
    if (dtSec < 1) return null;
    return (b.v - a.v) / dtSec;
}

/** @deprecated Prefer slopeOfTimeWindow — kept for unit tests that pass raw arrays. */
export function slopeOf(
    series: Array<number | null | undefined>,
    minPoints = 3,
): number | null {
    const vals = series.filter(
        (v): v is number => v != null && Number.isFinite(v),
    );
    if (vals.length < minPoints) return null;
    const a = vals[0]!;
    const b = vals[vals.length - 1]!;
    return (b - a) / (vals.length - 1);
}

export type AccelLabel = 'ACCELERATING' | 'DECELERATING' | 'FLAT' | 'UNKNOWN';

export function accelLabel(slope: number | null, eps = 0.05): AccelLabel {
    if (slope == null) return 'UNKNOWN';
    if (slope > eps) return 'ACCELERATING';
    if (slope < -eps) return 'DECELERATING';
    return 'FLAT';
}

export function slopesFromHistory(
    hist: FeaturePoint[],
    windowMs: number = DEFAULT_SLOPE_WINDOW_MS,
    nowMs?: number,
): {
    rvol_slope: number | null;
    volume_acceleration_slope: number | null;
    trade_aggression_change: number | null;
    momentum_acceleration_slope: number | null;
    bidask_imbalance_change: number | null;
    vwap_distance_change: number | null;
    rank_velocity_slope: number | null;
    window_ms: number;
    sample_count: number;
    rvol_accel: AccelLabel;
    volume_accel_label: AccelLabel;
} {
    const now = nowMs ?? (hist.length ? hist[hist.length - 1]!.t : Date.now());
    const cut = now - Math.max(1_000, windowMs);
    const recent = hist.filter((p) => p.t >= cut && p.t <= now);
    const rvol_slope = slopeOfTimeWindow(
        recent.map((p) => ({ t: p.t, v: p.rvol })),
    );
    const volume_acceleration_slope = slopeOfTimeWindow(
        recent.map((p) => ({ t: p.t, v: p.volume_acceleration })),
    );
    const trade_aggression_change = slopeOfTimeWindow(
        recent.map((p) => ({ t: p.t, v: p.trade_aggression })),
    );
    const momentum_acceleration_slope = slopeOfTimeWindow(
        recent.map((p) => ({ t: p.t, v: p.momentum_acceleration })),
    );
    const bidask_imbalance_change = slopeOfTimeWindow(
        recent.map((p) => ({ t: p.t, v: p.bidask_imbalance })),
    );
    const vwap_distance_change = slopeOfTimeWindow(
        recent.map((p) => ({ t: p.t, v: p.distance_from_vwap_pct })),
    );
    const rank_velocity_slope = slopeOfTimeWindow(
        recent.map((p) => ({ t: p.t, v: p.rank_velocity })),
    );
    return {
        rvol_slope,
        volume_acceleration_slope,
        trade_aggression_change,
        momentum_acceleration_slope,
        bidask_imbalance_change,
        vwap_distance_change,
        rank_velocity_slope,
        window_ms: windowMs,
        sample_count: recent.length,
        // Per-second slopes: eps scaled for ~90s windows
        rvol_accel: accelLabel(rvol_slope, 0.002),
        volume_accel_label: accelLabel(volume_acceleration_slope, 0.05),
    };
}
