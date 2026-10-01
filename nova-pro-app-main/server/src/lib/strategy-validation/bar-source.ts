// server/src/lib/strategy-validation/bar-source.ts
// 1m bars for validation, from the market provider via HistoricalDataLoader.
// Completed sessions are cached on disk so each symbol/day is fetched once.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DayBars } from '../historical-replay/historical-data-loader.ts';
import { tickSize } from '../open-gate-v2/risk-gate.ts';
import type { PriceBar } from './types.ts';

export interface ValidationBarSource {
    /** null = bars or prior close unavailable; caller must treat as insufficient data. */
    loadDay(date: string, symbol: string): Promise<PriceBar[] | null>;
}

export interface BarSourceDeps {
    loadStockDay(date: string, symbol: string): Promise<DayBars>;
    prevClose(symbol: string, date: string): Promise<number | null>;
    cacheDir: string;
    nowMs?: () => number;
}

/** TW cash limit-up: prior close +10%, rounded down to a valid tick. */
export function twLimitUpPrice(prevClose: number): number {
    const raw = prevClose * 1.1;
    const t = tickSize(raw);
    return Math.round(Math.floor(raw / t + 1e-9) * t * 100) / 100;
}

export function toPriceBars(day: DayBars, prevClose: number): PriceBar[] {
    const limit = twLimitUpPrice(prevClose);
    return day.bars.map((b) => ({
        t: b.known_at,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        limit_up: b.low >= limit - 1e-9,
        no_liquidity: b.gap_kind != null || !(b.volume > 0),
    }));
}

/** Session end + 5 min (13:35 Taipei) — bars are final after this. */
function sessionFinal(date: string, nowMs: number): boolean {
    return nowMs >= Date.parse(`${date}T13:35:00+08:00`);
}

const MISS_RETRY_MS = 10 * 60 * 1000;
const MISS_MAX = 300;

export class CachedValidationBarSource implements ValidationBarSource {
    private now: () => number;
    private missAt = new Map<string, number>();

    constructor(private deps: BarSourceDeps) {
        this.now = deps.nowMs ?? Date.now;
    }

    private cachePath(date: string, symbol: string): string {
        return join(this.deps.cacheDir, date, `${symbol}.json`);
    }

    async loadDay(date: string, symbol: string): Promise<PriceBar[] | null> {
        // Intraday kbars count against a small per-session broker cap; wait for the close.
        if (!sessionFinal(date, this.now())) return null;
        const key = `${date}:${symbol}`;
        const missed = this.missAt.get(key);
        if (missed != null && this.now() - missed < MISS_RETRY_MS) return null;
        const bars = await this.fetchDay(date, symbol);
        if (bars) {
            this.missAt.delete(key);
        } else {
            if (this.missAt.size >= MISS_MAX) this.missAt.clear();
            this.missAt.set(key, this.now());
        }
        return bars;
    }

    private async fetchDay(date: string, symbol: string): Promise<PriceBar[] | null> {
        const path = this.cachePath(date, symbol);
        if (existsSync(path)) {
            try {
                return JSON.parse(readFileSync(path, 'utf8')) as PriceBar[];
            } catch {
                /* corrupt cache — refetch */
            }
        }
        let day: DayBars;
        let prev: number | null;
        try {
            [day, prev] = await Promise.all([
                this.deps.loadStockDay(date, symbol),
                this.deps.prevClose(symbol, date),
            ]);
        } catch {
            return null;
        }
        if (!(prev != null && prev > 0) || !day.bars.length) return null;
        const bars = toPriceBars(day, prev);
        try {
            mkdirSync(join(this.deps.cacheDir, date), { recursive: true });
            writeFileSync(path, JSON.stringify(bars), 'utf8');
        } catch {
            /* cache is best-effort */
        }
        return bars;
    }
}
