// server/src/lib/historical-replay/replay-market-source.ts
// No Shioaji. Emits BarEvent only — never fake Trade/BidAsk from 1m OHLC.
// Apply only at known_at; batch helpers for atomic minute updates.

import type { Clock } from '../market-runtime/clock.ts';
import type {
    BarEvent,
    MarketEventHandler,
    MarketSnapshot,
    MarketSource,
    Unsubscribe,
} from '../market-runtime/market-source.ts';
import type { DayBars, MinuteBar } from './historical-data-loader.ts';
import type { ReplayClock } from './replay-clock.ts';

function toBarEvent(b: MinuteBar, isIndex: boolean): BarEvent {
    return {
        type: 'bar',
        symbol: b.symbol,
        bar_start: b.bar_start,
        bar_end: b.bar_end,
        known_at: b.known_at,
        timestamp: b.known_at,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        amount: b.amount,
        amount_available: b.amount_available,
        gap_kind: b.gap_kind,
        is_index: isIndex,
    };
}

export class ReplayMarketSource implements MarketSource {
    readonly mode = 'replay' as const;
    readonly dataResolution = '1m' as const;
    private handlers = new Set<MarketEventHandler>();
    private stockWatch = new Set<string>();
    private indexWatch = new Set<string>();
    private bySymbol = new Map<string, MinuteBar[]>();
    private indexSymbols = new Set<string>();
    private lastEmittedKnownAt = new Map<string, number>();

    constructor(
        private clock: ReplayClock,
        private getWallClock: Clock = clock,
    ) {}

    loadDayData(stocks: DayBars[], indexes: DayBars[] = []): void {
        this.bySymbol.clear();
        this.indexSymbols.clear();
        for (const d of stocks) this.bySymbol.set(d.symbol, d.bars);
        for (const d of indexes) {
            this.bySymbol.set(d.symbol, d.bars);
            this.indexSymbols.add(d.symbol);
        }
        this.lastEmittedKnownAt.clear();
    }

    /** All distinct known_at values in [from, to], sorted. */
    knownAtTimeline(fromMs: number, toMs: number): number[] {
        const set = new Set<number>();
        for (const bars of this.bySymbol.values()) {
            for (const b of bars) {
                if (b.known_at >= fromMs && b.known_at <= toMs) {
                    set.add(b.known_at);
                }
            }
        }
        return [...set].sort((a, b) => a - b);
    }

    /**
     * Bars whose known_at equals exactly this clock step.
     * Sorted by symbol for deterministic apply order.
     */
    barsForKnownAt(knownAt: number): MinuteBar[] {
        const out: MinuteBar[] = [];
        for (const bars of this.bySymbol.values()) {
            for (const b of bars) {
                if (b.known_at === knownAt) out.push(b);
            }
        }
        out.sort((a, b) => a.symbol.localeCompare(b.symbol));
        return out;
    }

    /** Emit entire known_at batch (atomic minute). */
    emitBatchAtKnownAt(knownAt: number): BarEvent[] {
        const bars = this.barsForKnownAt(knownAt);
        const emitted: BarEvent[] = [];
        for (const b of bars) {
            if (this.lastEmittedKnownAt.get(b.symbol) === b.known_at) continue;
            const watched =
                this.stockWatch.size + this.indexWatch.size === 0 ||
                this.stockWatch.has(b.symbol) ||
                this.indexWatch.has(b.symbol);
            if (!watched) continue;
            const ev = toBarEvent(b, this.indexSymbols.has(b.symbol));
            this.lastEmittedKnownAt.set(b.symbol, b.known_at);
            emitted.push(ev);
            for (const h of this.handlers) h(ev);
        }
        return emitted;
    }

    async start(): Promise<void> {
        this.clock.start();
    }

    async stop(): Promise<void> {
        this.handlers.clear();
        this.clock.stop();
    }

    async subscribeStocks(symbols: string[]): Promise<void> {
        for (const s of symbols) {
            if (s.trim()) this.stockWatch.add(s.trim());
        }
    }

    async unsubscribeStocks(symbols: string[]): Promise<void> {
        for (const s of symbols) this.stockWatch.delete(s.trim());
    }

    async subscribeIndexes(symbols: string[]): Promise<void> {
        for (const s of symbols) {
            if (s.trim()) this.indexWatch.add(s.trim());
        }
    }

    async unsubscribeIndexes(symbols: string[]): Promise<void> {
        for (const s of symbols) this.indexWatch.delete(s.trim());
    }

    async getSnapshot(symbol: string): Promise<MarketSnapshot | null> {
        const bars = this.bySymbol.get(symbol);
        if (!bars?.length) return null;
        const now = this.clock.now().getTime();
        let last: MinuteBar | null = null;
        let cumVol = 0;
        let cumAmt = 0;
        let open = 0;
        let high = 0;
        let low = 0;
        for (const b of bars) {
            if (b.known_at > now) break;
            last = b;
            if (!open) open = b.open;
            high = Math.max(high, b.high);
            low = low > 0 ? Math.min(low, b.low) : b.low;
            cumVol += b.volume;
            cumAmt += b.amount_available ? b.amount : 0;
        }
        if (!last) return null;
        return {
            symbol,
            last_price: last.close,
            open,
            high,
            low,
            prev_close: 0,
            total_volume: cumVol,
            total_amount: cumAmt,
            average_price: cumVol > 0 && cumAmt > 0 ? cumAmt / cumVol : 0,
            best_bid: 0,
            best_ask: 0,
            timestamp: last.known_at,
        };
    }

    getCurrentTime(): Date {
        return this.getWallClock.now();
    }

    onMarketEvent(handler: MarketEventHandler): Unsubscribe {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }
}
