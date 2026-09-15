// server/src/lib/historical-replay/feature-capability.ts
// Replay 1m: unavailable features must NOT be scored as 0 — renormalize weights.

export interface ReplayFeatureFlags {
    momentum: boolean;
    volume_acceleration: boolean;
    relative_strength: boolean;
    vwap_structure: boolean;
    breakout: boolean;
    pullback: boolean;
    liquidity: boolean;
    trade_aggression: boolean;
    bid_ask: boolean;
    orderbook: boolean;
    tick_velocity: boolean;
    volume_acceleration_3s: boolean;
}

export const REPLAY_1M_FEATURES: ReplayFeatureFlags = {
    momentum: true,
    volume_acceleration: true,
    relative_strength: true,
    vwap_structure: true, // available; confidence may be degraded
    breakout: true,
    pullback: true,
    liquidity: true,
    trade_aggression: false,
    bid_ask: false,
    orderbook: false,
    tick_velocity: false,
    volume_acceleration_3s: false,
};

export type ReplayConfidence = 'high' | 'medium' | 'low';
export type ReplayQuality = 'ok' | 'degraded' | 'invalid';

export type UniverseSource =
    | 'manual_test'
    | 'historical_A'
    | 'historical_universe'
    | 'synthetic';

/** Only real historical universes may enter Outcome learning. */
export function learningEligible(
    universeSource: UniverseSource,
    synthetic: boolean,
): boolean {
    if (synthetic) return false;
    if (universeSource === 'manual_test' || universeSource === 'synthetic') {
        return false;
    }
    return true;
}

export function scoreConfidenceFromCoverage(
    coveragePct: number,
): ReplayConfidence {
    if (coveragePct >= 90) return 'high';
    if (coveragePct >= 70) return 'medium';
    return 'low';
}

/** Quality uses DATA_MISSING only — NO_TRADE does not degrade. */
export function replayQualityFromDataMissing(
    dataMissingCount: number,
    dataMissingRanges: string[] = [],
    continuousMissingThreshold = 15,
): ReplayQuality {
    const maxCont = maxContinuousMissing(dataMissingRanges);
    if (
        dataMissingCount > 60 ||
        maxCont >= continuousMissingThreshold * 2
    ) {
        return 'invalid';
    }
    if (
        dataMissingCount > 10 ||
        maxCont >= continuousMissingThreshold
    ) {
        return 'degraded';
    }
    return 'ok';
}

export function replayConfidence(opts: {
    /** Mean per-eval coverage across timeline (not a fixed constant). */
    meanCoveragePct: number;
    dataMissingCount: number;
    amountAvailable: boolean;
    indexAvailable: boolean;
}): ReplayConfidence {
    let c = opts.meanCoveragePct;
    if (!opts.amountAvailable) c -= 5;
    if (!opts.indexAvailable) c -= 5;
    if (opts.dataMissingCount > 30) c -= 20;
    else if (opts.dataMissingCount > 10) c -= 10;
    return scoreConfidenceFromCoverage(c);
}

function maxContinuousMissing(ranges: string[]): number {
    let max = 0;
    for (const r of ranges) {
        if (!r.includes('-')) {
            max = Math.max(max, 1);
            continue;
        }
        const [a, b] = r.split('-');
        const toMin = (s: string) => {
            const [h, m] = s.split(':').map(Number);
            return (h ?? 0) * 60 + (m ?? 0);
        };
        max = Math.max(max, toMin(b!) - toMin(a!) + 1);
    }
    return max;
}
