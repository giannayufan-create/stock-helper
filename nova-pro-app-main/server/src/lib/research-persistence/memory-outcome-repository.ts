// server/src/lib/research-persistence/memory-outcome-repository.ts

import type { SignalType } from '../strategy-signal/types.ts';
import type { SignalOutcome } from '../signal-outcome/types.ts';
import type { SignalOutcomeRepository } from '../signal-outcome/repository.ts';
import { PersistenceHealthTracker } from './health-tracker.ts';

function taipeiYmd(iso?: string): string {
    const d = iso ? new Date(iso) : new Date();
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

export class MemorySignalOutcomeRepository implements SignalOutcomeRepository {
    private store = new Map<string, SignalOutcome>();
    readonly health = new PersistenceHealthTracker();

    constructor() {
        this.health.connected = true;
    }

    appendUpdate(outcome: SignalOutcome): void {
        // Latest wins — does NOT mutate StrategySignal
        this.store.set(outcome.signal_id, structuredClone(outcome));
        this.health.write_success_count += 1;
        this.health.last_outcome_write_at = new Date().toISOString();
    }

    findBySignalId(signalId: string): SignalOutcome | null {
        const o = this.store.get(signalId);
        return o ? structuredClone(o) : null;
    }

    listByDate(ymd: string): SignalOutcome[] {
        return [...this.store.values()].filter(
            (o) => taipeiYmd(o.signal_time) === ymd,
        );
    }

    listByType(type: SignalType, ymd?: string): SignalOutcome[] {
        return (ymd ? this.listByDate(ymd) : [...this.store.values()]).filter(
            (o) => o.signal_type === type,
        );
    }

    listRange(fromYmd: string, toYmd: string): SignalOutcome[] {
        return this.materializeRange(fromYmd, toYmd);
    }

    materializeRange(fromYmd: string, toYmd: string): SignalOutcome[] {
        return [...this.store.values()].filter((o) => {
            const d = taipeiYmd(o.signal_time);
            return d >= fromYmd && d <= toYmd;
        });
    }
}
