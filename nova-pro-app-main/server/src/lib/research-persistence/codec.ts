// server/src/lib/research-persistence/codec.ts
// Firestore Timestamp ↔ ISO string for API / StrategySignal shapes.

import type { StrategySignal } from '../strategy-signal/types.ts';
import type { SignalOutcome } from '../signal-outcome/types.ts';

type TsLike = { toDate: () => Date } | Date | string | number | null | undefined;

export function toIso(value: TsLike): string | null {
    if (value == null) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return new Date(value).toISOString();
    if (value instanceof Date) return value.toISOString();
    if (typeof (value as { toDate?: () => Date }).toDate === 'function') {
        return (value as { toDate: () => Date }).toDate().toISOString();
    }
    return null;
}

export function signalToFirestoreDoc(signal: StrategySignal): Record<string, unknown> {
    const ctx = signal.context_snapshot as
        | {
              market_context_version?: string;
              sector_rotation_version?: string;
              event_engine_version?: string;
              exposure_map_version?: string;
              confirmation_version?: string;
              schema_version?: string;
              config_hash?: string;
              taiwan_regime?: string | null;
              sector_rotation_state?: string | null;
              event_confirmation_state?: string | null;
          }
        | undefined;
    return {
        signal_id: signal.signal_id,
        symbol: signal.symbol,
        name: signal.name ?? null,
        signal_type: signal.signal_type,
        reference_price: signal.reference_price,
        signal_time: signal.signal_time,
        created_at: new Date().toISOString(),
        feature_snapshot: signal.feature_snapshot,
        context_snapshot: signal.context_snapshot ?? null,
        context_tags: signal.context_tags ?? [],
        context_alignment: signal.context_alignment ?? null,
        context_strength_score: signal.context_strength_score ?? null,
        learning_eligible: signal.learning_eligible,
        source_mode: signal.source_mode,
        strategy_version: signal.strategy_version,
        market_context_version: ctx?.market_context_version ?? null,
        sector_rotation_version: ctx?.sector_rotation_version ?? null,
        event_engine_version: ctx?.event_engine_version ?? null,
        exposure_map_version: ctx?.exposure_map_version ?? null,
        confirmation_version: ctx?.confirmation_version ?? null,
        config_hash: signal.config_hash,
        schema_version: ctx?.schema_version ?? null,
        // denormalized query fields
        market_regime: ctx?.taiwan_regime ?? signal.market_regime ?? null,
        sector_state: ctx?.sector_rotation_state ?? null,
        event_state: ctx?.event_confirmation_state ?? null,
        score: signal.score ?? null,
        heat_score: signal.heat_score ?? null,
        data_resolution: signal.data_resolution,
        open_gate_version: signal.open_gate_version ?? null,
        intraday_rank_version: signal.intraday_rank_version ?? null,
        runtime_version: signal.runtime_version ?? null,
        metadata: signal.metadata ?? null,
        identity_hash: null as string | null, // filled by caller
    };
}

export function firestoreDocToSignal(raw: Record<string, unknown>): StrategySignal {
    const signal_time =
        toIso(raw.signal_time as TsLike) ??
        toIso(raw.created_at as TsLike) ??
        new Date().toISOString();
    return {
        signal_id: String(raw.signal_id),
        symbol: String(raw.symbol),
        name: (raw.name as string | undefined) ?? undefined,
        signal_type: raw.signal_type as StrategySignal['signal_type'],
        signal_time,
        reference_price: Number(raw.reference_price),
        reference_price_source: 'firestore',
        source: (raw.source as StrategySignal['source']) ?? 'C',
        score: raw.score != null ? Number(raw.score) : undefined,
        heat_score: raw.heat_score != null ? Number(raw.heat_score) : undefined,
        market_regime: (raw.market_regime as string | undefined) ?? undefined,
        strategy_version: String(raw.strategy_version ?? 'bc-strategy-v1'),
        config_hash: String(raw.config_hash ?? ''),
        open_gate_version: (raw.open_gate_version as string | undefined) ?? undefined,
        intraday_rank_version:
            (raw.intraday_rank_version as string | undefined) ?? undefined,
        runtime_version: (raw.runtime_version as string | undefined) ?? undefined,
        source_mode: (raw.source_mode as 'live' | 'replay') ?? 'live',
        data_resolution: (raw.data_resolution as 'tick' | '1m') ?? 'tick',
        learning_eligible: Boolean(raw.learning_eligible),
        feature_snapshot: (raw.feature_snapshot as Record<string, unknown>) ?? {},
        context_snapshot: (raw.context_snapshot as StrategySignal['context_snapshot']) ?? undefined,
        context_tags: (raw.context_tags as StrategySignal['context_tags']) ?? undefined,
        context_alignment:
            (raw.context_alignment as StrategySignal['context_alignment']) ??
            undefined,
        context_strength_score:
            raw.context_strength_score != null
                ? Number(raw.context_strength_score)
                : null,
        metadata: (raw.metadata as Record<string, unknown> | undefined) ?? undefined,
    };
}

export function outcomeToFirestoreDoc(outcome: SignalOutcome): Record<string, unknown> {
    return {
        ...outcome,
        signal_time: outcome.signal_time,
        calculated_at: outcome.calculated_at,
        outcome_version: 'outcome_v1',
        updated_at: new Date().toISOString(),
    };
}

export function firestoreDocToOutcome(raw: Record<string, unknown>): SignalOutcome {
    return {
        ...(raw as unknown as SignalOutcome),
        signal_id: String(raw.signal_id),
        signal_time:
            toIso(raw.signal_time as TsLike) ?? String(raw.signal_time ?? ''),
        calculated_at:
            toIso(raw.calculated_at as TsLike) ??
            String(raw.calculated_at ?? new Date().toISOString()),
    };
}
