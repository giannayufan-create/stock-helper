// Official daily quotes for one trading date: opening price and reference price
// (close − change) per 4-digit common stock, TWSE + TPEx. Used to pick stocks by
// their opening gap, a fact known at 09:00. Research input only.
// TWSE: https://www.twse.com.tw/exchangeReport/MI_INDEX?type=ALLBUT0999
// TPEx: /www/zh-tw/afterTrading/dailyQuotes honours `date`; the older
//       daily_close_quotes/stk_quote_result.php ignores `d` and serves the latest day.

import { createHash } from 'node:crypto';

export interface OpenQuote {
    code: string;
    name: string;
    market: 'TSE' | 'OTC';
    open: number;
    reference: number;
}

export interface OpenQuotesResult {
    quotes: OpenQuote[];
    /** sha256 of each raw response, so a run can be tied to the exact snapshot. */
    sha256: Record<string, string>;
    sources: Record<string, string>;
    /** Set when TPEx was not available for the date; quotes are then TWSE only. */
    otc_error: string | null;
}

const COMMON_STOCK = /^[1-9]\d{3}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const num = (v: unknown): number => {
    const n = Number(String(v ?? '').replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
};
const fieldIndex = (fields: string[]) =>
    Object.fromEntries(fields.map((f, i) => [f.replace(/\s+/g, ''), i])) as Record<string, number>;
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

export function twseOpenQuotesUrl(date: string): string {
    return `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${date.replace(/-/g, '')}&type=ALLBUT0999`;
}

export function tpexOpenQuotesUrl(date: string): string {
    return `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${date.replace(/-/g, '%2F')}&id=&response=json`;
}

export function parseTwseOpenQuotes(text: string): OpenQuote[] {
    const twse = JSON.parse(text) as { stat?: string; tables?: Array<{ fields?: string[]; data?: unknown[][] }> };
    if (twse.stat !== 'OK') throw new Error(`TWSE stat=${twse.stat}`);
    const table = (twse.tables ?? []).find((t) => (t.fields ?? []).includes('證券代號'));
    if (!table?.data?.length) throw new Error('TWSE quotes table not published');
    const f = fieldIndex(table.fields!);
    const out: OpenQuote[] = [];
    for (const row of table.data) {
        const code = String(row[f['證券代號']!]).trim();
        if (!COMMON_STOCK.test(code)) continue;
        const close = num(row[f['收盤價']!]);
        const signRaw = String(row[f['漲跌(+/-)']!]).replace(/<[^>]+>/g, '').trim();
        if (!close || signRaw === 'X') continue;
        const diff = num(row[f['漲跌價差']!]);
        out.push({
            code,
            name: String(row[f['證券名稱']!]).trim(),
            market: 'TSE',
            open: num(row[f['開盤價']!]),
            reference: round4(close - (signRaw === '-' ? -1 : 1) * diff),
        });
    }
    return out;
}

export function parseTpexOpenQuotes(text: string, date: string): OpenQuote[] {
    const tpex = JSON.parse(text) as { date?: string; tables?: Array<{ fields?: string[]; data?: unknown[][] }> };
    if (String(tpex.date ?? '') !== date.replace(/-/g, '')) throw new Error(`TPEx date=${tpex.date}`);
    const t = tpex.tables?.[0];
    if (!t?.data?.length) throw new Error('TPEx quotes not published');
    const g = fieldIndex(t.fields!);
    const out: OpenQuote[] = [];
    for (const row of t.data) {
        const code = String(row[g['代號']!]).trim();
        if (!COMMON_STOCK.test(code)) continue;
        const close = num(row[g['收盤']!]);
        const changeRaw = String(row[g['漲跌']!]).trim();
        if (!close || !/^[+-]?\d/.test(changeRaw)) continue;
        out.push({
            code,
            name: String(row[g['名稱']!]).trim(),
            market: 'OTC',
            open: num(row[g['開盤']!]),
            reference: round4(close - num(changeRaw)),
        });
    }
    return out;
}

export async function fetchOpenQuotes(date: string): Promise<OpenQuotesResult> {
    const res: OpenQuotesResult = { quotes: [], sha256: {}, sources: {}, otc_error: null };
    const twseUrl = twseOpenQuotesUrl(date);
    const twseText = await (await fetch(twseUrl, { signal: AbortSignal.timeout(60_000) })).text();
    res.sha256.TWSE = sha256(twseText);
    res.sources.TWSE = twseUrl;
    res.quotes.push(...parseTwseOpenQuotes(twseText));
    const tpexUrl = tpexOpenQuotesUrl(date);
    try {
        const tpexText = await (await fetch(tpexUrl, { signal: AbortSignal.timeout(60_000) })).text();
        res.sha256.TPEX = sha256(tpexText);
        res.sources.TPEX = tpexUrl;
        res.quotes.push(...parseTpexOpenQuotes(tpexText, date));
    } catch (err) {
        res.otc_error = err instanceof Error ? err.message : String(err);
    }
    return res;
}

/** open / reference − 1, or null when either price is missing (no trade, suspended). */
export function openGap(q: OpenQuote): number | null {
    return q.open > 0 && q.reference > 0 ? q.open / q.reference - 1 : null;
}
