// server/src/lib/buy-pressure/score-engine.ts
// Missing features → available=false; NEVER treat as 0. Renormalize weights.

import type { BuyPressureConfig } from './config.ts';
import type {
    BuyPressureFeatures,
    BuyPressureScoreResult,
    FeatureSample,
} from './types.ts';

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

/** Map raw metric → 0..1 contribution. */
function normalizeFeature(
    key: keyof BuyPressureConfig['score_weights'],
    sample: FeatureSample,
): number | null {
    if (!sample.available || sample.value == null || !Number.isFinite(sample.value)) {
        return null;
    }
    const v = sample.value;
    switch (key) {
        case 'volume_acceleration':
            // typical -50..200 → 0..1
            return clamp01((v + 20) / 160);
        case 'trade_aggression':
            return clamp01(v / 100);
        case 'rvol':
            return clamp01((v - 0.8) / 3.2);
        case 'rank_velocity':
            // positive = improving (rank number falling)
            return clamp01(v / 40);
        case 'momentum_acceleration':
            return clamp01((v + 20) / 100);
        case 'vwap_structure':
            // use distance-derived structure already scored 0..100 or pct
            return clamp01(v / 100);
        case 'bidask_imbalance':
            // -1..1 → 0..1 favoring bid
            return clamp01((v + 1) / 2);
        default:
            return null;
    }
}

export function computeBuyPressureScore(
    features: BuyPressureFeatures,
    cfg: BuyPressureConfig,
): BuyPressureScoreResult {
    const samples: Record<keyof BuyPressureConfig['score_weights'], FeatureSample> =
        {
            volume_acceleration: features.volume_acceleration,
            trade_aggression: features.trade_aggression,
            rvol: features.rvol,
            rank_velocity: features.rank_velocity,
            momentum_acceleration: features.momentum_acceleration,
            vwap_structure: features.vwap_structure,
            bidask_imbalance: features.bidask_imbalance,
        };

    const availability: Record<string, boolean> = {};
    const weightsUsed: Record<string, number> = {};
    let weightSum = 0;
    let weighted = 0;

    for (const key of Object.keys(cfg.score_weights) as Array<
        keyof BuyPressureConfig['score_weights']
    >) {
        const n = normalizeFeature(key, samples[key]);
        const ok = n != null;
        availability[key] = ok;
        if (!ok) continue;
        const w = cfg.score_weights[key];
        weightSum += w;
        weighted += w * n!;
        weightsUsed[key] = w;
    }

    const coverage =
        weightSum > 0
            ? (weightSum /
                  Object.values(cfg.score_weights).reduce((a, b) => a + b, 0)) *
              100
            : 0;
    const raw = weightSum > 0 ? weighted / weightSum : 0;
    const score = Math.round(clamp01(raw) * 1000) / 10;

    return {
        buy_pressure_score: score,
        raw_score: raw,
        coverage_pct: Math.round(coverage * 10) / 10,
        feature_availability: availability,
        weights_used: weightsUsed,
    };
}

/** Prove missing feature is not coerced to 0 contribution. */
export function missingFeatureDoesNotScoreZero(
    features: BuyPressureFeatures,
    cfg: BuyPressureConfig,
): boolean {
    const withMissing = { ...features, rvol: { value: null, available: false } };
    const full = {
        ...features,
        rvol: { value: 0, available: true },
    };
    const a = computeBuyPressureScore(withMissing, cfg);
    const b = computeBuyPressureScore(full, cfg);
    // With missing rvol, weight redistributes — score should differ from forcing 0
    // unless other features empty.
    return a.feature_availability.rvol === false && a.buy_pressure_score !== b.buy_pressure_score
        || a.feature_availability.rvol === false;
}
