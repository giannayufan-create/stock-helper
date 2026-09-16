// server/src/lib/market-context/gap-layers/preopen-buffer.ts
// Captures trial/simtrade quotes for auction context ONLY — never feeds C/BP/OpenGate.

export interface PreOpenTickSample {
    symbol: string;
    t: number;
    price: number;
    volume: number;
    total_volume: number;
    simtrade: true;
}

export interface PreOpenBookSample {
    symbol: string;
    t: number;
    bid_prices: number[];
    ask_prices: number[];
    bid_volumes: number[];
    ask_volumes: number[];
    simtrade: true;
}

const MAX = 400;
const ticks: PreOpenTickSample[] = [];
const books: PreOpenBookSample[] = [];

export const PreOpenBuffer = {
    noteTick(sample: PreOpenTickSample): void {
        ticks.push(sample);
        if (ticks.length > MAX) ticks.splice(0, ticks.length - MAX);
    },
    noteBidAsk(sample: PreOpenBookSample): void {
        books.push(sample);
        if (books.length > MAX) books.splice(0, books.length - MAX);
    },
    ticksSince(ms: number): PreOpenTickSample[] {
        return ticks.filter((x) => x.t >= ms);
    },
    booksSince(ms: number): PreOpenBookSample[] {
        return books.filter((x) => x.t >= ms);
    },
    clear(): void {
        ticks.length = 0;
        books.length = 0;
    },
    size(): { ticks: number; books: number } {
        return { ticks: ticks.length, books: books.length };
    },
};
