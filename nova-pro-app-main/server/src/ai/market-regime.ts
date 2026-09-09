// server/src/ai/market-regime.ts — TW + US soft bull/bear regime for AI

import {
    fetchUsIndices,
    scoreUsOvernightBias,
    type UsIndexQuote,
} from '../lib/us-indices.ts';

export type RegimeBias = '偏多' | '偏空' | '中性';

export interface MarketRegime {
    bias: RegimeBias;
    label: string;
    summary: string;
    scoreAdj: number; // -10..+10
    twChangeRate: number | null;
    usScoreAdj: number;
    usSummary: string;
    drivers: string[];
    note: string;
}

interface YahooMeta {
    chart?: {
        result?: Array<{
            meta?: {
                regularMarketPrice?: number;
                chartPreviousClose?: number;
                previousClose?: number;
            };
        }>;
    };
}

async function fetchTwiiChange(): Promise<number | null> {
    try {
        const url =
            'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII' +
            '?interval=1d&range=5d';
        const res = await fetch(url, {
            signal: AbortSignal.timeout(8000),
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: 'application/json',
            },
        });
        if (!res.ok) {
            const url2 =
                'https://query2.finance.yahoo.com/v8/finance/chart/%5ETWII' +
                '?interval=1d&range=5d';
            const res2 = await fetch(url2, {
                signal: AbortSignal.timeout(8000),
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    Accept: 'application/json',
                },
            });
            if (!res2.ok) return null;
            const json = (await res2.json()) as YahooMeta;
            const meta = json.chart?.result?.[0]?.meta;
            if (!meta?.regularMarketPrice) return null;
            const prev = meta.chartPreviousClose ?? meta.previousClose;
            if (!prev) return null;
            return ((meta.regularMarketPrice - prev) / prev) * 100;
        }
        const json = (await res.json()) as YahooMeta;
        const meta = json.chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) return null;
        const prev = meta.chartPreviousClose ?? meta.previousClose;
        if (!prev) return null;
        return ((meta.regularMarketPrice - prev) / prev) * 100;
    } catch {
        return null;
    }
}

function twAdj(chg: number | null): { adj: number; bit: string | null } {
    if (chg == null || !Number.isFinite(chg)) return { adj: 0, bit: null };
    const bit = `加權 ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
    if (chg <= -1.2) return { adj: -5, bit };
    if (chg <= -0.5) return { adj: -2, bit };
    if (chg >= 1.2) return { adj: 5, bit };
    if (chg >= 0.5) return { adj: 2, bit };
    return { adj: 0, bit };
}

/** Combine TW index + US overnight into a soft market regime. */
export function scoreMarketRegime(input: {
    twChangeRate: number | null;
    usQuotes: UsIndexQuote[];
}): MarketRegime {
    const us = scoreUsOvernightBias(input.usQuotes);
    const tw = twAdj(input.twChangeRate);
    const drivers: string[] = [];
    if (tw.bit) drivers.push(tw.bit);
    if (us.summary && !us.summary.includes('暫無')) drivers.push(us.summary);

    let raw = tw.adj + Math.round(us.scoreAdj * 0.85);
    raw = Math.max(-10, Math.min(10, raw));

    // conflict: TW up US down (or reverse) → dampen
    if (tw.adj > 0 && us.scoreAdj < 0) {
        raw = Math.min(raw, 2);
        drivers.push('台美方向分歧，權重打折');
    } else if (tw.adj < 0 && us.scoreAdj > 0) {
        raw = Math.max(raw, -2);
        drivers.push('台美方向分歧，權重打折');
    }

    let bias: RegimeBias = '中性';
    let label = '大盤中性';
    if (raw >= 5) {
        bias = '偏多';
        label = '大盤偏多';
    } else if (raw >= 2) {
        bias = '偏多';
        label = '大盤略多';
    } else if (raw <= -5) {
        bias = '偏空';
        label = '大盤偏空';
    } else if (raw <= -2) {
        bias = '偏空';
        label = '大盤略空';
    }

    const summary = drivers.length
        ? `${label}：${drivers.slice(0, 2).join('；')}`
        : `${label}（指數資料不足）`;

    return {
        bias,
        label,
        summary,
        scoreAdj: raw,
        twChangeRate: input.twChangeRate,
        usScoreAdj: us.scoreAdj,
        usSummary: us.summary,
        drivers,
        note: '台／美指數為公開報價啟發式，非保證未來方向',
    };
}

export async function measureMarketRegime(
    usQuotes?: UsIndexQuote[],
): Promise<{ regime: MarketRegime; usQuotes: UsIndexQuote[] }> {
    const [twChangeRate, quotes] = await Promise.all([
        fetchTwiiChange(),
        usQuotes
            ? Promise.resolve(usQuotes)
            : fetchUsIndices().catch(() => [] as UsIndexQuote[]),
    ]);
    return {
        regime: scoreMarketRegime({ twChangeRate, usQuotes: quotes }),
        usQuotes: quotes,
    };
}

export function marketRegimeDto(r: MarketRegime) {
    return {
        bias: r.bias,
        label: r.label,
        summary: r.summary,
        score_adj: r.scoreAdj,
        tw_change_rate: r.twChangeRate,
        us_score_adj: r.usScoreAdj,
        us_summary: r.usSummary,
        drivers: r.drivers,
        note: r.note,
    };
}
