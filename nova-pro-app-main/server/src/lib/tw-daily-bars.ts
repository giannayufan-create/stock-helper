// server/src/lib/tw-daily-bars.ts — Yahoo daily OHLCV for TW stocks (after-hours OK)

export interface DailyBar {
    date: string; // YYYY-MM-DD
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number; // shares
}

interface YahooChart {
    chart?: {
        result?: Array<{
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

const CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; bars: DailyBar[] }>();

function taipeiDate(tsSec: number): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(tsSec * 1000));
}

function parseBars(json: YahooChart): DailyBar[] {
    const result = json.chart?.result?.[0];
    const ts = result?.timestamp ?? [];
    const q = result?.indicators?.quote?.[0];
    if (!q || !ts.length) return [];
    const out: DailyBar[] = [];
    for (let i = 0; i < ts.length; i++) {
        const open = q.open?.[i];
        const high = q.high?.[i];
        const low = q.low?.[i];
        const close = q.close?.[i];
        const volume = q.volume?.[i] ?? 0;
        if (
            typeof open !== 'number' ||
            typeof high !== 'number' ||
            typeof low !== 'number' ||
            typeof close !== 'number' ||
            !(close > 0)
        ) {
            continue;
        }
        out.push({
            date: taipeiDate(ts[i]!),
            open,
            high,
            low,
            close,
            volume: typeof volume === 'number' ? volume : 0,
        });
    }
    return out;
}

async function fetchYahooDaily(
    symbol: string,
    range: string,
): Promise<DailyBar[]> {
    const hosts = [
        'https://query1.finance.yahoo.com',
        'https://query2.finance.yahoo.com',
    ];
    for (const host of hosts) {
        try {
            const url =
                `${host}/v8/finance/chart/${encodeURIComponent(symbol)}` +
                `?interval=1d&range=${encodeURIComponent(range)}`;
            const res = await fetch(url, {
                signal: AbortSignal.timeout(12000),
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    Accept: 'application/json,text/plain,*/*',
                },
            });
            if (!res.ok) continue;
            const bars = parseBars((await res.json()) as YahooChart);
            if (bars.length) return bars;
        } catch {
            // try next host
        }
    }
    return [];
}

/** Fetch ~6 months daily bars for a TW stock code. Cached 1h. */
export async function fetchTwDailyBars(
    code: string,
    range = '6mo',
): Promise<DailyBar[]> {
    const key = `${code}:${range}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.bars;

    const raw = code.trim();
    let bars = await fetchYahooDaily(`${raw}.TW`, range);
    if (bars.length < 20) {
        bars = await fetchYahooDaily(`${raw}.TWO`, range);
    }
    if (bars.length) cache.set(key, { at: Date.now(), bars });
    return bars;
}

export async function fetchTwDailyBarsBatch(
    codes: string[],
    range = '6mo',
    concurrency = 6,
): Promise<Map<string, DailyBar[]>> {
    const out = new Map<string, DailyBar[]>();
    const unique = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
    for (let i = 0; i < unique.length; i += concurrency) {
        const chunk = unique.slice(i, i + concurrency);
        const settled = await Promise.allSettled(
            chunk.map(async (code) => {
                const bars = await fetchTwDailyBars(code, range);
                return { code, bars };
            }),
        );
        for (const s of settled) {
            if (s.status === 'fulfilled' && s.value.bars.length) {
                out.set(s.value.code, s.value.bars);
            }
        }
    }
    return out;
}

/** Convert daily bars into KBars DTO for chart fallback. */
export function dailyBarsToKBars(bars: DailyBar[]): {
    datetime: string[];
    Open: number[];
    High: number[];
    Low: number[];
    Close: number[];
    Volume: number[];
    Amount: number[];
} {
    const out = {
        datetime: [] as string[],
        Open: [] as number[],
        High: [] as number[],
        Low: [] as number[],
        Close: [] as number[],
        Volume: [] as number[],
        Amount: [] as number[],
    };
    for (const b of bars) {
        out.datetime.push(`${b.date} 13:30:00`);
        out.Open.push(b.open);
        out.High.push(b.high);
        out.Low.push(b.low);
        out.Close.push(b.close);
        // chart expects 張-scale-ish like Fugle stock daily/1000
        out.Volume.push(Math.round(b.volume / 1000));
        out.Amount.push(Math.round(b.volume * b.close));
    }
    return out;
}
