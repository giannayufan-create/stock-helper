// server/src/lib/research-persistence/health-tracker.ts

import type {
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

    snapshot(input: {
        provider: ResearchPersistenceHealth['provider'];
        mode: ResearchRepositoryMode;
        durable: boolean;
        queue_depth: number;
        queue_pressure: QueuePressure;
    }): ResearchPersistenceHealth {
        return {
            provider: input.provider,
            mode: input.mode,
            connected: this.connected,
            durable: input.durable,
            queue_depth: input.queue_depth,
            queue_pressure: input.queue_pressure,
            last_signal_write_at: this.last_signal_write_at,
            last_outcome_write_at: this.last_outcome_write_at,
            write_success_count: this.write_success_count,
            write_failure_count: this.write_failure_count,
            conflict_count: this.conflict_count,
            last_error: this.last_error,
            mutates_strategy: false,
            creates_upstream_subscription: false,
        };
    }
}
