// server/src/sse/subscriptions.ts — UI SSE client registry.
// Owns UI_VIEW demand via MarketRuntime — NEVER calls market.unsubscribe.

import type { MarketRuntime } from '../lib/market-runtime/service.ts';
import type {
    ContractKey,
    StreamQuoteType,
} from '../providers/market-data.ts';

interface Entry {
    key: ContractKey;
    quote: StreamQuoteType;
}

/**
 * Downstream UI SSE subscription registry.
 * Upstream ownership goes through MarketRuntime.acquireStocks/releaseStocks
 * with consumer UI_VIEW — never MarketManager.unsubscribe.
 */
export class SubscriptionRegistry {
    private entries = new Map<string, Entry>();
    /** symbol → number of local (code:quote) entries still held */
    private symbolRefs = new Map<string, number>();

    constructor(private runtime: MarketRuntime) {}

    private id(key: ContractKey, quote: StreamQuoteType): string {
        return `${key.code}:${quote}`;
    }

    async subscribe(key: ContractKey, quote: StreamQuoteType): Promise<void> {
        const id = this.id(key, quote);
        if (this.entries.has(id)) return; // idempotent replay

        const code = key.code.trim();
        const prev = this.symbolRefs.get(code) ?? 0;
        this.entries.set(id, { key, quote });
        this.symbolRefs.set(code, prev + 1);

        if (prev === 0) {
            try {
                await this.runtime.acquireStocks([code], 'UI_VIEW');
            } catch (err) {
                this.entries.delete(id);
                this.symbolRefs.set(code, prev);
                if (prev === 0) this.symbolRefs.delete(code);
                throw err;
            }
        }
    }

    async unsubscribe(
        key: ContractKey,
        quote: StreamQuoteType,
    ): Promise<void> {
        const id = this.id(key, quote);
        if (!this.entries.delete(id)) return;

        const code = key.code.trim();
        const next = (this.symbolRefs.get(code) ?? 1) - 1;
        if (next <= 0) {
            this.symbolRefs.delete(code);
            await this.runtime.releaseStocks([code], 'UI_VIEW');
        } else {
            this.symbolRefs.set(code, next);
        }
    }

    count(): number {
        return this.entries.size;
    }
}
