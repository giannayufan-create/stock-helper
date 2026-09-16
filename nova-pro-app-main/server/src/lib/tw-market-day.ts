// server/src/lib/tw-market-day.ts — full TWSE + TPEx daily quotes (OpenAPI)
// Universe for screening without Fugle mid-tier snapshot ranks.

import type { ScannerItem } from '../types/dto.ts';

export type TwMarket = 'tse' | 'otc';

export interface TwDayQuote {
    code: string;
    name: string;
    market: TwMarket;
    date: string; // YYYY-MM-DD
    open: number;
    high: number;
    low: number;
    close: number;
    change: number;
    /** shares */
    volume: number;
    /** TWD */
    amount: number;
    transactions: number;
}

const CACHE_MS = 30 * 60 * 1000;
const HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; StockHelper/1.0)',
    Accept: 'application/json,text/plain,*/*',
};

let cache: { at: number; rows: TwDayQuote[] } | null = null;
let inflight: Promise<TwDayQuote[]> | null = null;

function parseNum(v: unknown): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'string') return 0;
    const cleaned = v.replace(/,/g, '').replace(/--/g, '').trim();
    if (!cleaned || cleaned === '-') return 0;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
}

/** Prefer common equities: 4-digit, not ETF (00xx) / leveraged / special letters. */
export function isCommonEquityCode(code: string): boolean {
    if (!/^\d{4}$/.test(code)) return false;
    if (code.startsWith('00')) return false;
    return true;
}

function rocToIso(raw: string): string {
    const s = String(raw ?? '').replace(/\D/g, '');
    if (s.length === 7) {
        const y = Number(s.slice(0, 3)) + 1911;
        return `${y}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
    }
    if (s.length === 8) {
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    }
    return new Date().toISOString().slice(0, 10);
}

async function fetchJson(url: string): Promise<unknown | null> {
    try {
        const res = await fetch(url, {
            headers: HEADERS,
            signal: AbortSignal.timeout(25000),
        });
        if (!res.ok) return null;
        const text = await res.text();
        if (!text || text.startsWith('<')) return null;
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

function pick(
    row: Record<string, unknown>,
    keys: string[],
): unknown {
    for (const k of keys) {
        if (row[k] != null && row[k] !== '') return row[k];
    }
    // case-insensitive fallback
    const lower = Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]),
    );
    for (const k of keys) {
        const hit = lower[k.toLowerCase()];
        if (hit != null && hit !== '') return hit;
    }
    return undefined;
}

function rowToQuote(
    row: Record<string, unknown>,
    market: TwMarket,
): TwDayQuote | null {
    const code = String(
        pick(row, [
            'Code',
            'code',
            'SecuritiesCompanyCode',
            '证券代号',
            '證券代號',
            '股票代號',
        ]) ?? '',
    )
        .trim()
        .replace(/=|"/g, '');
    if (!isCommonEquityCode(code)) return null;

    const close = parseNum(
        pick(row, ['ClosingPrice', 'Close', 'close', '收盤']),
    );
    if (!(close > 0)) return null;

    const open = parseNum(pick(row, ['OpeningPrice', 'Open', 'open', '開盤'])) || close;
    const high =
        parseNum(pick(row, ['HighestPrice', 'High', 'high', '最高'])) || close;
    const low =
        parseNum(pick(row, ['LowestPrice', 'Low', 'low', '最低'])) || close;
    const change = parseNum(pick(row, ['Change', 'change', '漲跌價差', '漲跌']));
    const volume = parseNum(
        pick(row, [
            'TradeVolume',
            'TradingShares',
            'Volume',
            'volume',
            '成交股數',
        ]),
    );
    const amount = parseNum(
        pick(row, [
            'TradeValue',
            'TradingAmount',
            'Amount',
            'amount',
            '成交金額',
        ]),
    );
    const transactions = parseNum(
        pick(row, ['Transaction', 'TransactionCount', '成交筆數']),
    );
    const name = String(
        pick(row, ['Name', 'CompanyName', 'name', '證券名稱', '股票名稱']) ??
            '',
    ).trim();
    const date = rocToIso(
        String(pick(row, ['Date', 'date', '日期']) ?? ''),
    );

    return {
        code,
        name,
        market,
        date,
        open,
        high,
        low,
        close,
        change,
        volume,
        amount,
        transactions,
    };
}

function parseArrayPayload(
    payload: unknown,
    market: TwMarket,
): TwDayQuote[] {
    if (!Array.isArray(payload)) return [];
    const out: TwDayQuote[] = [];
    for (const item of payload) {
        if (!item || typeof item !== 'object') continue;
        const q = rowToQuote(item as Record<string, unknown>, market);
        if (q) out.push(q);
    }
    return out;
}

async function loadTwseDay(): Promise<TwDayQuote[]> {
    const payload = await fetchJson(
        'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
    );
    return parseArrayPayload(payload, 'tse');
}

async function loadTpexDay(): Promise<TwDayQuote[]> {
    const urls = [
        'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
        'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
    ];
    for (const url of urls) {
        const payload = await fetchJson(url);
        const rows = parseArrayPayload(payload, 'otc');
        if (rows.length) return rows;
    }

    // Legacy JSON table fallback
    const now = new Date();
    for (let i = 0; i < 6; i++) {
        const d = new Date(now.getTime() - i * 86400000);
        if (d.getDay() === 0 || d.getDay() === 6) continue;
        const y = d.getFullYear() - 1911;
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const roc = `${y}/${mm}/${dd}`;
        const payload = await fetchJson(
            `https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&d=${encodeURIComponent(roc)}&o=json`,
        );
        if (!payload || typeof payload !== 'object') continue;
        const p = payload as { tables?: Array<{ data?: unknown[][] }> };
        const data = p.tables?.[0]?.data;
        if (!Array.isArray(data) || !data.length) continue;
        const out: TwDayQuote[] = [];
        for (const row of data) {
            if (!Array.isArray(row) || row.length < 8) continue;
            const code = String(row[0] ?? '')
                .trim()
                .replace(/=|"/g, '');
            if (!isCommonEquityCode(code)) continue;
            const close = parseNum(row[2]);
            if (!(close > 0)) continue;
            out.push({
                code,
                name: String(row[1] ?? '').trim(),
                market: 'otc',
                date: `${d.getFullYear()}-${mm}-${dd}`,
                close,
                change: parseNum(row[3]),
                open: parseNum(row[4]) || close,
                high: parseNum(row[5]) || close,
                low: parseNum(row[6]) || close,
                volume: parseNum(row[7]),
                amount: parseNum(row[8]),
                transactions: parseNum(row[9]),
            });
        }
        if (out.length) return out;
    }
    return [];
}

/** Full listed + OTC common equities for the latest published session. */
export async function fetchTwMarketDayAll(opts?: {
    /** Override default 30m cache (e.g. market-context near-realtime refresh). */
    maxAgeMs?: number;
}): Promise<TwDayQuote[]> {
    const maxAge = opts?.maxAgeMs ?? CACHE_MS;
    if (cache && Date.now() - cache.at < maxAge) return cache.rows;
    if (inflight) return inflight;
    inflight = (async () => {
        const [twse, tpex] = await Promise.all([loadTwseDay(), loadTpexDay()]);
        const byCode = new Map<string, TwDayQuote>();
        for (const r of [...twse, ...tpex]) byCode.set(r.code, r);
        const rows = [...byCode.values()];
        cache = { at: Date.now(), rows };
        inflight = null;
        return rows;
    })().catch((err) => {
        inflight = null;
        throw err;
    });
    return inflight;
}

export function dayQuoteToScannerItem(q: TwDayQuote): ScannerItem {
    const avg =
        q.volume > 0 && q.amount > 0
            ? q.amount / q.volume
            : (q.open + q.high + q.low + q.close) / 4;
    return {
        code: q.code,
        name: q.name,
        date: q.date,
        close: q.close,
        open: q.open,
        high: q.high,
        low: q.low,
        change_price: q.change,
        change_type: q.change > 0 ? 2 : q.change < 0 ? 4 : 3,
        average_price: avg,
        price_range: q.high - q.low,
        rank_value: q.amount,
        total_volume: q.volume / 1000, // 張
        total_amount: q.amount,
        volume_ratio: 1,
        yesterday_volume: 0,
        tick_type: 0,
        buy_price: 0,
        sell_price: 0,
    };
}

/** Liquid pool from full market: top volume / amount / gainers unions. */
export function pickLiquidUniverse(
    all: TwDayQuote[],
    opts?: {
        minLots?: number;
        minAmount?: number;
        topVolume?: number;
        topAmount?: number;
        topGainers?: number;
    },
): TwDayQuote[] {
    const minLots = opts?.minLots ?? 300;
    const minAmount = opts?.minAmount ?? 30_000_000;
    const topVolume = opts?.topVolume ?? 120;
    const topAmount = opts?.topAmount ?? 120;
    const topGainers = opts?.topGainers ?? 100;

    const liquid = all.filter(
        (r) =>
            r.close > 5 &&
            r.close < 2000 &&
            (r.volume / 1000 >= minLots || r.amount >= minAmount),
    );

    const byVol = [...liquid].sort((a, b) => b.volume - a.volume).slice(0, topVolume);
    const byAmt = [...liquid]
        .sort((a, b) => b.amount - a.amount)
        .slice(0, topAmount);
    const byChg = [...liquid]
        .filter((r) => {
            const prev = r.close - r.change;
            return prev > 0 && r.change / prev > 0;
        })
        .sort((a, b) => {
            const ap = a.close - a.change || a.close;
            const bp = b.close - b.change || b.close;
            return b.change / ap - a.change / bp;
        })
        .slice(0, topGainers);

    const map = new Map<string, TwDayQuote>();
    for (const r of [...byVol, ...byAmt, ...byChg]) map.set(r.code, r);
    return [...map.values()];
}
