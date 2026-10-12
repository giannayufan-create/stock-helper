// server/src/lib/signal-outcome/summary-signals.ts
// Signals for outcome summaries without feature/context snapshots.

import type { StrategySignal } from '../strategy-signal/types.ts';
import {
    JsonlStrategySignalRepository,
    type StrategySignalRepository,
} from '../strategy-signal/repository.ts';
import { DualStrategySignalRepository } from '../research-persistence/dual-repository.ts';

/** Keeps every field analytics.ts filters or buckets on. */
export function slimSignal(s: StrategySignal): StrategySignal {
    return {
        signal_id: s.signal_id,
        symbol: s.symbol,
        signal_type: s.signal_type,
        signal_time: s.signal_time,
        reference_price: s.reference_price,
        reference_price_source: s.reference_price_source,
        source: s.source,
        score: s.score,
        heat_score: s.heat_score,
        market_regime: s.market_regime,
        strategy_version: s.strategy_version,
        config_hash: s.config_hash,
        source_mode: s.source_mode,
        data_resolution: s.data_resolution,
        score_confidence: s.score_confidence,
        learning_eligible: s.learning_eligible,
        feature_snapshot: {},
    };
}

export function listSummarySignals(
    repo: StrategySignalRepository,
    fromYmd: string,
    toYmd: string,
): StrategySignal[] {
    if (repo instanceof DualStrategySignalRepository) {
        const map = new Map<string, StrategySignal>();
        repo.jsonl.forEachInRange(fromYmd, toYmd, (s) => {
            map.set(s.signal_id, slimSignal(s));
        });
        for (const s of repo.firestore.listRange(fromYmd, toYmd)) {
            if (!map.has(s.signal_id)) map.set(s.signal_id, slimSignal(s));
        }
        return [...map.values()];
    }
    if (repo instanceof JsonlStrategySignalRepository) {
        const out: StrategySignal[] = [];
        repo.forEachInRange(fromYmd, toYmd, (s) => out.push(slimSignal(s)));
        return out;
    }
    return repo.listRange(fromYmd, toYmd).map(slimSignal);
}
