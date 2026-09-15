// server/src/lib/market-runtime/market-source.ts
// B/C must not know if source is live Shioaji or historical replay.

export type MarketSourceMode = 'live' | 'replay';
export type MarketDataResolution = 'tick' | '1m';

export type Unsubscribe = () => void;

export interface MarketSnapshot {
    symbol: string;
    last_price: number;
    open: number;
    high: number;
    low: number;
    prev_close: number;
    total_volume: number;
    total_amount: number;
    average_price: number;
    best_bid: number;
    best_ask: number;
    timestamp: number;
}

export interface BarEvent {
    type: 'bar';
    symbol: string;
    bar_start: number;
    bar_end: number;
    /** Clock must be >= known_at before apply/evaluate. */
    known_at: number;
    /** @deprecated alias of known_at for event routing */
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    amount: number;
    amount_available: boolean;
    gap_kind?: 'NO_TRADE' | 'DATA_MISSING';
    is_index?: boolean;
}

export interface QuoteEvent {
    type: 'quote';
    symbol: string;
    timestamp: number;
    last_price: number;
    open: number;
    high: number;
    low: number;
    total_volume: number;
    total_amount: number;
}

export interface TradeEvent {
    type: 'trade';
    symbol: string;
    timestamp: number;
    price: number;
    volume: number;
    total_volume: number;
    total_amount: number;
    avg_price: number;
}

export interface BidAskEvent {
    type: 'bidask';
    symbol: string;
    timestamp: number;
    best_bid: number;
    best_ask: number;
    bid_volume: number;
    ask_volume: number;
}

export interface IndexEvent {
    type: 'index';
    symbol: string;
    timestamp: number;
    last_price: number;
    open: number;
    high: number;
    low: number;
    change_pct: number | null;
}

export type MarketEvent =
    | BarEvent
    | QuoteEvent
    | TradeEvent
    | BidAskEvent
    | IndexEvent;

export type MarketEventHandler = (event: MarketEvent) => void;

export interface MarketSource {
    readonly mode: MarketSourceMode;
    readonly dataResolution: MarketDataResolution;

    start(): Promise<void>;
    stop(): Promise<void>;

    subscribeStocks(symbols: string[]): Promise<void>;
    unsubscribeStocks(symbols: string[]): Promise<void>;

    subscribeIndexes(symbols: string[]): Promise<void>;
    unsubscribeIndexes(symbols: string[]): Promise<void>;

    getSnapshot(symbol: string): Promise<MarketSnapshot | null>;

    getCurrentTime(): Date;

    onMarketEvent(handler: MarketEventHandler): Unsubscribe;
}
