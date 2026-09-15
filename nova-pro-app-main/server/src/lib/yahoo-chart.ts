// server/src/lib/yahoo-chart.ts — shared Yahoo public chart HTTP (no API key)

export interface YahooChartMeta {
    price: number;
    previousClose: number;
    change: number;
    changePct: number;
    marketTime: number | null;
}

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

/** Best-effort Yahoo chart meta. Returns null on any failure — never invents 0. */
export async function fetchYahooChartMeta(
    yahooSymbol: string,
    timeoutMs = 8000,
): Promise<YahooChartMeta | null> {
    try {
        const url =
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}` +
            '?interval=1d&range=5d';
        const res = await fetch(url, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; stock-helper/1.0)',
                Accept: 'application/json',
            },
        });
        if (!res.ok) return null;
        const json = (await res.json()) as YahooChartResult;
        const meta = json.chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice || !Number.isFinite(meta.regularMarketPrice)) {
            return null;
        }
        const price = meta.regularMarketPrice;
        const prev = meta.chartPreviousClose ?? meta.previousClose;
        if (prev == null || !Number.isFinite(prev) || prev === 0) return null;
        const change = price - prev;
        const changePct = (change / prev) * 100;
        return {
            price,
            previousClose: prev,
            change,
            changePct,
            marketTime:
                typeof meta.regularMarketTime === 'number'
                    ? meta.regularMarketTime
                    : null,
        };
    } catch {
        return null;
    }
}

export async function fetchYahooChangePct(
    yahooSymbol: string,
): Promise<number | null> {
    const m = await fetchYahooChartMeta(yahooSymbol);
    return m?.changePct ?? null;
}
