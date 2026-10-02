// server/src/lib/research-persistence/firestore-outcome-repository.ts
// signal_outcomes/{signal_id} — independent of StrategySignal docs.

import { dateTimeFormat } from '../intl-cache.ts';
import type { Firestore } from 'firebase-admin/firestore';
import type { SignalType } from '../strategy-signal/types.ts';
import type { SignalOutcome } from '../signal-outcome/types.ts';
import type { SignalOutcomeRepository } from '../signal-outcome/repository.ts';
import {
    getResearchFirestore,
    getAdminInitError,
    getFirebaseStatus,
    markFirestoreOpFailure,
    markFirestoreOpSuccess,
} from './admin.ts';
import {
    firestoreDocToOutcome,
    outcomeToFirestoreDoc,
} from './codec.ts';
import type { ResearchPersistenceConfig } from './config.ts';
import { loadResearchPersistenceConfig } from './config.ts';
import { PersistenceHealthTracker } from './health-tracker.ts';
import { ResearchPersistenceQueue } from './queue.ts';
import {
    SIGNAL_OUTCOMES_COLLECTION,
    type ResearchPersistenceHealth,
} from './types.ts';

function taipeiYmd(iso?: string): string {
    const d = iso ? new Date(iso) : new Date();
    return dateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

const CACHE_MAX = 3000;
const CACHE_KEEP = 2000;

export class FirestoreSignalOutcomeRepository
    implements SignalOutcomeRepository
{
    private cache = new Map<string, SignalOutcome>();
    readonly health = new PersistenceHealthTracker();
    readonly queue: ResearchPersistenceQueue;
    private db: Firestore | null;
    private cfg: ResearchPersistenceConfig;

    constructor(
        db?: Firestore | null,
        cfg: ResearchPersistenceConfig = loadResearchPersistenceConfig(),
    ) {
        this.cfg = cfg;
        this.db = db === undefined ? getResearchFirestore() : db;
        this.health.connected = false;
        this.health.initialized = this.db != null;
        if (!this.db) {
            this.health.last_error =
                getAdminInitError() ?? 'Firestore unavailable';
        }
        this.queue = new ResearchPersistenceQueue(
            cfg.queue_max_depth,
            cfg.queue_warn_depth,
            cfg.queue_critical_depth,
        );
    }

    getHealth(): ResearchPersistenceHealth {
        const latency = this.queue.latencyStats();
        return this.health.snapshot({
            provider: 'FIRESTORE',
            configured_mode: this.cfg.configured_mode,
            effective_mode: 'firestore',
            durable: this.db != null && this.health.connected,
            queue_depth: this.queue.depth,
            queue_pressure: this.queue.pressure(),
            max_queue_depth: this.queue.maxQueueDepth,
            write_latency: latency,
            last_write_latency_ms:
                this.health.last_write_latency_ms ?? latency.max_ms,
            env_conflict: this.cfg.env_conflict,
            firestore_initialized: this.health.initialized,
            firebase_status: getFirebaseStatus(),
        });
    }

    appendUpdate(outcome: SignalOutcome): void {
        // Never writes strategy_signals — outcome-only
        this.cache.set(outcome.signal_id, structuredClone(outcome));
        this.pruneCache();
        if (!this.db) {
            this.health.write_failure_count += 1;
            this.health.last_error =
                getAdminInitError() ?? 'Firestore unavailable';
            return;
        }
        const ok = this.queue.enqueue(async () => {
            try {
                await this.db!
                    .collection(SIGNAL_OUTCOMES_COLLECTION)
                    .doc(outcome.signal_id)
                    .set(outcomeToFirestoreDoc(outcome), { merge: true });
                this.health.write_success_count += 1;
                this.health.last_outcome_write_at = new Date().toISOString();
                this.health.connected = true;
                markFirestoreOpSuccess();
            } catch (err) {
                this.health.write_failure_count += 1;
                this.health.last_error =
                    err instanceof Error ? err.message : String(err);
                this.health.connected = false;
                markFirestoreOpFailure(this.health.last_error);
            }
        });
        if (!ok) {
            this.health.write_failure_count += 1;
            this.health.last_error = 'outcome queue full';
        }
    }

    /** Bound the process cache; dual mode falls back to JSONL on a miss. */
    private pruneCache(): void {
        if (this.cache.size <= CACHE_MAX) return;
        const oldest = [...this.cache.values()]
            .sort((a, b) => a.signal_time.localeCompare(b.signal_time))
            .slice(0, this.cache.size - CACHE_KEEP);
        for (const o of oldest) this.cache.delete(o.signal_id);
    }

    findBySignalId(signalId: string): SignalOutcome | null {
        const o = this.cache.get(signalId);
        return o ? structuredClone(o) : null;
    }

    listByDate(ymd: string): SignalOutcome[] {
        return [...this.cache.values()].filter(
            (o) => taipeiYmd(o.signal_time) === ymd,
        );
    }

    listByType(type: SignalType, ymd?: string): SignalOutcome[] {
        return (ymd ? this.listByDate(ymd) : [...this.cache.values()]).filter(
            (o) => o.signal_type === type,
        );
    }

    listRange(fromYmd: string, toYmd: string): SignalOutcome[] {
        return this.materializeRange(fromYmd, toYmd);
    }

    materializeRange(fromYmd: string, toYmd: string): SignalOutcome[] {
        return [...this.cache.values()].filter((o) => {
            const d = taipeiYmd(o.signal_time);
            return d >= fromYmd && d <= toYmd;
        });
    }

    async materializeRangeAsync(
        fromYmd: string,
        toYmd: string,
        limit = 200,
    ): Promise<SignalOutcome[]> {
        if (!this.db) return this.materializeRange(fromYmd, toYmd);
        try {
            const qs = await this.db
                .collection(SIGNAL_OUTCOMES_COLLECTION)
                .where('signal_time', '>=', `${fromYmd}T00:00:00.000Z`)
                .where('signal_time', '<=', `${toYmd}T23:59:59.999Z`)
                .orderBy('signal_time', 'desc')
                .limit(limit)
                .get();
            const out: SignalOutcome[] = [];
            for (const doc of qs.docs) {
                const o = firestoreDocToOutcome(
                    doc.data() as Record<string, unknown>,
                );
                this.cache.set(o.signal_id, o);
                out.push(o);
            }
            this.pruneCache();
            return out;
        } catch (err) {
            this.health.last_error =
                err instanceof Error ? err.message : String(err);
            return this.materializeRange(fromYmd, toYmd);
        }
    }

    async flush(): Promise<void> {
        await this.queue.flush();
    }
}
