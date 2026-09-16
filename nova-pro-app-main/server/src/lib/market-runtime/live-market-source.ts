// server/src/lib/market-runtime/live-market-source.ts
// Wraps Shioaji/Fugle MarketManager — MarketRuntime must not know provider details.

import type { MarketManager } from '../../providers/manager.ts';
import { PreOpenBuffer } from '../market-context/gap-layers/preopen-buffer.ts';
import type { Clock } from './clock.ts';
import type {
    MarketEventHandler,
    MarketSnapshot,
    MarketSource,
    Unsubscribe,
} from './market-source.ts';

export class LiveMarketSource implements MarketSource {
    readonly mode = 'live' as const;
    readonly dataResolution = 'tick' as const;
    private handlers = new Set<MarketEventHandler>();
    private started = false;
    private stockWatch = new Set<string>();
    private indexWatch = new Set<string>();

    constructor(
        private market: MarketManager,
        private clock: Clock,
    ) {}

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        // Tick/BidAsk → Trade/BidAsk events for any listeners (engine still hooks manager directly in live path)
        this.market.onTick((_ch, tick) => {
            if (tick.simtrade) {
                // Auction context only — never feed strategy engine.
                PreOpenBuffer.noteTick({
                    symbol: tick.code,
                    t: this.clock.now().getTime(),
                    price: Number(tick.close) || 0,
                    volume: Number(tick.volume) || 0,
                    total_volume: Number(tick.total_volume) || 0,
                    simtrade: true,
                });
                return;
            }
            for (const h of this.handlers) {
                h({
                    type: 'trade',
                    symbol: tick.code,
                    timestamp: this.clock.now().getTime(),
                    price: Number(tick.close) || 0,
                    volume: Number(tick.volume) || 0,
                    total_volume: Number(tick.total_volume) || 0,
                    total_amount: Number(tick.total_amount) || 0,
                    avg_price: Number(tick.avg_price) || 0,
                });
            }
        });
        this.market.onBidAsk((_ch, ba) => {
            if (ba.simtrade) {
                PreOpenBuffer.noteBidAsk({
                    symbol: ba.code,
                    t: this.clock.now().getTime(),
                    bid_prices: (ba.bid_price ?? []).map(Number).filter((n) => n > 0),
                    ask_prices: (ba.ask_price ?? []).map(Number).filter((n) => n > 0),
                    bid_volumes: (ba.bid_volume ?? []).map(Number),
                    ask_volumes: (ba.ask_volume ?? []).map(Number),
                    simtrade: true,
                });
                return;
            }
            for (const h of this.handlers) {
                h({
                    type: 'bidask',
                    symbol: ba.code,
                    timestamp: this.clock.now().getTime(),
                    best_bid: Number(ba.bid_price?.[0]) || 0,
                    best_ask: Number(ba.ask_price?.[0]) || 0,
                    bid_volume: Number(ba.bid_volume?.[0]) || 0,
                    ask_volume: Number(ba.ask_volume?.[0]) || 0,
                });
            }
        });
    }

    async stop(): Promise<void> {
        this.started = false;
        this.handlers.clear();
    }

    async subscribeStocks(symbols: string[]): Promise<void> {
        await this.start();
        for (const raw of symbols) {
            const symbol = raw.trim();
            if (!symbol || this.stockWatch.has(symbol)) continue;
            this.stockWatch.add(symbol);
            const key = {
                code: symbol,
                security_type: 'STK' as const,
                exchange: null,
            };
            await this.market.subscribe(key, 'Tick');
            await this.market.subscribe(key, 'BidAsk');
        }
    }

    async unsubscribeStocks(symbols: string[]): Promise<void> {
        for (const raw of symbols) {
            const symbol = raw.trim();
            if (!symbol || !this.stockWatch.has(symbol)) continue;
            this.stockWatch.delete(symbol);
            const key = {
                code: symbol,
                security_type: 'STK' as const,
                exchange: null,
            };
            try {
                await this.market.unsubscribe(key, 'Tick');
                await this.market.unsubscribe(key, 'BidAsk');
            } catch {
                /* best-effort */
            }
        }
    }

    async subscribeIndexes(symbols: string[]): Promise<void> {
        await this.start();
        for (const raw of symbols) {
            const symbol = raw.trim();
            if (!symbol || this.indexWatch.has(symbol)) continue;
            this.indexWatch.add(symbol);
            try {
                await this.market.subscribe(
                    {
                        code: symbol,
                        security_type: 'IND' as const,
                        exchange: null,
                    },
                    'Tick',
                );
            } catch {
                try {
                    await this.market.subscribe(
                        {
                            code: symbol,
                            security_type: 'STK' as const,
                            exchange: null,
                        },
                        'Tick',
                    );
                } catch {
                    /* soft fail */
                }
            }
        }
    }

    async unsubscribeIndexes(symbols: string[]): Promise<void> {
        for (const raw of symbols) {
            const symbol = raw.trim();
            if (!symbol || !this.indexWatch.has(symbol)) continue;
            this.indexWatch.delete(symbol);
            try {
                await this.market.unsubscribe(
                    {
                        code: symbol,
                        security_type: 'IND' as const,
                        exchange: null,
                    },
                    'Tick',
                );
            } catch {
                /* best-effort */
            }
        }
    }

    async getSnapshot(symbol: string): Promise<MarketSnapshot | null> {
        try {
            const snaps = await this.market.snapshots([
                {
                    code: symbol,
                    security_type: 'STK',
                    exchange: null,
                },
            ]);
            const s = snaps[0];
            if (!s) return null;
            return {
                symbol: s.code,
                last_price: Number(s.close) || 0,
                open: Number(s.open) || 0,
                high: Number(s.high) || 0,
                low: Number(s.low) || 0,
                prev_close: 0,
                total_volume: Number(s.total_volume) || 0,
                total_amount: Number(s.total_amount) || 0,
                average_price: Number(s.average_price) || 0,
                best_bid: Number(s.buy_price) || 0,
                best_ask: Number(s.sell_price) || 0,
                timestamp: this.clock.now().getTime(),
            };
        } catch {
            return null;
        }
    }

    getCurrentTime(): Date {
        return this.clock.now();
    }

    onMarketEvent(handler: MarketEventHandler): Unsubscribe {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }
}
