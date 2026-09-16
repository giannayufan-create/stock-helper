// server/src/lib/research-persistence/health-tracker.ts

import type {
    QueueLatencyStats,
    QueuePressure,
    ResearchPersistenceHealth,
    ResearchRepositoryMode,
} from './types.ts';

export class PersistenceHealthTracker {
    write_success_count = 0;
    write_failure_count = 0;
    conflict_count = 0;
    last_signal_write_at: string | null = null;
    last_outcome_write_at: string | null = null;
    last_error: string | null = null;
    connected = false;
    initialized = false;

    snapshot(input: {
        provider: ResearchPersistenceHealth['provider'];
        configured_mode: ResearchRepositoryMode;
        effective_mode: ResearchRepositoryMode;
        durable: boolean;
        queue_depth: number;
        queue_pressure: QueuePressure;
        max_queue_depth: number;
        write_latency: QueueLatencyStats;
        env_conflict?: boolean;
        firestore_initialized?: boolean;
    }): ResearchPersistenceHealth {
        const firestore_initialized =
            input.firestore_initialized ?? this.initialized;
        const firestore_connected = this.connected;
        let status: ResearchPersistenceHealth['status'] = 'HEALTHY';
        if (
            input.effective_mode !== 'jsonl' &&
            (!firestore_initialized || !firestore_connected)
        ) {
            status = 'DEGRADED';
        }
        if (input.provider === 'UNAVAILABLE') status = 'UNAVAILABLE';
        if (input.env_conflict) status = 'DEGRADED';

        return {
            provider: input.provider,
            mode: input.effective_mode,
            configured_mode: input.configured_mode,
            effective_mode: input.effective_mode,
            firestore_initialized,
            firestore_connected,
            connected:
                input.effective_mode === 'jsonl'
                    ? true
                    : firestore_connected,
            durable: input.durable,
            queue_depth: input.queue_depth,
            queue_pressure: input.queue_pressure,
            max_queue_depth: input.max_queue_depth,
            write_latency: input.write_latency,
            last_signal_write_at: this.last_signal_write_at,
            last_outcome_write_at: this.last_outcome_write_at,
            write_success_count: this.write_success_count,
            write_failure_count: this.write_failure_count,
            conflict_count: this.conflict_count,
            last_error: this.last_error,
            env_conflict: Boolean(input.env_conflict),
            status,
            mutates_strategy: false,
            creates_upstream_subscription: false,
        };
    }
}
