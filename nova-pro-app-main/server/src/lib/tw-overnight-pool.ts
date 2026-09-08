// server/src/lib/tw-overnight-pool.ts — after-hours fallback when Fugle
// snapshot rankings are empty (common outside market hours / plan limits).

import type { ScannerItem, ScannerType } from '../types/dto.ts';

/** Liquid TW names suitable for next-day day-trade prep. */
const SEED: Array<{ code: string; name: string }> = [
    { code: '2330', name: '台積電' },
    { code: '2317', name: '鴻海' },
    { code: '2454', name: '聯發科' },
    { code: '2303', name: '聯電' },
    { code: '2382', name: '廣達' },
    { code: '2308', name: '台達電' },
    { code: '3711', name: '日月光投控' },
    { code: '2881', name: '富邦金' },
    { code: '2882', name: '國泰金' },
    { code: '2891', name: '中信金' },
    { code: '2886', name: '兆豐金' },
    { code: '2884', name: '玉山金' },
    { code: '2885', name: '元大金' },
    { code: '2892', name: '第一金' },
    { code: '2880', name: '華南金' },
    { code: '2801', name: '彰銀' },
    { code: '2412', name: '中華電' },
    { code: '3045', name: '台灣大' },
    { code: '4904', name: '遠傳' },
    { code: '1301', name: '台塑' },
    { code: '1303', name: '南亞' },
    { code: '1326', name: '台化' },
    { code: '2002', name: '中鋼' },
    { code: '2207', name: '和泰車' },
    { code: '2912', name: '統一超' },
    { code: '1216', name: '統一' },
    { code: '1101', name: '台泥' },
    { code: '2603', name: '長榮' },
    { code: '2609', name: '陽明' },
    { code: '2615', name: '萬海' },
    { code: '3034', name: '聯詠' },
    { code: '2379', name: '瑞昱' },
    { code: '3037', name: '欣興' },
    { code: '2327', name: '國巨' },
    { code: '6669', name: '緯穎' },
    { code: '3231', name: '緯創' },
    { code: '2357', name: '華碩' },
    { code: '2356', name: '英業達' },
    { code: '3017', name: '奇鋐' },
    { code: '3661', name: '世芯-KY' },
    { code: '5274', name: '信驊' },
    { code: '3443', name: '創意' },
    { code: '2345', name: '智邦' },
    { code: '3008', name: '大立光' },
    { code: '2395', name: '研華' },
    { code: '2474', name: '可成' },
    { code: '4938', name: '和碩' },
    { code: '2408', name: '南亞科' },
    { code: '2344', name: '華邦電' },
    { code: '6770', name: '力積電' },
    { code: '3481', name: '群創' },
    { code: '2409', name: '友達' },
    { code: '2618', name: '長榮航' },
    { code: '2610', name: '華航' },
    { code: '5871', name: '中租-KY' },
    { code: '5876', name: '上海商銀' },
    { code: '6505', name: '台塑化' },
    { code: '9910', name: '豐泰' },
    { code: '8454', name: '億豐' },
    { code: '6415', name: '矽力*-KY' },
];

interface YahooChart {
    chart?: {
        result?: Array<{
            meta?: {
                regularMarketPrice?: number;
                chartPreviousClose?: number;
                previousClose?: number;
                currency?: string;
            };
            timestamp?: number[];
            indicators?: {
                quote?: Array<{
                    open?: Array<number | null>;
                    high?: Array<number | null>;
                    low?: Array<number | null>;
                    close?: Array<number | null>;
                    volume?: Array<number | null>;
                }>;
            };
        }>;
    };
}

function lastFinite(arr: Array<number | null | undefined> | undefined): number {
    if (!arr?.length) return 0;
    for (let i = arr.length - 1; i >= 0; i--) {
        const v = arr[i];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return 0;
}

async function fetchOne(code: string, name: string): Promise<ScannerItem | null> {
    const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(`${code}.TW`)}` +
        '?interval=1d&range=10d';
    try {
        const res = await fetch(url, {
            signal: AbortSignal.timeout(10000),
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; stock-helper/1.0)',
                Accept: 'application/json',
            },
        });
        if (!res.ok) {
            // some OTC names use .TWO
            const res2 = await fetch(
                `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(`${code}.TWO`)}?interval=1d&range=10d`,
                {
                    signal: AbortSignal.timeout(10000),
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; stock-helper/1.0)',
                        Accept: 'application/json',
                    },
                },
            );
            if (!res2.ok) return null;
            return parseYahoo(await res2.json(), code, name);
        }
        return parseYahoo(await res.json(), code, name);
    } catch {
        return null;
    }
}

function parseYahoo(json: YahooChart, code: string, name: string): ScannerItem | null {
    const result = json.chart?.result?.[0];
    const q = result?.indicators?.quote?.[0];
    if (!q) return null;
    const close = lastFinite(q.close);
    const open = lastFinite(q.open) || close;
    const high = lastFinite(q.high) || close;
    const low = lastFinite(q.low) || close;
    const volume = lastFinite(q.volume);
    if (!(close > 0)) return null;
    const prev =
        result?.meta?.chartPreviousClose ??
        result?.meta?.previousClose ??
        close;
    const change = close - prev;
    const avg = (open + high + low + close) / 4;
    const date = new Date().toISOString().slice(0, 10);
    return {
        code,
        name,
        date,
        close,
        open,
        high,
        low,
        change_price: change,
        change_type: change > 0 ? 2 : change < 0 ? 4 : 3,
        average_price: avg,
        price_range: high - low,
        rank_value: volume,
        total_volume: volume / 1000, // Yahoo is shares; keep similar scale-ish
        total_amount: volume * close,
        volume_ratio: 1.2,
        yesterday_volume: 0,
        tick_type: 0,
        buy_price: 0,
        sell_price: 0,
    };
}

function sortPool(rows: ScannerItem[], type: ScannerType): ScannerItem[] {
    const copy = [...rows];
    if (type === 'ChangePercentRank' || type === 'ChangePriceRank') {
        copy.sort((a, b) => {
            const ap = a.close - a.change_price || a.close;
            const bp = b.close - b.change_price || b.close;
            const aPct = ap ? a.change_price / ap : 0;
            const bPct = bp ? b.change_price / bp : 0;
            return bPct - aPct;
        });
    } else if (type === 'AmountRank') {
        copy.sort((a, b) => b.total_amount - a.total_amount);
    } else {
        copy.sort((a, b) => b.total_volume - a.total_volume);
    }
    return copy;
}

/** Fetch liquid TW daily bars for overnight / after-hours screening. */
export async function fetchTwOvernightPool(
    type: ScannerType,
    count: number,
): Promise<ScannerItem[]> {
    const settled = await Promise.allSettled(
        SEED.map((s) => fetchOne(s.code, s.name)),
    );
    const rows: ScannerItem[] = [];
    for (const hit of settled) {
        if (hit.status === 'fulfilled' && hit.value) rows.push(hit.value);
    }
    return sortPool(rows, type).slice(0, count);
}
