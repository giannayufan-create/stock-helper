// server/src/lib/us-indices.ts — best-effort US index quotes (Yahoo public chart API)

import { fetchYahooChartMeta } from './yahoo-chart.ts';

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

async function fetchOne(yahoo: string, label: string): Promise<UsIndexQuote | null> {
    const meta = await fetchYahooChartMeta(yahoo);
    if (!meta) return null;
    return {
        symbol: yahoo,
        label,
        close: meta.price,
        changeRate: meta.changePct,
        asOf:
            meta.marketTime != null
                ? new Date(meta.marketTime * 1000).toISOString()
                : null,
    };
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
