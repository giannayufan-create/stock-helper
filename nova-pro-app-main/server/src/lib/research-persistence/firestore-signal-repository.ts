// server/src/lib/research-persistence/firestore-signal-repository.ts
// Firestore strategy_signals/{signal_id} — immutable; non-blocking writes via queue.

import type { Firestore } from 'firebase-admin/firestore';
import type { SignalType, StrategySignal } from '../strategy-signal/types.ts';
import type { StrategySignalRepository } from '../strategy-signal/repository.ts';
import { getResearchFirestore, getAdminInitError } from './admin.ts';
import {
    firestoreDocToSignal,
    signalToFirestoreDoc,
} from './codec.ts';
import type { ResearchPersistenceConfig } from './config.ts';
import { loadResearchPersistenceConfig } from './config.ts';
import { signalIdentityHash, signalsContentEqual } from './hash.ts';
import { PersistenceHealthTracker } from './health-tracker.ts';
import { ResearchPersistenceQueue } from './queue.ts';
import {
    STRATEGY_SIGNALS_COLLECTION,
    type PersistResult,
    type ResearchPersistenceHealth,
} from './types.ts';

function taipeiYmd(iso?: string): string {
    const d = iso ? new Date(iso) : new Date();
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

export class FirestoreStrategySignalRepository
    implements StrategySignalRepository
{
    private cache = new Map<string, StrategySignal>();
    private known = new Set<string>();
    private hashes = new Map<string, string>();
    readonly health = new PersistenceHealthTracker();
    readonly queue: ResearchPersistenceQueue;
    private db: Firestore | null;
    private cfg: ResearchPersistenceConfig;
    lastPersistResult: PersistResult | null = null;

    constructor(
        db?: Firestore | null,
        cfg: ResearchPersistenceConfig = loadResearchPersistenceConfig(),
    ) {
        this.cfg = cfg;
        this.db = db === undefined ? getResearchFirestore() : db;
        this.health.connected = this.db != null;
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
        return this.health.snapshot({
            provider: 'FIRESTORE',
            configured_mode: this.cfg.configured_mode,
            effective_mode: 'firestore',
            durable: this.db != null && this.health.connected,
            queue_depth: this.queue.depth,
            queue_pressure: this.queue.pressure(),
            max_queue_depth: this.queue.maxQueueDepth,
            write_latency: this.queue.latencyStats(),
            env_conflict: this.cfg.env_conflict,
            firestore_initialized: this.health.initialized,
        });
    }

    /**
     * Non-blocking: update local cache immediately; enqueue Firestore write.
     * Does not throw on Firestore latency — conflicts still throw when known locally.
     */
    save(signal: StrategySignal): void {
        const existing = this.cache.get(signal.signal_id);
        if (existing || this.known.has(signal.signal_id)) {
            const prev = existing ?? this.cache.get(signal.signal_id);
            if (prev && signalsContentEqual(prev, signal)) {
                this.lastPersistResult = 'SKIP_IDEMPOTENT';
                return;
            }
            if (prev) {
                this.lastPersistResult = 'CONFLICT';
                this.health.conflict_count += 1;
                this.health.write_failure_count += 1;
                this.health.last_error = `CONFLICT ${signal.signal_id}`;
                console.error(
                    `[research-persistence] CONFLICT immutable signal ${signal.signal_id}`,
                );
                throw new Error(
                    `feature_snapshot immutable: signal ${signal.signal_id} conflict`,
                );
            }
        }

        // Local durable-for-process cache (PIT snapshot frozen as provided)
        this.cache.set(signal.signal_id, structuredClone(signal));
        this.known.add(signal.signal_id);
        this.hashes.set(signal.signal_id, signalIdentityHash(signal));
        this.lastPersistResult = 'QUEUED';

        if (!this.db) {
            this.health.write_failure_count += 1;
            this.health.last_error =
                getAdminInitError() ?? 'Firestore unavailable';
            // Degraded: keep memory; do not crash strategy path
            return;
        }

        const ok = this.queue.enqueue(async () => {
            await this.writeImmutable(signal);
        });
        if (!ok) {
            this.health.write_failure_count += 1;
            this.health.last_error = 'persistence queue full — write not accepted';
            console.error(
                '[research-persistence] queue CRITICAL — signal write rejected (not silent)',
            );
        }
    }

    private async writeImmutable(signal: StrategySignal): Promise<void> {
        if (!this.db) return;
        const ref = this.db
            .collection(STRATEGY_SIGNALS_COLLECTION)
            .doc(signal.signal_id);
        try {
            const snap = await ref.get();
            const hash = signalIdentityHash(signal);
            if (snap.exists) {
                const remote = firestoreDocToSignal(
                    snap.data() as Record<string, unknown>,
                );
                if (signalsContentEqual(remote, signal)) {
                    this.lastPersistResult = 'SKIP_IDEMPOTENT';
                    this.health.write_success_count += 1;
                    return;
                }
                this.lastPersistResult = 'CONFLICT';
                this.health.conflict_count += 1;
                this.health.write_failure_count += 1;
                this.health.last_error = `CONFLICT remote ${signal.signal_id}`;
                console.error(
                    `[research-persistence] CONFLICT remote immutable ${signal.signal_id}`,
                );
                return; // do not overwrite
            }
            const doc = signalToFirestoreDoc(signal);
            doc.identity_hash = hash;
            await ref.create(doc);
            this.lastPersistResult = 'CREATED';
            this.health.write_success_count += 1;
            this.health.last_signal_write_at = new Date().toISOString();
            this.health.connected = true;
        } catch (err) {
            this.health.write_failure_count += 1;
            this.health.last_error =
                err instanceof Error ? err.message : String(err);
            this.health.connected = false;
        }
    }

    findById(signalId: string): StrategySignal | null {
        if (this.cache.has(signalId)) {
            return structuredClone(this.cache.get(signalId)!);
        }
        return null;
    }

    async findByIdAsync(signalId: string): Promise<StrategySignal | null> {
        const local = this.findById(signalId);
        if (local) return local;
        if (!this.db) return null;
        try {
            const snap = await this.db
                .collection(STRATEGY_SIGNALS_COLLECTION)
                .doc(signalId)
                .get();
            if (!snap.exists) return null;
            const s = firestoreDocToSignal(snap.data() as Record<string, unknown>);
            this.cache.set(s.signal_id, s);
            this.known.add(s.signal_id);
            return structuredClone(s);
        } catch (err) {
            this.health.last_error =
                err instanceof Error ? err.message : String(err);
            return null;
        }
    }

    listByDate(ymd: string): StrategySignal[] {
        return [...this.cache.values()].filter(
            (s) => taipeiYmd(s.signal_time) === ymd,
        );
    }

    listByType(type: SignalType, ymd?: string): StrategySignal[] {
        return (ymd ? this.listByDate(ymd) : [...this.cache.values()]).filter(
            (s) => s.signal_type === type,
        );
    }

    listRange(fromYmd: string, toYmd: string): StrategySignal[] {
        return [...this.cache.values()]
            .filter((s) => {
                const d = taipeiYmd(s.signal_time);
                return d >= fromYmd && d <= toYmd;
            })
            .sort((a, b) => b.signal_time.localeCompare(a.signal_time));
    }

    async listRangeAsync(
        fromYmd: string,
        toYmd: string,
        opts: { limit?: number } = {},
    ): Promise<StrategySignal[]> {
        if (!this.db) return this.listRange(fromYmd, toYmd);
        const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
        try {
            const fromIso = `${fromYmd}T00:00:00.000Z`;
            const toIso = `${toYmd}T23:59:59.999Z`;
            const qs = await this.db
                .collection(STRATEGY_SIGNALS_COLLECTION)
                .where('signal_time', '>=', fromIso)
                .where('signal_time', '<=', toIso)
                .orderBy('signal_time', 'desc')
                .limit(limit)
                .get();
            const out: StrategySignal[] = [];
            for (const doc of qs.docs) {
                const s = firestoreDocToSignal(doc.data() as Record<string, unknown>);
                this.cache.set(s.signal_id, s);
                this.known.add(s.signal_id);
                out.push(s);
            }
            this.health.connected = true;
            return out;
        } catch (err) {
            this.health.last_error =
                err instanceof Error ? err.message : String(err);
            this.health.connected = false;
            return this.listRange(fromYmd, toYmd);
        }
    }

    knownIds(): Set<string> {
        return new Set(this.known);
    }

    hydrateKnownIds(): void {
        // sync no-op; call hydrateAsync at boot
    }

    async hydrateAsync(lookbackDays = 30): Promise<void> {
        if (!this.db) return;
        const to = new Date();
        const from = new Date(to.getTime() - lookbackDays * 86400_000);
        const fromYmd = taipeiYmd(from.toISOString());
        const toYmd = taipeiYmd(to.toISOString());
        await this.listRangeAsync(fromYmd, toYmd, { limit: 500 });
    }

    async flush(): Promise<void> {
        await this.queue.flush();
    }
}
