// server/src/lib/research-persistence/queue.ts
// Bounded async persistence queue — never blocks MarketRuntime / B / C / BP.

import type { QueuePressure } from './types.ts';

export type QueueJob = () => Promise<void>;

export class ResearchPersistenceQueue {
    private q: QueueJob[] = [];
    private running = false;
    private dropped = 0;

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

    pressure(): QueuePressure {
        if (this.q.length >= this.criticalDepth) return 'CRITICAL';
        if (this.q.length >= this.warnDepth) return 'WARNING';
        return 'NORMAL';
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
        this.q.push(job);
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
