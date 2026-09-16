// Shared eval timing — one-line observe hooks only; never touches scores.

import type { EvalLatencyStats } from './types.ts';

type Bucket = number[];

const MAX_SAMPLES = 500;

export type EvalChannel = 'C' | 'BP' | 'Context' | 'B' | 'EI';

class EvalTimingRegistryImpl {
    private buckets = new Map<EvalChannel, Bucket>();

    note(channel: EvalChannel, ms: number): void {
        if (!Number.isFinite(ms) || ms < 0) return;
        let b = this.buckets.get(channel);
        if (!b) {
            b = [];
            this.buckets.set(channel, b);
        }
        b.push(ms);
        if (b.length > MAX_SAMPLES) b.splice(0, b.length - MAX_SAMPLES);
    }

    stats(channel: EvalChannel): EvalLatencyStats {
        const b = this.buckets.get(channel) ?? [];
        if (!b.length) {
            return { count: 0, avg_ms: null, p95_ms: null, max_ms: null };
        }
        const sorted = [...b].sort((a, c) => a - c);
        const sum = sorted.reduce((a, x) => a + x, 0);
        const p95idx = Math.min(
            sorted.length - 1,
            Math.max(0, Math.ceil(sorted.length * 0.95) - 1),
        );
        return {
            count: sorted.length,
            avg_ms: Math.round((sum / sorted.length) * 100) / 100,
            p95_ms: Math.round(sorted[p95idx]! * 100) / 100,
            max_ms: Math.round(sorted[sorted.length - 1]! * 100) / 100,
        };
    }

    reset(): void {
        this.buckets.clear();
    }
}

export const EvalTimingRegistry = new EvalTimingRegistryImpl();

export async function timedEval<T>(
    channel: EvalChannel,
    fn: () => Promise<T> | T,
): Promise<T> {
    const t0 = performance.now();
    try {
        return await fn();
    } finally {
        EvalTimingRegistry.note(channel, performance.now() - t0);
    }
}
