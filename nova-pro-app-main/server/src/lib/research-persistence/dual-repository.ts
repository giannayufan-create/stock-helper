// server/src/lib/research-persistence/dual-repository.ts
// dual mode: JSONL sync (local backup) + Firestore async queue (primary cloud).

import type { SignalType, StrategySignal } from '../strategy-signal/types.ts';
import type { StrategySignalRepository } from '../strategy-signal/repository.ts';
import type { SignalOutcome } from '../signal-outcome/types.ts';
import type { SignalOutcomeRepository } from '../signal-outcome/repository.ts';
import type { JsonlStrategySignalRepository } from '../strategy-signal/repository.ts';
import type { JsonlSignalOutcomeRepository } from '../signal-outcome/repository.ts';
import type { FirestoreStrategySignalRepository } from './firestore-signal-repository.ts';
import type { FirestoreSignalOutcomeRepository } from './firestore-outcome-repository.ts';
import { signalsContentEqual } from './hash.ts';
import type { ResearchPersistenceHealth } from './types.ts';

export class DualStrategySignalRepository implements StrategySignalRepository {
    constructor(
        readonly jsonl: JsonlStrategySignalRepository,
        readonly firestore: FirestoreStrategySignalRepository,
    ) {}

    save(signal: StrategySignal): void {
        try {
            this.jsonl.save(signal);
        } catch (err) {
            const existing = this.jsonl.findById(signal.signal_id);
            if (existing && signalsContentEqual(existing, signal)) {
                // idempotent
            } else {
                throw err;
            }
        }
        try {
            this.firestore.save(signal);
        } catch (err) {
            if (err instanceof Error && err.message.includes('conflict')) {
                throw err;
            }
        }
    }

    findById(signalId: string): StrategySignal | null {
        return (
            this.firestore.findById(signalId) ??
            this.jsonl.findById(signalId)
        );
    }

    listByDate(ymd: string): StrategySignal[] {
        return mergeSignals(
            this.jsonl.listByDate(ymd),
            this.firestore.listByDate(ymd),
        );
    }

    listByType(type: SignalType, ymd?: string): StrategySignal[] {
        return mergeSignals(
            this.jsonl.listByType(type, ymd),
            this.firestore.listByType(type, ymd),
        );
    }

    listRange(fromYmd: string, toYmd: string): StrategySignal[] {
        return mergeSignals(
            this.jsonl.listRange(fromYmd, toYmd),
            this.firestore.listRange(fromYmd, toYmd),
        );
    }

    knownIds(): Set<string> {
        return new Set([
            ...this.jsonl.knownIds(),
            ...this.firestore.knownIds(),
        ]);
    }

    hydrateKnownIds(): void {
        this.jsonl.hydrateKnownIds();
        this.firestore.hydrateKnownIds();
    }

    getHealth(): ResearchPersistenceHealth {
        const fh = this.firestore.getHealth();
        return {
            ...fh,
            provider: 'DUAL',
            mode: 'dual',
            effective_mode: 'dual',
            durable: fh.durable,
        };
    }

    async flush(): Promise<void> {
        await this.firestore.flush();
    }
}

export class DualSignalOutcomeRepository implements SignalOutcomeRepository {
    constructor(
        readonly jsonl: JsonlSignalOutcomeRepository,
        readonly firestore: FirestoreSignalOutcomeRepository,
    ) {}

    appendUpdate(outcome: SignalOutcome): void {
        this.jsonl.appendUpdate(outcome);
        this.firestore.appendUpdate(outcome);
    }

    findBySignalId(signalId: string): SignalOutcome | null {
        return (
            this.firestore.findBySignalId(signalId) ??
            this.jsonl.findBySignalId(signalId)
        );
    }

    listByDate(ymd: string): SignalOutcome[] {
        return mergeOutcomes(
            this.jsonl.listByDate(ymd),
            this.firestore.listByDate(ymd),
        );
    }

    listByType(type: SignalType, ymd?: string): SignalOutcome[] {
        return mergeOutcomes(
            this.jsonl.listByType(type, ymd),
            this.firestore.listByType(type, ymd),
        );
    }

    listRange(fromYmd: string, toYmd: string): SignalOutcome[] {
        return this.materializeRange(fromYmd, toYmd);
    }

    materializeRange(fromYmd: string, toYmd: string): SignalOutcome[] {
        return mergeOutcomes(
            this.jsonl.materializeRange(fromYmd, toYmd),
            this.firestore.materializeRange(fromYmd, toYmd),
        );
    }

    getHealth(): ResearchPersistenceHealth {
        const fh = this.firestore.getHealth();
        return { ...fh, provider: 'DUAL', mode: 'dual' };
    }

    async flush(): Promise<void> {
        await this.firestore.flush();
    }
}

function mergeSignals(
    a: StrategySignal[],
    b: StrategySignal[],
): StrategySignal[] {
    const map = new Map<string, StrategySignal>();
    for (const s of a) map.set(s.signal_id, s);
    for (const s of b) {
        if (!map.has(s.signal_id)) map.set(s.signal_id, s);
    }
    return [...map.values()];
}

function mergeOutcomes(
    a: SignalOutcome[],
    b: SignalOutcome[],
): SignalOutcome[] {
    const map = new Map<string, SignalOutcome>();
    for (const o of a) map.set(o.signal_id, o);
    for (const o of b) map.set(o.signal_id, o);
    return [...map.values()];
}
