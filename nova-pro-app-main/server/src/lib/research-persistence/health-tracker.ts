// server/src/lib/research-persistence/health-tracker.ts

import { getFirebaseStatus } from './admin.ts';
import type {
    FirebaseAdminStatus,
    HydrateStatus,
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
    hydrate_status: HydrateStatus = 'IDLE';
    last_hydrate_at: string | null = null;
    last_write_latency_ms: number | null = null;

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
        firebase_status?: FirebaseAdminStatus;
        hydrate_status?: HydrateStatus;
        last_hydrate_at?: string | null;
        last_write_latency_ms?: number | null;
    }): ResearchPersistenceHealth {
        const firestore_initialized =
            input.firestore_initialized ?? this.initialized;
        const firestore_connected = this.connected;
        const firebase_status =
            input.firebase_status ?? getFirebaseStatus();
        let status: ResearchPersistenceHealth['status'] = 'HEALTHY';
        if (
            input.effective_mode !== 'jsonl' &&
            (!firestore_initialized || !firestore_connected)
        ) {
            status = 'DEGRADED';
        }
        if (input.provider === 'UNAVAILABLE') status = 'UNAVAILABLE';
        if (input.env_conflict) status = 'DEGRADED';

        const primary_repository =
            input.effective_mode === 'firestore'
                ? 'FIRESTORE'
                : input.effective_mode === 'dual'
                  ? 'DUAL'
                  : 'JSONL';

        return {
            provider: input.provider,
            mode: input.effective_mode,
            configured_mode: input.configured_mode,
            effective_mode: input.effective_mode,
            primary_repository,
            firebase_status,
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
            last_write_latency_ms:
                input.last_write_latency_ms ??
                this.last_write_latency_ms ??
                input.write_latency.max_ms,
            last_signal_write_at: this.last_signal_write_at,
            last_outcome_write_at: this.last_outcome_write_at,
            write_success_count: this.write_success_count,
            write_failure_count: this.write_failure_count,
            conflict_count: this.conflict_count,
            last_error: this.last_error,
            hydrate_status: input.hydrate_status ?? this.hydrate_status,
            last_hydrate_at:
                input.last_hydrate_at !== undefined
                    ? input.last_hydrate_at
                    : this.last_hydrate_at,
            env_conflict: Boolean(input.env_conflict),
            status,
            mutates_strategy: false,
            creates_upstream_subscription: false,
        };
    }
}
