// server/src/lib/research-persistence/queue.ts
// Bounded async persistence queue — never blocks MarketRuntime / B / C / BP.

import type { QueueLatencyStats, QueuePressure } from './types.ts';

export type QueueJob = () => Promise<void>;

export class ResearchPersistenceQueue {
    private q: QueueJob[] = [];
    private running = false;
    private dropped = 0;
    private maxDepthSeen = 0;
    private latenciesMs: number[] = [];
    private readonly latencyCap = 500;

    constructor(
        readonly maxDepth: number,
        readonly warnDepth: number,
        readonly criticalDepth: number,
    ) {}

    get depth(): number {
        return this.q.length;
    }

    get droppedCount(): number {
        return this.dropped;
    }

    get maxQueueDepth(): number {
        return this.maxDepthSeen;
    }

    pressure(): QueuePressure {
        if (this.q.length >= this.criticalDepth) return 'CRITICAL';
        if (this.q.length >= this.warnDepth) return 'WARNING';
        return 'NORMAL';
    }

    latencyStats(): QueueLatencyStats {
        const samples = this.latenciesMs;
        if (!samples.length) {
            return {
                sample_count: 0,
                avg_ms: null,
                p95_ms: null,
                max_ms: null,
                max_queue_depth: this.maxDepthSeen,
            };
        }
        const sorted = [...samples].sort((a, b) => a - b);
        const sum = sorted.reduce((a, b) => a + b, 0);
        const p95Idx = Math.min(
            sorted.length - 1,
            Math.floor(sorted.length * 0.95),
        );
        return {
            sample_count: sorted.length,
            avg_ms: Math.round((sum / sorted.length) * 10) / 10,
            p95_ms: sorted[p95Idx] ?? null,
            max_ms: sorted[sorted.length - 1] ?? null,
            max_queue_depth: this.maxDepthSeen,
        };
    }

    /**
     * Enqueue non-blocking. Returns false if at max (failure counted by caller).
     * Does NOT silently succeed when dropped.
     */
    enqueue(job: QueueJob): boolean {
        if (this.q.length >= this.maxDepth) {
            this.dropped += 1;
            return false;
        }
        this.q.push(async () => {
            const t0 = Date.now();
            try {
                await job();
            } finally {
                const ms = Date.now() - t0;
                this.latenciesMs.push(ms);
                if (this.latenciesMs.length > this.latencyCap) {
                    this.latenciesMs.splice(
                        0,
                        this.latenciesMs.length - this.latencyCap,
                    );
                }
            }
        });
        this.maxDepthSeen = Math.max(this.maxDepthSeen, this.q.length);
        void this.pump();
        return true;
    }

    private async pump(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            while (this.q.length) {
                const job = this.q.shift()!;
                try {
                    await job();
                } catch {
                    // caller job should record its own failure
                }
            }
        } finally {
            this.running = false;
            if (this.q.length) void this.pump();
        }
    }

    /** Test helper — drain queue. */
    async flush(timeoutMs = 5000): Promise<void> {
        const start = Date.now();
        while (this.q.length || this.running) {
            if (Date.now() - start > timeoutMs) break;
            await new Promise((r) => setTimeout(r, 10));
            void this.pump();
        }
    }
}
