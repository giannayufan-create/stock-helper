// server/src/lib/market-runtime/subscription-manager.ts
// Ref-counted upstream subscriptions. UI SSE must NOT use this.

import type { SubscriptionConsumer } from './types.ts';

export type SubscribeFn = (symbols: string[]) => Promise<void>;
export type UnsubscribeFn = (symbols: string[]) => Promise<void>;

export class SubscriptionManager {
    /** symbol → set of consumers currently holding */
    private holders = new Map<string, Set<SubscriptionConsumer>>();

    refCount(symbol: string): number {
        return this.holders.get(symbol)?.size ?? 0;
    }

    consumersOf(symbol: string): SubscriptionConsumer[] {
        return [...(this.holders.get(symbol) ?? [])];
    }

    /**
     * Idempotent: same (symbol, consumer) twice does not double-count
     * and does not re-subscribe if already held by anyone.
     */
    async acquire(
        symbol: string,
        consumer: SubscriptionConsumer,
        subscribe: SubscribeFn,
    ): Promise<void> {
        const code = symbol.trim();
        if (!code) return;

        let set = this.holders.get(code);
        if (!set) {
            set = new Set();
            this.holders.set(code, set);
        }

        const alreadyHadConsumer = set.has(consumer);
        const wasEmpty = set.size === 0;

        if (!alreadyHadConsumer) {
            set.add(consumer);
        }

        // Only first holder for this symbol triggers upstream subscribe
        if (wasEmpty) {
            await subscribe([code]);
        }
    }

    async release(
        symbol: string,
        consumer: SubscriptionConsumer,
        unsubscribe: UnsubscribeFn,
    ): Promise<void> {
        const code = symbol.trim();
        if (!code) return;

        const set = this.holders.get(code);
        if (!set || !set.has(consumer)) {
            // idempotent no-op
            return;
        }

        set.delete(consumer);
        if (set.size === 0) {
            this.holders.delete(code);
            await unsubscribe([code]);
        }
    }

    async acquireMany(
        symbols: string[],
        consumer: SubscriptionConsumer,
        subscribe: SubscribeFn,
    ): Promise<void> {
        const unique = [...new Set(symbols.map((s) => s.trim()).filter(Boolean))];
        const needUpstream: string[] = [];

        for (const code of unique) {
            let set = this.holders.get(code);
            if (!set) {
                set = new Set();
                this.holders.set(code, set);
            }
            const wasEmpty = set.size === 0;
            set.add(consumer);
            if (wasEmpty) needUpstream.push(code);
        }

        if (needUpstream.length) {
            await subscribe(needUpstream);
        }
    }

    async releaseMany(
        symbols: string[],
        consumer: SubscriptionConsumer,
        unsubscribe: UnsubscribeFn,
    ): Promise<void> {
        const unique = [...new Set(symbols.map((s) => s.trim()).filter(Boolean))];
        const dropUpstream: string[] = [];

        for (const code of unique) {
            const set = this.holders.get(code);
            if (!set || !set.has(consumer)) continue;
            set.delete(consumer);
            if (set.size === 0) {
                this.holders.delete(code);
                dropUpstream.push(code);
            }
        }

        if (dropUpstream.length) {
            await unsubscribe(dropUpstream);
        }
    }

    /** Test / debug helper */
    snapshot(): Record<string, SubscriptionConsumer[]> {
        const out: Record<string, SubscriptionConsumer[]> = {};
        for (const [k, v] of this.holders) {
            out[k] = [...v];
        }
        return out;
    }
}
