// server/src/lib/buy-pressure/feature-history.ts
// Rolling feature samples for slope / acceleration detection.

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

const MAX_LEN = 24;

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
}

/** Simple slope over last N points with numeric values (Δ / steps). */
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

export function slopesFromHistory(hist: FeaturePoint[]): {
    rvol_slope: number | null;
    volume_acceleration_slope: number | null;
    trade_aggression_change: number | null;
    momentum_acceleration_slope: number | null;
    bidask_imbalance_change: number | null;
    vwap_distance_change: number | null;
    rvol_accel: AccelLabel;
    volume_accel_label: AccelLabel;
} {
    const recent = hist.slice(-6);
    const rvol_slope = slopeOf(recent.map((p) => p.rvol));
    const volume_acceleration_slope = slopeOf(
        recent.map((p) => p.volume_acceleration),
    );
    const trade_aggression_change = slopeOf(
        recent.map((p) => p.trade_aggression),
    );
    const momentum_acceleration_slope = slopeOf(
        recent.map((p) => p.momentum_acceleration),
    );
    const bidask_imbalance_change = slopeOf(
        recent.map((p) => p.bidask_imbalance),
    );
    const vwap_distance_change = slopeOf(
        recent.map((p) => p.distance_from_vwap_pct),
    );
    return {
        rvol_slope,
        volume_acceleration_slope,
        trade_aggression_change,
        momentum_acceleration_slope,
        bidask_imbalance_change,
        vwap_distance_change,
        rvol_accel: accelLabel(rvol_slope, 0.08),
        volume_accel_label: accelLabel(volume_acceleration_slope, 2),
    };
}
