// Live / EOD limit-up board — read-only. Never mutates A/B/C/BP/Rank.

import type { MarketManager } from '../../providers/manager.ts';
import type { ScannerItem } from '../../types/dto.ts';
import { LIMIT_UP_PCT, isLimitUp } from '../board-attack/labels.ts';
import type { DailyBar } from '../board-attack/types.ts';
import {
    FinMindDailyPriceStore,
} from '../board-attack/finmind-daily.ts';
import {
    fetchTwMarketDayAll,
    isCommonEquityCode,
    type TwDayQuote,
} from '../tw-market-day.ts';

export interface LimitUpBoardItem {
    symbol: string;
    name: string;
    last_price: number | null;
    change_pct: number;
    change_price: number | null;
    volume: number | null;
    amount: number | null;
    market: 'tse' | 'otc' | null;
    open: number | null;
    high: number | null;
    low: number | null;
}

export interface LimitUpBoardDto {
    as_of: string;
    mode: 'live' | 'eod';
    source: 'scanner' | 'tw_openapi' | 'finmind';
    min_pct: number;
    count: number;
    items: LimitUpBoardItem[];
    warnings: string[];
}

function scannerChangePct(row: ScannerItem): number | null {
    // ChangePercentRank maps Fugle changePercent → rank_value
    if (Number.isFinite(row.rank_value)) return row.rank_value;
    const prev = row.close - row.change_price;
    if (!(prev > 0) || !Number.isFinite(row.change_price)) return null;
    return (row.change_price / prev) * 100;
}

function fromScanner(row: ScannerItem, pct: number): LimitUpBoardItem {
    return {
        symbol: row.code,
        name: row.name || row.code,
        last_price: row.close || null,
        change_pct: pct,
        change_price: row.change_price ?? null,
        volume: row.total_volume ?? null,
        amount: row.total_amount ?? null,
        market: null,
        open: row.open || null,
        high: row.high || null,
        low: row.low || null,
    };
}

function fromTw(q: TwDayQuote): LimitUpBoardItem | null {
    const prev = q.close - q.change;
    if (!(prev > 0)) return null;
    const pct = (q.change / prev) * 100;
    if (pct < LIMIT_UP_PCT) return null;
    if (!isCommonEquityCode(q.code)) return null;
    return {
        symbol: q.code,
        name: q.name || q.code,
        last_price: q.close,
        change_pct: pct,
        change_price: q.change,
        volume: q.volume / 1000,
        amount: q.amount,
        market: q.market,
        open: q.open,
        high: q.high,
        low: q.low,
    };
}

function sortItems(items: LimitUpBoardItem[]): LimitUpBoardItem[] {
    return [...items].sort((a, b) => b.change_pct - a.change_pct);
}

async function fromFinMind(date: string): Promise<LimitUpBoardItem[]> {
    const store = new FinMindDailyPriceStore();
    // need previous day closes — fetch a short window
    const day = await store.fetchDay(date);
    // previous trading day: walk back up to 5 calendar days
    let prevBars: DailyBar[] = [];
    for (let i = 1; i <= 5; i++) {
        const [y, m, d] = date.split('-').map(Number);
        const dt = new Date(Date.UTC(y!, m! - 1, d! - i));
        const ymd = dt.toISOString().slice(0, 10);
        prevBars = await store.fetchDay(ymd).catch(() => []);
        if (prevBars.length) break;
    }
    const prevMap = new Map(prevBars.map((b) => [b.symbol, b.close]));
    const out: LimitUpBoardItem[] = [];
    for (const b of day) {
        const prev = prevMap.get(b.symbol) ?? null;
        if (!isLimitUp(b, prev)) continue;
        const chg =
            prev && prev > 0 ? ((b.close - prev) / prev) * 100 : LIMIT_UP_PCT;
        out.push({
            symbol: b.symbol,
            name: b.symbol,
            last_price: b.close,
            change_pct: chg,
            change_price: prev != null ? b.close - prev : null,
            volume: b.volume,
            amount: b.amount,
            market: null,
            open: b.open,
            high: b.high,
            low: b.low,
        });
    }
    return sortItems(out);
}

export async function buildLimitUpBoard(
    market: MarketManager,
    opts: {
        mode?: 'live' | 'eod' | 'auto';
        date?: string;
        min_pct?: number;
        count?: number;
    } = {},
): Promise<LimitUpBoardDto> {
    const minPct = opts.min_pct ?? LIMIT_UP_PCT;
    const count = opts.count ?? 100;
    const warnings: string[] = [];
    const wantEod = opts.mode === 'eod' || (opts.mode === 'auto' && !!opts.date);

    if (wantEod && opts.date) {
        try {
            const items = await fromFinMind(opts.date);
            return {
                as_of: new Date().toISOString(),
                mode: 'eod',
                source: 'finmind',
                min_pct: minPct,
                count: items.length,
                items: items.slice(0, count),
                warnings,
            };
        } catch (err) {
            warnings.push(
                err instanceof Error
                    ? `FinMind: ${err.message}`
                    : 'FinMind unavailable',
            );
        }
    }

    const cacheKey = `live:${minPct}:${count}`;
    const hit = cacheGet(cacheKey);
    if (hit) return hit;

    // Live path: scanner ChangePercentRank
    try {
        const rows = await market.scanner('ChangePercentRank', 100, false);
        const items: LimitUpBoardItem[] = [];
        for (const row of rows) {
            if (!isCommonEquityCode(row.code)) continue;
            const pct = scannerChangePct(row);
            if (pct == null || pct < minPct) continue;
            items.push(fromScanner(row, pct));
        }
        if (items.length > 0) {
            const sorted = sortItems(items).slice(0, count);
            const dto: LimitUpBoardDto = {
                as_of: new Date().toISOString(),
                mode: 'live',
                source: 'scanner',
                min_pct: minPct,
                count: sorted.length,
                items: sorted,
                warnings,
            };
            cacheSet(cacheKey, dto);
            return dto;
        }
        warnings.push('scanner 無 ≥門檻標的，改用證交所日線');
    } catch (err) {
        warnings.push(
            err instanceof Error
                ? `scanner: ${err.message}`
                : 'scanner unavailable',
        );
    }

    // Fallback: TWSE/TPEx open data (session tape / EOD)
    try {
        const all = await fetchTwMarketDayAll();
        const items = sortItems(
            all.map(fromTw).filter((x): x is LimitUpBoardItem => x != null),
        ).filter((x) => x.change_pct >= minPct);
        const dto: LimitUpBoardDto = {
            as_of: new Date().toISOString(),
            mode: 'live',
            source: 'tw_openapi',
            min_pct: minPct,
            count: items.length,
            items: items.slice(0, count),
            warnings,
        };
        cacheSet(cacheKey, dto);
        return dto;
    } catch (err) {
        warnings.push(
            err instanceof Error
                ? `tw openapi: ${err.message}`
                : 'tw openapi failed',
        );
    }

    return {
        as_of: new Date().toISOString(),
        mode: 'live',
        source: 'scanner',
        min_pct: minPct,
        count: 0,
        items: [],
        warnings: [...warnings, '目前無法取得漲停名單'],
    };
}

const CACHE_TTL_MS = 8_000;
let cacheEntry: { key: string; at: number; dto: LimitUpBoardDto } | null = null;

function cacheGet(key: string): LimitUpBoardDto | null {
    if (!cacheEntry || cacheEntry.key !== key) return null;
    if (Date.now() - cacheEntry.at > CACHE_TTL_MS) return null;
    return cacheEntry.dto;
}

function cacheSet(key: string, dto: LimitUpBoardDto): void {
    cacheEntry = { key, at: Date.now(), dto };
}
