// server/src/lib/strategy-signal/raw-signal-event.ts
// Immutable first-emission snapshot for strategy signal validation.
//
// IMPORTANT — append-only semantics:
// This is **application-layer append-only / non-overwrite** storage.
// It is NOT cryptographic tamper-evidence, NOT a blockchain, and NOT a
// signed audit log. Integrity relies on process discipline + filesystem
// access control, not hashing chains or Merkle proofs.
//
// exit_rules_snapshot: only fields that exist at emission time.
// Missing fields stay null/undefined forever — NEVER backfill later into
// the raw event (even if strategy exit rules are defined later).

export type RawSignalSourceMode = 'live' | 'replay' | 'synthetic';

/**
 * Exit fields known at first emission only.
 * Leave undefined/null when the strategy did not define them at signal time.
 */
export interface ExitRulesSnapshot {
    /** Risk invalidation price if defined at emission (e.g. OPEN_PASS invalid_price). */
    invalid_price?: number | null;
    invalid_reason?: string | null;
    /** Take-profit / target — only if strategy defined at emission. */
    take_profit_pct?: number | null;
    take_profit_price?: number | null;
    /** Hard stop — only if strategy defined at emission. */
    stop_loss_pct?: number | null;
    stop_loss_price?: number | null;
    /** Time-based exit (minutes) — only if strategy defined at emission. */
    max_hold_minutes?: number | null;
    /** Free-form notes frozen at emission (never mutate). */
    notes?: string | null;
}

export interface RawSignalScores {
    score?: number | null;
    heat_score?: number | null;
    a_score?: number | null;
    final_open_score?: number | null;
    intraday_score?: number | null;
    [key: string]: number | null | undefined;
}

export interface DataCompleteness {
    score_coverage_pct?: number | null;
    score_confidence?: string | null;
    data_resolution?: string | null;
    learning_eligible?: boolean;
    notes?: string | null;
}

/**
 * First-emission raw strategy signal event.
 * Append-only: once written, content must not be updated in the store API.
 */
export interface RawSignalEvent {
    signal_id: string;
    symbol: string;
    /** Human strategy family name, e.g. OPEN_PASS / STRONG_ENTER. */
    strategy_name: string;
    strategy_version: string;
    config_hash: string;

    /** Wall-clock (or replay clock) when the signal fired. */
    signal_time: string;
    /** When this raw event was observed/persisted (may equal signal_time). */
    observation_time: string;
    data_source: string;
    source_mode: RawSignalSourceMode;

    price_at_signal: number;
    scores: RawSignalScores;
    /** Trigger / gate conditions frozen at emission. */
    trigger_conditions: Record<string, unknown>;
    /** Key numeric/string inputs used to form the signal. */
    key_inputs: Record<string, unknown>;
    data_completeness: DataCompleteness;

    /**
     * Exit rules as known at emission only.
     * Do not backfill missing fields after the fact.
     */
    exit_rules_snapshot: ExitRulesSnapshot;

    /** Schema marker for future migrations (read-only evolution). */
    schema_version: 'raw-signal-event-v1';
}

export const RAW_SIGNAL_EVENT_SCHEMA = 'raw-signal-event-v1' as const;

export type AppendRawResult =
    | { ok: true; status: 'APPENDED' }
    | { ok: true; status: 'SKIP_IDEMPOTENT' }
    | { ok: false; status: 'REJECTED'; reason: string };
