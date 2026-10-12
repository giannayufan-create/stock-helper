// Save today's tick-by-tick trades from Fugle before the next session replaces them.
// Candidates use only facts known at 09:00: opening price vs reference price
// (gap, from the official TWSE/TPEx daily quotes), plus the current watchlist.
// Research input only; read-only APIs.
// Output: server/data/backtest-input/ticks/<date>/{candidates.json,<symbol>.json}
// Run (after the close, same day): npx tsx src/scripts/capture-fugle-ticks.ts

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from '../load-env.ts';
import { serverDataDir } from '../lib/data-janitor.ts';

const REST = 'https://api.fugle.tw/marketdata/v1.0/stock';
const PAGE = 500;
const GAP_MIN = 0.015;
const GAP_MAX = 0.1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function get(apiKey: string, path: string): Promise<{ status: number; text: string }> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
            const res = await fetch(`${REST}${path}`, {
                headers: { 'X-API-KEY': apiKey },
                signal: AbortSignal.timeout(30_000),
            });
            const text = await res.text();
            if (res.status === 429 || res.status >= 500) {
                await sleep(5_000 * (attempt + 1));
                continue;
            }
            return { status: res.status, text };
        } catch {
            await sleep(5_000 * (attempt + 1));
        }
    }
    return { status: 0, text: '' };
}

function taipeiToday(): string {
    return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

interface OpenQuote {
    code: string;
    name: string;
    market: 'TSE' | 'OTC';
    open: number;
    reference: number;
}

const COMMON_STOCK = /^[1-9]\d{3}$/;
const num = (v: unknown): number => {
    const n = Number(String(v ?? '').replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
};
const fieldIndex = (fields: string[]) =>
    Object.fromEntries(fields.map((f, i) => [f.replace(/\s+/g, ''), i])) as Record<string, number>;

/** Official daily quotes; only open and reference (close − change) are used. */
async function fetchOpenQuotes(date: string, hashes: Record<string, string>): Promise<OpenQuote[]> {
    const out: OpenQuote[] = [];
    const twseUrl = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${date.replace(/-/g, '')}&type=ALLBUT0999`;
    const twseText = await (await fetch(twseUrl, { signal: AbortSignal.timeout(60_000) })).text();
    hashes.TWSE = sha256(twseText);
    const twse = JSON.parse(twseText) as { stat?: string; tables?: Array<{ fields?: string[]; data?: unknown[][] }> };
    if (twse.stat !== 'OK') throw new Error(`TWSE stat=${twse.stat}`);
    const table = (twse.tables ?? []).find((t) => (t.fields ?? []).includes('證券代號'));
    if (!table?.data?.length) throw new Error('TWSE quotes table not published');
    const f = fieldIndex(table.fields!);
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
            reference: Math.round((close - (signRaw === '-' ? -1 : 1) * diff) * 10_000) / 10_000,
        });
    }
    try {
        out.push(...(await fetchTpexQuotes(date, hashes)));
    } catch (err) {
        console.warn(`TPEx skipped (${err instanceof Error ? err.message : err}); rerun later to add OTC`);
    }
    return out;
}

async function fetchTpexQuotes(date: string, hashes: Record<string, string>): Promise<OpenQuote[]> {
    const out: OpenQuote[] = [];
    const [y, m, d] = date.split('-');
    const tpexUrl = `https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php?l=zh-tw&d=${Number(y) - 1911}/${m}/${d}&o=json`;
    const tpexText = await (await fetch(tpexUrl, { signal: AbortSignal.timeout(60_000) })).text();
    hashes.TPEX = sha256(tpexText);
    const tpex = JSON.parse(tpexText) as { date?: string; tables?: Array<{ fields?: string[]; data?: unknown[][] }> };
    if (String(tpex.date ?? '') !== date.replace(/-/g, '')) throw new Error(`TPEx date=${tpex.date}`);
    const t = tpex.tables?.[0];
    if (!t?.data?.length) throw new Error('TPEx quotes not published');
    const g = fieldIndex(t.fields!);
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
            reference: Math.round((close - num(changeRaw)) * 10_000) / 10_000,
        });
    }
    return out;
}

interface Candidate {
    symbol: string;
    name: string;
    market: string;
    reference: number | null;
    open: number | null;
    gap_pct: number | null;
    sources: Array<'open_gap' | 'watchlist'>;
}

async function main(): Promise<void> {
    loadEnvFile();
    const apiKey = process.env.FUGLE_API_KEY ?? '';
    if (!apiKey) throw new Error('FUGLE_API_KEY missing');
    const watchArg = process.argv.indexOf('--watchlist');
    const watchFile = watchArg >= 0 ? process.argv[watchArg + 1] : undefined;

    const dateArg = process.argv.indexOf('--date');
    const date = dateArg >= 0 ? process.argv[dateArg + 1]! : taipeiToday();
    const byCode = new Map<string, Candidate>();
    const snapshotHashes: Record<string, string> = {};    for (const q of await fetchOpenQuotes(date, snapshotHashes)) {
        if (!(q.open > 0 && q.reference > 0)) continue;
        const gap = q.open / q.reference - 1;
        if (gap < GAP_MIN || gap > GAP_MAX) continue;
        byCode.set(q.code, {
            symbol: q.code,
            name: q.name,
            market: q.market,
            reference: q.reference,
            open: q.open,
            gap_pct: Math.round(gap * 10_000) / 100,
            sources: ['open_gap'],
        });
    }

    if (watchFile && existsSync(watchFile)) {
        const raw = JSON.parse(readFileSync(watchFile, 'utf8')) as unknown;
        const codes = new Set<string>();
        const walk = (v: unknown) => {
            if (typeof v === 'string' && /^\d{4,6}[A-Z]?$/.test(v)) codes.add(v);
            else if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(raw);
        for (const code of codes) {
            const c = byCode.get(code);
            if (c) c.sources.push('watchlist');
            else byCode.set(code, { symbol: code, name: '', market: '', reference: null, open: null, gap_pct: null, sources: ['watchlist'] });
        }
    }

    const outDir = join(serverDataDir(), 'backtest-input', 'ticks', date);
    mkdirSync(outDir, { recursive: true });
    const cands = [...byCode.values()].sort((a, b) => (b.gap_pct ?? -99) - (a.gap_pct ?? -99));
    writeFileSync(
        join(outDir, 'candidates.json'),
        JSON.stringify({
            date,
            generated_at: new Date().toISOString(),
            rule: `open/reference-1 in [${GAP_MIN}, ${GAP_MAX}] (4-digit common stocks, TWSE+TPEx) + watchlist`,
            source: 'TWSE MI_INDEX ALLBUT0999 + TPEx daily_close_quotes (open and close-change only)',
            snapshot_sha256: snapshotHashes,
            watchlist_file: watchFile ?? null,
            candidates: cands,
        }, null, 2),
        'utf8',
    );
    console.log(`date=${date} candidates=${cands.length} (open_gap=${cands.filter((c) => c.sources.includes('open_gap')).length})`);

    let done = 0;
    for (const c of cands) {
        const path = join(outDir, `${c.symbol}.json`);
        if (existsSync(path)) {
            done += 1;
            continue;
        }
        const pages: string[] = [];
        const rows: Record<string, unknown>[] = [];
        let ok = true;
        let tradeDate = '';
        for (let offset = 0; offset < 400_000; offset += PAGE) {
            const r = await get(apiKey, `/intraday/trades/${c.symbol}?limit=${PAGE}&offset=${offset}`);
            if (r.status !== 200) {
                console.warn(`${c.symbol}: http_${r.status} at offset ${offset}`);
                ok = false;
                break;
            }
            pages.push(r.text);
            const body = JSON.parse(r.text) as { date?: string; data?: Record<string, unknown>[] };
            tradeDate = String(body.date ?? '');
            const data = body.data ?? [];
            rows.push(...data);
            if (data.length < PAGE) break;
            await sleep(300);
        }
        if (!ok) continue;
        if (tradeDate !== date) {
            console.warn(`${c.symbol}: trades date ${tradeDate} != ${date}, skipped`);
            continue;
        }
        const unique = new Map<string, Record<string, unknown>>();
        for (const r of rows) unique.set(String(r.serial), r);
        const trades = [...unique.values()].sort((a, b) => Number(a.time) - Number(b.time));
        // The 14:30 after-hours fixed-price print is not part of the cumulative volume.
        const sessionEndUs = Date.parse(`${date}T13:30:00.999+08:00`) * 1000;
        const regular = trades.filter((r) => Number(r.time) <= sessionEndUs);
        const sizeSum = regular.reduce((a, r) => a + Number(r.size || 0), 0);
        const maxVolume = Math.max(0, ...regular.map((r) => Number(r.volume || 0)));
        writeFileSync(
            path,
            JSON.stringify({
                symbol: c.symbol,
                date,
                fetched_at: new Date().toISOString(),
                source: `fugle ${REST}/intraday/trades/${c.symbol} (limit=${PAGE}, paged by offset)`,
                pages_sha256: pages.map(sha256),
                complete: sizeSum === maxVolume,
                sum_size: sizeSum,
                max_volume: maxVolume,
                trades,
            }),
            'utf8',
        );
        done += 1;
        if (done % 10 === 0) console.log(`${done}/${cands.length} saved`);
        await sleep(300);
    }
    console.log(`finished ${done}/${cands.length} -> ${outDir}`);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
