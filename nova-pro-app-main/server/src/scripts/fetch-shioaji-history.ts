// Download past days' tick-by-tick trades from Shioaji (via the server's guarded
// /api/v1/research/shioaji-ticks route) for stocks that opened with a gap, a fact
// known at 09:00 (official TWSE/TPEx open vs reference price). Research input only.
//
// Time basis (verified 2492 on 2026-10-08: 266/266 one-minute bars equal Fugle's
// OHLC and volume): `datetime` strings are Taipei wall-clock time even though the
// bridge suffixes them with "+00:00".
//
// Output: server/data/backtest-input/shioaji-ticks/<date>/{candidates.json,<symbol>.json}
// Run after 13:35 on trading days (the route refuses the session):
//   npx tsx src/scripts/fetch-shioaji-history.ts --from 2026-09-01 --to 2026-10-08

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serverDataDir } from '../lib/data-janitor.ts';
import { isTradingDay } from '../lib/market-calendar/trading-day.ts';
import { fetchOpenQuotes, openGap } from '../lib/tw-open-quotes.ts';

const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const BASE = arg('base', 'https://stock-helper-api-ruao.onrender.com').replace(/\/$/, '');
const GAP_MIN = Number(arg('gap-min', '0.02'));
const GAP_MAX = Number(arg('gap-max', '0.07'));
/** Stop while this much of the day's Shioaji quota is left for the live bridge. */
const FLOOR_MB = Number(arg('floor-mb', '200'));
const MAX_FETCH = Number(arg('max', '0'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function datesDescending(from: string, to: string): string[] {
    const out: string[] = [];
    for (let t = Date.parse(`${to}T00:00:00Z`); t >= Date.parse(`${from}T00:00:00Z`); t -= 86_400_000) {
        const d = new Date(t).toISOString().slice(0, 10);
        if (isTradingDay(d)) out.push(d);
    }
    return out;
}

interface Cand {
    symbol: string;
    name: string;
    market: 'TSE' | 'OTC';
    reference: number;
    open: number;
    gap_pct: number;
}

async function candidatesFor(date: string, dir: string): Promise<Cand[] | null> {
    const file = join(dir, 'candidates.json');
    if (existsSync(file)) {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as { otc_error: string | null; candidates: Cand[] };
        if (!saved.otc_error) return saved.candidates;
    }
    let official;
    try {
        official = await fetchOpenQuotes(date);
    } catch (err) {
        console.warn(`${date}: official quotes unavailable (${err instanceof Error ? err.message : err})`);
        return null;
    }
    const candidates: Cand[] = [];
    for (const q of official.quotes) {
        const gap = openGap(q);
        if (gap == null || gap < GAP_MIN || gap > GAP_MAX) continue;
        candidates.push({ ...q, symbol: q.code, gap_pct: Math.round(gap * 10_000) / 100 });
    }
    candidates.sort((a, b) => b.gap_pct - a.gap_pct);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        file,
        JSON.stringify(
            {
                date,
                generated_at: new Date().toISOString(),
                rule: `open/reference-1 in [${GAP_MIN}, ${GAP_MAX}], 4-digit common stocks`,
                sources: official.sources,
                sha256: official.sha256,
                otc_error: official.otc_error,
                candidates,
            },
            null,
            2,
        ),
        'utf8',
    );
    return candidates;
}

type FetchOutcome = 'saved' | 'stop' | 'failed';

async function fetchOne(date: string, c: Cand, path: string): Promise<{ outcome: FetchOutcome; remainingMb: number | null }> {
    const url = `${BASE}/api/v1/research/shioaji-ticks?code=${c.symbol}&date=${date}&exchange=${c.market}`;
    for (let attempt = 0; attempt < 4; attempt++) {
        let res: Response;
        try {
            res = await fetch(url, { signal: AbortSignal.timeout(150_000) });
        } catch (err) {
            console.warn(`${date} ${c.symbol}: ${err instanceof Error ? err.message : err}`);
            await sleep(10_000);
            continue;
        }
        const text = await res.text();
        const remainingMb = Number(res.headers.get('x-shioaji-remaining-mb') ?? NaN);
        if (res.status === 429) {
            await sleep(10_000);
            continue;
        }
        if (res.status === 503) {
            console.warn(`${date} ${c.symbol}: 503 ${text.slice(0, 160)}`);
            return { outcome: 'stop', remainingMb: null };
        }
        if (res.status !== 200) {
            console.warn(`${date} ${c.symbol}: http ${res.status} ${text.slice(0, 160)}`);
            return { outcome: 'failed', remainingMb: Number.isFinite(remainingMb) ? remainingMb : null };
        }
        const body = JSON.parse(text) as { date: string; datetime: string[]; close: number[]; volume: number[] };
        if (body.date !== date) {
            console.warn(`${date} ${c.symbol}: body date ${body.date}`);
            return { outcome: 'failed', remainingMb };
        }
        const wall = body.datetime.map((s) => String(s).slice(11, 19));
        const regular = body.volume.reduce((a, v, i) => (wall[i]! <= '13:30:00' ? a + v : a), 0);
        const outside = wall.filter((w) => w < '09:00:00' || w > '14:30:00').length;
        writeFileSync(
            path,
            JSON.stringify({
                symbol: c.symbol,
                date,
                market: c.market,
                fetched_at: new Date().toISOString(),
                source: url,
                body_sha256: sha256(text),
                time_basis: 'datetime is Taipei wall-clock; the "+00:00" suffix from the bridge is not a real offset',
                ticks_count: body.close.length,
                regular_volume: regular,
                after_regular_volume: body.volume.reduce((a, v) => a + v, 0) - regular,
                ticks_outside_0900_1430: outside,
                ticks: body,
            }),
            'utf8',
        );
        return { outcome: 'saved', remainingMb };
    }
    return { outcome: 'failed', remainingMb: null };
}

async function main(): Promise<void> {
    const to = arg('to', '2026-10-08');
    const from = arg('from', to);
    let fetched = 0;
    let failedInRow = 0;
    for (const date of datesDescending(from, to)) {
        const dir = join(serverDataDir(), 'backtest-input', 'shioaji-ticks', date);
        const cands = await candidatesFor(date, dir);
        if (!cands) continue;
        let have = 0;
        for (const c of cands) {
            const path = join(dir, `${c.symbol}.json`);
            if (existsSync(path)) {
                have++;
                continue;
            }
            if (MAX_FETCH && fetched >= MAX_FETCH) {
                console.log(`reached --max ${MAX_FETCH}`);
                return;
            }
            const r = await fetchOne(date, c, path);
            if (r.outcome === 'stop') return;
            if (r.outcome === 'failed') {
                if (++failedInRow >= 5) {
                    console.warn('5 failures in a row, stopping');
                    return;
                }
                continue;
            }
            failedInRow = 0;
            fetched++;
            have++;
            if (r.remainingMb != null && r.remainingMb < FLOOR_MB) {
                console.log(`quota floor: ${r.remainingMb}MB left (< ${FLOOR_MB}MB), stopping`);
                return;
            }
            if (fetched % 10 === 0) console.log(`${date}: ${have}/${cands.length} (run total ${fetched}, quota left ${r.remainingMb}MB)`);
            await sleep(1_000);
        }
        console.log(`${date}: complete ${have}/${cands.length}`);
    }
    console.log(`done, fetched ${fetched}`);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
