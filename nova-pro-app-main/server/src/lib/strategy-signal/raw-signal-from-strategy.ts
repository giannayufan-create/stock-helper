// server/src/lib/strategy-signal/raw-signal-from-strategy.ts
// Build RawSignalEvent from StrategySignal at first emission.
// exit_rules_snapshot only includes fields present on the StrategySignal.

import {
    RAW_SIGNAL_EVENT_SCHEMA,
    type ExitRulesSnapshot,
    type RawSignalEvent,
    type RawSignalSourceMode,
} from './raw-signal-event.ts';
import type { StrategySignal } from './types.ts';

function asNum(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Map StrategySignal → RawSignalEvent.
 * Does not invent exit rules: only invalid_price/reason if present.
 */
export function rawSignalEventFromStrategy(
    signal: StrategySignal,
    opts?: {
        observation_time?: string;
        data_source?: string;
        source_mode?: RawSignalSourceMode;
    },
): RawSignalEvent {
    const snap = signal.feature_snapshot ?? {};
    const mode: RawSignalSourceMode =
        opts?.source_mode ??
        (signal.source_mode === 'replay' ? 'replay' : 'live');

    const exit: ExitRulesSnapshot = {
        invalid_price:
            signal.invalid_price != null ? signal.invalid_price : undefined,
        invalid_reason:
            signal.invalid_reason != null ? signal.invalid_reason : undefined,
        // take_profit / stop_loss / max_hold intentionally omitted —
        // not defined on bc-strategy-v1 at emission; do not backfill.
    };

    return {
        signal_id: signal.signal_id,
        symbol: signal.symbol,
        strategy_name: signal.signal_type,
        strategy_version: signal.strategy_version,
        config_hash: signal.config_hash,
        signal_time: signal.signal_time,
        observation_time: opts?.observation_time ?? signal.signal_time,
        data_source:
            opts?.data_source ??
            signal.reference_price_source ??
            signal.universe_source ??
            'strategy_signal',
        source_mode: mode,
        price_at_signal: signal.reference_price,
        scores: {
            score: signal.score ?? null,
            heat_score: signal.heat_score ?? null,
            a_score: asNum(snap.a_score),
            final_open_score: asNum(snap.final_open_score),
            intraday_score: asNum(snap.intraday_score),
        },
        trigger_conditions: {
            source: signal.source,
            state: signal.state ?? null,
            signal_type: signal.signal_type,
            open_confirm: signal.metadata?.open_confirm ?? null,
            tradeable_candidate: signal.metadata?.tradeable_candidate ?? null,
            market_regime: signal.market_regime ?? null,
            writer_service: signal.metadata?.writer_service ?? null,
        },
        key_inputs: {
            ...Object.fromEntries(
                Object.entries(snap).filter(
                    ([, v]) =>
                        typeof v === 'number' ||
                        typeof v === 'string' ||
                        typeof v === 'boolean' ||
                        v == null,
                ),
            ),
            session_minute: signal.session_minute ?? null,
            reference_price_source: signal.reference_price_source,
        },
        data_completeness: {
            score_coverage_pct: signal.score_coverage_pct ?? null,
            score_confidence: signal.score_confidence ?? null,
            data_resolution: signal.data_resolution,
            learning_eligible: signal.learning_eligible,
        },
        exit_rules_snapshot: exit,
        schema_version: RAW_SIGNAL_EVENT_SCHEMA,
    };
}
