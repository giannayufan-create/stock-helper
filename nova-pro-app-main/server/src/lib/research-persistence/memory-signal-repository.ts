// server/src/lib/research-persistence/memory-signal-repository.ts
// In-memory immutable store — mirrors Firestore semantics for tests / offline.

import type { SignalType, StrategySignal } from '../strategy-signal/types.ts';
import type { StrategySignalRepository } from '../strategy-signal/repository.ts';
import { signalsContentEqual, signalIdentityHash } from './hash.ts';
import type { PersistResult } from './types.ts';
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

export class MemoryStrategySignalRepository implements StrategySignalRepository {
    private store = new Map<string, StrategySignal>();
    private hashes = new Map<string, string>();
    readonly health = new PersistenceHealthTracker();
    lastPersistResult: PersistResult | null = null;

    constructor() {
        this.health.connected = true;
    }

    save(signal: StrategySignal): void {
        const existing = this.store.get(signal.signal_id);
        if (existing) {
            if (signalsContentEqual(existing, signal)) {
                this.lastPersistResult = 'SKIP_IDEMPOTENT';
                this.health.write_success_count += 1;
                return;
            }
            this.lastPersistResult = 'CONFLICT';
            this.health.conflict_count += 1;
            this.health.write_failure_count += 1;
            this.health.last_error = `CONFLICT signal_id=${signal.signal_id}`;
            console.error(
                `[research-persistence] CONFLICT immutable signal ${signal.signal_id}`,
            );
            throw new Error(
                `feature_snapshot immutable: signal ${signal.signal_id} conflict`,
            );
        }
        this.store.set(signal.signal_id, structuredClone(signal));
        this.hashes.set(signal.signal_id, signalIdentityHash(signal));
        this.lastPersistResult = 'CREATED';
        this.health.write_success_count += 1;
        this.health.last_signal_write_at = new Date().toISOString();
    }

    findById(signalId: string): StrategySignal | null {
        const s = this.store.get(signalId);
        return s ? structuredClone(s) : null;
    }

    listByDate(ymd: string): StrategySignal[] {
        return [...this.store.values()].filter(
            (s) => taipeiYmd(s.signal_time) === ymd,
        );
    }

    listByType(type: SignalType, ymd?: string): StrategySignal[] {
        return (ymd ? this.listByDate(ymd) : [...this.store.values()]).filter(
            (s) => s.signal_type === type,
        );
    }

    listRange(fromYmd: string, toYmd: string): StrategySignal[] {
        return [...this.store.values()]
            .filter((s) => {
                const d = taipeiYmd(s.signal_time);
                return d >= fromYmd && d <= toYmd;
            })
            .sort((a, b) => a.signal_time.localeCompare(b.signal_time));
    }

    knownIds(): Set<string> {
        return new Set(this.store.keys());
    }

    hydrateKnownIds(): void {
        /* already in memory */
    }
}
