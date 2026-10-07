// Fugle (Developer/Advanced plan) pre-open ranking and 09:00 bid-queue samples.
// The market-wide snapshot narrows ~1,900 stocks to the strongest candidates;
// per-symbol intraday quotes then give the exchange reference price and the
// latest trial match (lastTrial / isTrial), so the change % is exact.
// Every result is checked against the response's own date/timestamps; anything
// stale or incomplete is rejected and the caller falls back to Shioaji.
// Docs: https://developer.fugle.tw/docs/data/http-api/snapshot/quotes
//       https://developer.fugle.tw/docs/data/http-api/intraday/quote

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScannerItem } from '../../types/dto.ts';
import { serverDataDir } from '../data-janitor.ts';
import { isTradingDay } from '../market-calendar/trading-day.ts';
import { sessionMinuteTaipei, taipeiYmd } from '../shadow/session.ts';
import type { BridgeSnapshot } from '../../providers/shioaji/bridge-scanner.ts';
import { appendPreopenRow, PREOPEN_SCAN_DIR } from './capture.ts';

const REST = 'https://api.fugle.tw/marketdata/v1.0/stock';
const MARKETS = ['TSE', 'OTC'] as const;
/** Candidates confirmed per cycle with intraday quotes (one REST call each). */
export const FUGLE_PREOPEN_CANDIDATES = 60;
const QUOTE_CONCURRENCY = 10;
/** Trial matches are published every few seconds; older than this is not live. */
const FRESH_MS = 180_000;
const MIN_FRESH_SNAPSHOT_ROWS = 50;
const MIN_CONFIRMED = 10;
const CACHE_MS = 5_000;

export async function fugleGet(apiKey: string, path: string, timeoutMs = 10_000): Promise<{ status: number; body: any }> {
    try {
        const res = await fetch(`${REST}${path}`, {
            headers: { 'X-API-KEY': apiKey },
            signal: AbortSignal.timeout(timeoutMs),
        });
        let body: any = null;
        try {
            body = await res.json();
        } catch {
            body = null;
        }
        return { status: res.status, body };
    } catch {
        return { status: 0, body: null };
    }
}

const usToMs = (v: unknown): number => (Number(v) > 1e14 ? Number(v) / 1000 : Number(v) || 0);
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (v: number) => Math.round(v * 100) / 100;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]!);
        }
    });
    await Promise.all(workers);
    return out;
}

// ---- previous close (candidate pre-selection only; exact % comes from referencePrice) ----

interface PrevClose {
    date: string;
    close: Record<string, number>;
}
let prevClose: PrevClose | null = null;

const prevCloseFile = (dataDir: string) => join(dataDir, PREOPEN_SCAN_DIR, 'fugle-prevclose.json');

function loadPrevClose(dataDir: string): PrevClose | null {
    if (prevClose) return prevClose;
    try {
        if (existsSync(prevCloseFile(dataDir))) prevClose = JSON.parse(readFileSync(prevCloseFile(dataDir), 'utf8'));
    } catch {
        prevClose = null;
    }
    return prevClose;
}

/** After the close (or on non-trading days) store the session's closing prices. */
export async function refreshFuglePrevClose(apiKey: string, now = new Date(), dataDir = serverDataDir()): Promise<string> {
    const ymd = taipeiYmd(now);
    const sm = sessionMinuteTaipei(now);
    if (isTradingDay(ymd) && sm >= -40 && sm < 280) return 'session';
    const close: Record<string, number> = {};
    let date = '';
    for (const m of MARKETS) {
        const r = await fugleGet(apiKey, `/snapshot/quotes/${m}?type=COMMONSTOCK`, 20_000);
        if (r.status !== 200 || !Array.isArray(r.body?.data)) return `http_${r.status}`;
        date = String(r.body.date ?? '');
        for (const row of r.body.data) {
            const c = num(row.closePrice);
            if (row.symbol && c > 0) close[String(row.symbol)] = c;
        }
    }
    if (!date || Object.keys(close).length < 500) return 'incomplete';
    if (loadPrevClose(dataDir)?.date === date) return 'unchanged';
    prevClose = { date, close };
    try {
        mkdirSync(join(dataDir, PREOPEN_SCAN_DIR), { recursive: true });
        writeFileSync(prevCloseFile(dataDir), JSON.stringify(prevClose), 'utf8');
    } catch {
        /* memory copy still serves this process */
    }
    return 'saved';
}

export function startFuglePrevCloseRefresher(getKey: () => string, dataDir: string): () => void {
    const tick = () => {
        const key = getKey();
        if (key) void refreshFuglePrevClose(key, new Date(), dataDir).catch(() => 'error');
    };
    const first = setTimeout(tick, 60_000);
    first.unref();
    const timer = setInterval(tick, 30 * 60_000);
    timer.unref();
    return () => {
        clearTimeout(first);
        clearInterval(timer);
    };
}

// ---- pre-open ranking ----

export interface FuglePreopenDiag {
    ok: boolean;
    reason: string | null;
    at: string;
    snapshot_rows: number;
    snapshot_fresh_rows: number;
    snapshot_date: string | null;
    candidate_basis: 'prev_close' | 'change_percent';
    prev_close_date: string | null;
    candidates: number;
    confirmed: number;
    rejected: Record<string, number>;
    calls: number;
}

export interface FuglePreopenResult {
    items: ScannerItem[];
    diag: FuglePreopenDiag;
}

export interface FuglePreopenOpts {
    now?: Date;
    dataDir?: string;
    /** Probe only: report the mapping on stale data instead of rejecting it. */
    ignoreFreshness?: boolean;
    candidates?: number;
}

let cached: { at: number; promise: Promise<FuglePreopenResult> } | null = null;

export function resetFuglePreopenCache(): void {
    cached = null;
    prevClose = null;
}

/** Cached for 5s so the radar's several scanner calls per cycle share one fetch. */
export function fuglePreopenRank(apiKey: string, opts: FuglePreopenOpts = {}): Promise<FuglePreopenResult> {
    const t = (opts.now ?? new Date()).getTime();
    if (!opts.ignoreFreshness && cached && t - cached.at < CACHE_MS && t >= cached.at) return cached.promise;
    const promise = computeFuglePreopen(apiKey, opts);
    if (!opts.ignoreFreshness) cached = { at: t, promise };
    return promise;
}

async function computeFuglePreopen(apiKey: string, opts: FuglePreopenOpts): Promise<FuglePreopenResult> {
    const now = opts.now ?? new Date();
    const ymd = taipeiYmd(now);
    const dataDir = opts.dataDir ?? serverDataDir();
    const fresh = (ms: number) => opts.ignoreFreshness || (ms >= now.getTime() - FRESH_MS && ms <= now.getTime() + 60_000);
    const diag: FuglePreopenDiag = {
        ok: false,
        reason: null,
        at: now.toISOString(),
        snapshot_rows: 0,
        snapshot_fresh_rows: 0,
        snapshot_date: null,
        candidate_basis: 'change_percent',
        prev_close_date: null,
        candidates: 0,
        confirmed: 0,
        rejected: {},
        calls: 0,
    };
    const fail = (reason: string): FuglePreopenResult => ({ items: [], diag: { ...diag, reason } });

    const rows: any[] = [];
    for (const m of MARKETS) {
        diag.calls++;
        const r = await fugleGet(apiKey, `/snapshot/quotes/${m}?type=COMMONSTOCK`);
        if (r.status !== 200 || !Array.isArray(r.body?.data)) return fail(`snapshot_${m}_http_${r.status}`);
        diag.snapshot_date = String(r.body.date ?? '');
        if (!opts.ignoreFreshness && diag.snapshot_date !== ymd) return fail(`snapshot_date_${diag.snapshot_date}`);
        rows.push(...r.body.data);
    }
    diag.snapshot_rows = rows.length;
    const live = rows.filter((r) => num(r.lastPrice) > 0 && fresh(usToMs(r.lastUpdated)));
    diag.snapshot_fresh_rows = live.length;
    if (live.length < MIN_FRESH_SNAPSHOT_ROWS) return fail('snapshot_not_fresh');

    const pc = loadPrevClose(dataDir);
    const usePc = pc && pc.date < ymd ? pc : null;
    diag.prev_close_date = pc?.date ?? null;
    diag.candidate_basis = usePc ? 'prev_close' : 'change_percent';
    const approx = (r: any): number => {
        const base = usePc?.close[String(r.symbol)];
        return base ? num(r.lastPrice) / base - 1 : num(r.changePercent) / 100;
    };
    const picks = live
        .slice()
        .sort((a, b) => approx(b) - approx(a))
        .slice(0, opts.candidates ?? FUGLE_PREOPEN_CANDIDATES)
        .map((r) => String(r.symbol));
    diag.candidates = picks.length;

    const reject = (why: string) => {
        diag.rejected[why] = (diag.rejected[why] ?? 0) + 1;
    };
    const quotes = await mapLimit(picks, QUOTE_CONCURRENCY, async (symbol) => {
        diag.calls++;
        return { symbol, r: await fugleGet(apiKey, `/intraday/quote/${symbol}`) };
    });
    const items: ScannerItem[] = [];
    for (const { symbol, r } of quotes) {
        const q = r.body;
        if (r.status !== 200 || !q) {
            reject(`http_${r.status}`);
            continue;
        }
        if (!opts.ignoreFreshness && q.date !== ymd) {
            reject('quote_date');
            continue;
        }
        const ref = num(q.referencePrice);
        const trial = q.lastTrial ?? null;
        const price = num(trial?.price ?? q.lastPrice);
        const at = usToMs(trial?.time ?? q.lastUpdated);
        if (ref <= 0 || price <= 0) {
            reject('no_price');
            continue;
        }
        if (!fresh(at)) {
            reject('trial_stale');
            continue;
        }
        const size = num(trial?.size ?? q.lastSize);
        const change = round2(price - ref);
        items.push({
            code: symbol,
            name: String(q.name ?? ''),
            date: ymd,
            close: price,
            open: price,
            high: price,
            low: price,
            change_price: change,
            change_type: change > 0 ? 2 : change < 0 ? 4 : 3,
            average_price: 0,
            price_range: 0,
            rank_value: round2((change / ref) * 100),
            total_volume: size,
            total_amount: Math.round(price * size * 1000),
            volume_ratio: 0,
            yesterday_volume: 0,
            tick_type: 0,
            buy_price: num(trial?.bid ?? q.bids?.[0]?.price),
            sell_price: num(trial?.ask ?? q.asks?.[0]?.price),
        });
    }
    diag.confirmed = items.length;
    if (items.length < MIN_CONFIRMED) return fail('too_few_confirmed');
    items.sort((a, b) => b.rank_value - a.rank_value || b.total_volume - a.total_volume);
    return { items, diag: { ...diag, ok: true } };
}

let lastDiag: FuglePreopenDiag | null = null;
let lastDiagRowAt = 0;

export function lastFuglePreopenDiag(): FuglePreopenDiag | null {
    return lastDiag;
}

/** Keeps the latest check and writes at most one row a minute to the day's scan file. */
export function noteFuglePreopenDiag(diag: FuglePreopenDiag, dataDir = serverDataDir()): void {
    lastDiag = diag;
    const t = Date.parse(diag.at);
    if (t - lastDiagRowAt < 55_000 && t >= lastDiagRowAt) return;
    lastDiagRowAt = t;
    appendPreopenRow({ t: diag.at, type: 'FugleDiag', source: 'fugle', items: [diag] }, dataDir);
}

// ---- 09:00+ bid queue ----

export interface FugleQueueRow extends BridgeSnapshot {
    reference: number;
    limit_up_bid: boolean;
    limit_up_price_hit: boolean;
}

/** Best bid/ask per code from intraday quotes; rows not dated today are dropped. */
export async function fetchFugleQueue(
    apiKey: string,
    codes: readonly string[],
    now = new Date(),
    opts: { ignoreDate?: boolean } = {},
): Promise<FugleQueueRow[]> {
    const ymd = taipeiYmd(now);
    const res = await mapLimit(codes, QUOTE_CONCURRENCY, (code) => fugleGet(apiKey, `/intraday/quote/${code}`));
    const out: FugleQueueRow[] = [];
    res.forEach((r, i) => {
        const q = r.body;
        if (r.status !== 200 || !q || (!opts.ignoreDate && q.date !== ymd)) return;
        out.push({
            code: codes[i]!,
            close: num(q.lastPrice ?? q.closePrice),
            high: num(q.highPrice),
            buy_price: num(q.bids?.[0]?.price),
            buy_volume: num(q.bids?.[0]?.size),
            sell_price: num(q.asks?.[0]?.price),
            sell_volume: num(q.asks?.[0]?.size),
            total_volume: num(q.total?.tradeVolume),
            change_rate: num(q.changePercent),
            reference: num(q.referencePrice),
            limit_up_bid: q.isLimitUpBid === true,
            limit_up_price_hit: q.isLimitUpPrice === true,
        });
    });
    return out;
}
