// server/src/lib/research-persistence/types.ts

export type ResearchRepositoryMode = 'jsonl' | 'firestore' | 'dual';

export type QueuePressure = 'NORMAL' | 'WARNING' | 'CRITICAL';

export type PersistResult =
    | 'CREATED'
    | 'SKIP_IDEMPOTENT'
    | 'CONFLICT'
    | 'QUEUED'
    | 'FAILED';

export interface QueueLatencyStats {
    sample_count: number;
    avg_ms: number | null;
    p95_ms: number | null;
    max_ms: number | null;
    max_queue_depth: number;
}

export interface ResearchPersistenceHealth {
    provider: 'FIRESTORE' | 'JSONL' | 'DUAL' | 'UNAVAILABLE';
    /** @deprecated use configured_mode / effective_mode */
    mode: ResearchRepositoryMode;
    configured_mode: ResearchRepositoryMode;
    effective_mode: ResearchRepositoryMode;
    firestore_initialized: boolean;
    firestore_connected: boolean;
    connected: boolean;
    durable: boolean;
    queue_depth: number;
    queue_pressure: QueuePressure;
    max_queue_depth: number;
    write_latency: QueueLatencyStats;
    last_signal_write_at: string | null;
    last_outcome_write_at: string | null;
    write_success_count: number;
    write_failure_count: number;
    conflict_count: number;
    last_error: string | null;
    env_conflict: boolean;
    status: 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
    mutates_strategy: false;
    creates_upstream_subscription: false;
}

export const STRATEGY_SIGNALS_COLLECTION = 'strategy_signals';
export const SIGNAL_OUTCOMES_COLLECTION = 'signal_outcomes';
/** Diagnostic-only docs — never mixed into Context Analytics. */
export const RESEARCH_DIAGNOSTICS_COLLECTION = 'research_diagnostics';
