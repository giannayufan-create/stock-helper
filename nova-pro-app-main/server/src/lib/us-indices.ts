// server/src/lib/us-indices.ts — best-effort US index quotes (Yahoo public chart API)

export interface UsIndexQuote {
    symbol: string;
    label: string;
    close: number;
    changeRate: number;
    asOf: string | null;
}

const US_SYMBOLS: Array<{ yahoo: string; label: string }> = [
    { yahoo: '^DJI', label: '道瓊' },
    { yahoo: '^IXIC', label: '那斯達克' },
    { yahoo: '^GSPC', label: '標普500' },
    { yahoo: '^SOX', label: '費半' },
];

interface YahooChartResult {
    chart?: {
        result?: Array<{
            meta?: {
                regularMarketPrice?: number;
                chartPreviousClose?: number;
                previousClose?: number;
                regularMarketTime?: number;
            };
        }>;
    };
}

async function fetchOne(yahoo: string, label: string): Promise<UsIndexQuote | null> {
    const url =
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo)}` +
        '?interval=1d&range=5d';
    const ctrl = AbortSignal.timeout(8000);
    const res = await fetch(url, {
        signal: ctrl,
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; stock-helper/1.0)',
            Accept: 'application/json',
        },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as YahooChartResult;
    const meta = json.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const close = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose ?? meta.previousClose ?? close;
    const changeRate = prev ? ((close - prev) / prev) * 100 : 0;
    const asOf =
        typeof meta.regularMarketTime === 'number'
            ? new Date(meta.regularMarketTime * 1000).toISOString()
            : null;
    return { symbol: yahoo, label, close, changeRate, asOf };
}

export async function fetchUsIndices(): Promise<UsIndexQuote[]> {
    const settled = await Promise.allSettled(
        US_SYMBOLS.map((s) => fetchOne(s.yahoo, s.label)),
    );
    const out: UsIndexQuote[] = [];
    for (const hit of settled) {
        if (hit.status === 'fulfilled' && hit.value) out.push(hit.value);
    }
    return out;
}

/** Soft overnight regime from US futures/cash proxies (Yahoo; best-effort). */
export function scoreUsOvernightBias(quotes: UsIndexQuote[]): {
    scoreAdj: number;
    summary: string;
} {
    if (!quotes.length) {
        return { scoreAdj: 0, summary: '美股指數暫無資料' };
    }
    const nq = quotes.find((q) => q.symbol === '^IXIC');
    const sox = quotes.find((q) => q.symbol === '^SOX');
    const spx = quotes.find((q) => q.symbol === '^GSPC');
    const bits: string[] = [];
    let adj = 0;
    const push = (q: UsIndexQuote | undefined) => {
        if (!q) return;
        bits.push(`${q.label} ${q.changeRate >= 0 ? '+' : ''}${q.changeRate.toFixed(2)}%`);
    };
    push(nq);
    push(sox);
    push(spx);

    const nqChg = nq?.changeRate ?? 0;
    const soxChg = sox?.changeRate ?? nqChg;
    const avg = (nqChg + soxChg) / 2;
    if (avg <= -1.5) adj = -6;
    else if (avg <= -0.7) adj = -3;
    else if (avg >= 1.5) adj = 4;
    else if (avg >= 0.7) adj = 2;

    return {
        scoreAdj: adj,
        summary: bits.length
            ? `美股參考：${bits.join('、')}${adj ? `（隔夜權重 ${adj > 0 ? '+' : ''}${adj}）` : ''}`
            : '美股指數暫無資料',
    };
}
