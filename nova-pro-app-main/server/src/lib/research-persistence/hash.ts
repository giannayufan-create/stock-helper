// server/src/lib/research-persistence/hash.ts

import { createHash } from 'node:crypto';
import type { StrategySignal } from '../strategy-signal/types.ts';
import type { SignalOutcome } from '../signal-outcome/types.ts';

export function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => stableStringify(v)).join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
        .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
        .join(',')}}`;
}

export function sha12(value: unknown): string {
    return createHash('sha256')
        .update(stableStringify(value))
        .digest('hex')
        .slice(0, 12);
}

/** Fields compared for StrategySignal immutability / idempotency. */
export function signalIdentityHash(signal: StrategySignal): string {
    return sha12({
        signal_id: signal.signal_id,
        signal_time: signal.signal_time,
        symbol: signal.symbol,
        signal_type: signal.signal_type,
        reference_price: signal.reference_price,
        feature_snapshot: signal.feature_snapshot,
        context_snapshot: signal.context_snapshot ?? null,
        context_tags: signal.context_tags ?? [],
        context_alignment: signal.context_alignment ?? null,
        context_strength_score: signal.context_strength_score ?? null,
        strategy_version: signal.strategy_version,
        config_hash: signal.config_hash,
        schema_version:
            (signal.context_snapshot as { schema_version?: string } | undefined)
                ?.schema_version ?? null,
    });
}

export function outcomeIdentityHash(outcome: SignalOutcome): string {
    return sha12({
        signal_id: outcome.signal_id,
        status: outcome.status,
        calculated_at: outcome.calculated_at,
        forward_return_15m: outcome.forward_return_15m ?? null,
        mfe_15m: outcome.mfe_15m ?? null,
        mae_15m: outcome.mae_15m ?? null,
        outcome_sequence: outcome.outcome_sequence ?? null,
    });
}

export function signalsContentEqual(a: StrategySignal, b: StrategySignal): boolean {
    return signalIdentityHash(a) === signalIdentityHash(b);
}
