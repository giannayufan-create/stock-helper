// server/src/lib/research-persistence/types.ts

export type ResearchRepositoryMode = 'jsonl' | 'firestore' | 'dual';

export type QueuePressure = 'NORMAL' | 'WARNING' | 'CRITICAL';

export type PersistResult =
    | 'CREATED'
    | 'SKIP_IDEMPOTENT'
    | 'CONFLICT'
    | 'QUEUED'
    | 'FAILED';

export interface ResearchPersistenceHealth {
    provider: 'FIRESTORE' | 'JSONL' | 'DUAL' | 'UNAVAILABLE';
    mode: ResearchRepositoryMode;
    connected: boolean;
    durable: boolean;
    queue_depth: number;
    queue_pressure: QueuePressure;
    last_signal_write_at: string | null;
    last_outcome_write_at: string | null;
    write_success_count: number;
    write_failure_count: number;
    conflict_count: number;
    last_error: string | null;
    mutates_strategy: false;
    creates_upstream_subscription: false;
}

export const STRATEGY_SIGNALS_COLLECTION = 'strategy_signals';
export const SIGNAL_OUTCOMES_COLLECTION = 'signal_outcomes';
