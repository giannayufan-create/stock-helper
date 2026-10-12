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
import { fetchOpenQuotes, openGap } from '../lib/tw-open-quotes.ts';

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
    const official = await fetchOpenQuotes(date);
    if (official.otc_error) console.warn(`TPEx skipped (${official.otc_error}); rerun later to add OTC`);
    const snapshotHashes = official.sha256;
    for (const q of official.quotes) {
        const gap = openGap(q);
        if (gap == null || gap < GAP_MIN || gap > GAP_MAX) continue;
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
            source: official.sources,
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
