// 08:28–09:03 on trading days: per-symbol Fugle intraday quotes (last trial match,
// best five bids/asks, trial/delayed-open/halt flags, exchange timestamps) for a
// pool fixed before the trial session, written raw to preopen-trials/<date>.jsonl.
// Research capture only: nothing here feeds A/B/C, Buy Pressure, Rank or signals.
//
// Fugle's market-wide snapshot still serves the previous session before 09:00, so
// the whole market cannot be ranked by trial price; the pool is the previous
// session's movers and turnover leaders plus the watchlist.
// Docs: https://developer.fugle.tw/docs/data/http-api/intraday/quote
//       https://developer.fugle.tw/docs/pricing (intraday API 600/min on Developer)

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { serverDataDir } from '../data-janitor.ts';
import { isTradingDay } from '../market-calendar/trading-day.ts';
import { sessionMinuteTaipei, taipeiYmd } from '../shadow/session.ts';
import { fugleGet } from './fugle-preopen.ts';

export const PREOPEN_TRIALS_DIR = 'preopen-trials';

const WINDOW_FROM_MIN = -32; // 08:28
const WINDOW_TO_MIN = 4; // until 09:03:59, for delayed opens
const DENSE_FROM_MIN = -5; // 08:55
const SLOW_GAP_MS = 60_000;
const DENSE_GAP_MS = 20_000;
const POOL_MAX = 100;
const WATCHLIST_MAX = 40;
const PREV_STRONG_MAX = 50;
const PREV_STRONG_MIN_PCT = 3;
const PREV_VALUE_MAX = 30;
const CONCURRENCY = 5;
const BACKOFF_MS = 60_000;

export type PoolReason = 'watchlist' | 'prev_strong' | 'prev_value';

export interface PoolMember {
    symbol: string;
    reasons: PoolReason[];
    prev_change_pct: number | null;
    prev_value: number | null;
}

export interface TrialPool {
    date: string;
    built_at: string;
    /** Trading date of the Fugle snapshot the pool was ranked from (previous session). */
    basis_date: string | null;
    basis_error: string | null;
    members: PoolMember[];
}

export function preopenTrialsFile(ymd: string, dataDir = serverDataDir()): string {
    return join(dataDir, PREOPEN_TRIALS_DIR, `${ymd}.jsonl`);
}

export function isTrialRecordWindow(d: Date = new Date()): boolean {
    if (!isTradingDay(taipeiYmd(d))) return false;
    const sm = sessionMinuteTaipei(d);
    return sm >= WINDOW_FROM_MIN && sm < WINDOW_TO_MIN;
}

const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const COMMON = /^\d{4}$/;

export function buildTrialPool(
    snapshotRows: readonly any[],
    watchlist: readonly string[],
    ymd: string,
    now: Date,
    basis: { date: string | null; error: string | null },
): TrialPool {
    const members = new Map<string, PoolMember>();
    const add = (symbol: string, reason: PoolReason, row?: any) => {
        if (!COMMON.test(symbol)) return;
        let m = members.get(symbol);
        if (!m) {
            if (members.size >= POOL_MAX) return;
            m = { symbol, reasons: [], prev_change_pct: null, prev_value: null };
            members.set(symbol, m);
        }
        if (!m.reasons.includes(reason)) m.reasons.push(reason);
        if (row) {
            m.prev_change_pct = num(row.changePercent);
            m.prev_value = num(row.tradeValue);
        }
    };
    const bySymbol = new Map(snapshotRows.map((r) => [String(r.symbol), r]));
    for (const code of watchlist.slice(0, WATCHLIST_MAX)) add(code, 'watchlist', bySymbol.get(code));
    const rows = snapshotRows.filter((r) => COMMON.test(String(r.symbol)) && (num(r.closePrice) ?? 0) > 0);
    rows.filter((r) => (num(r.changePercent) ?? 0) >= PREV_STRONG_MIN_PCT)
        .sort((a, b) => (num(b.changePercent) ?? 0) - (num(a.changePercent) ?? 0))
        .slice(0, PREV_STRONG_MAX)
        .forEach((r) => add(String(r.symbol), 'prev_strong', r));
    rows.slice()
        .sort((a, b) => (num(b.tradeValue) ?? 0) - (num(a.tradeValue) ?? 0))
        .slice(0, PREV_VALUE_MAX)
        .forEach((r) => add(String(r.symbol), 'prev_value', r));
    return {
        date: ymd,
        built_at: now.toISOString(),
        basis_date: basis.date,
        basis_error: basis.error,
        members: [...members.values()],
    };
}

/** One raw quote row; exchange times stay in Fugle's microsecond epochs. */
export function trialRow(t: string, q: any): Record<string, unknown> {
    const book = (side: any) =>
        Array.isArray(side) ? side.slice(0, 5).map((l: any) => [num(l?.price), num(l?.size)]) : [];
    const trial = q.lastTrial
        ? {
              p: num(q.lastTrial.price),
              s: num(q.lastTrial.size),
              b: num(q.lastTrial.bid),
              a: num(q.lastTrial.ask),
              t: num(q.lastTrial.time),
              n: num(q.lastTrial.serial),
          }
        : null;
    const trade = q.lastTrade
        ? { p: num(q.lastTrade.price), s: num(q.lastTrade.size), t: num(q.lastTrade.time) }
        : null;
    const flags = [
        'isTrial',
        'isDelayedOpen',
        'isOpen',
        'isLimitUpBid',
        'isLimitUpAsk',
        'isLimitUpPrice',
        'isLimitUpHalt',
        'isLimitDownHalt',
    ].filter((k) => q[k] === true);
    if (q.tradingHalt?.isHalted === true) flags.push('halted');
    return {
        t,
        k: 'q',
        s: String(q.symbol ?? ''),
        d: q.date ?? null,
        ref: num(q.referencePrice),
        pc: num(q.previousClose),
        trial,
        trade,
        open: num(q.openPrice),
        ot: num(q.openTime),
        hi: num(q.highPrice),
        lo: num(q.lowPrice),
        bids: book(q.bids),
        asks: book(q.asks),
        vol: num(q.total?.tradeVolume),
        vb: num(q.total?.tradeVolumeAtBid),
        va: num(q.total?.tradeVolumeAtAsk),
        tx: num(q.total?.transaction),
        f: flags,
        upd: num(q.lastUpdated),
        ser: num(q.serial),
    };
}

/** Opened in continuous trading: later polls of this symbol are not needed. */
function hasOpened(q: any): boolean {
    return (num(q.openPrice) ?? 0) > 0 && q.isTrial !== true && q.isDelayedOpen !== true && q.tradingHalt?.isHalted !== true;
}

type Getter = (path: string) => Promise<{ status: number; body: any }>;

export interface TrialRecorderDeps {
    get: Getter;
    watchlist: () => string[];
    dataDir?: string;
}

export interface TrialCycleResult {
    requested: number;
    ok: number;
    other_date: number;
    http: Record<string, number>;
}

export class TrialRecorder {
    private pool: TrialPool | null = null;
    private opened = new Set<string>();
    private lastCycleAt = 0;
    private backoffUntil = 0;
    private busy = false;

    constructor(private deps: TrialRecorderDeps) {}

    private file(ymd: string): string {
        return preopenTrialsFile(ymd, this.deps.dataDir ?? serverDataDir());
    }

    private append(ymd: string, rows: readonly Record<string, unknown>[]): void {
        if (!rows.length) return;
        try {
            mkdirSync(join(this.deps.dataDir ?? serverDataDir(), PREOPEN_TRIALS_DIR), { recursive: true });
            appendFileSync(this.file(ymd), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        } catch {
            // research capture must never disturb the radar
        }
    }

    currentPool(): TrialPool | null {
        return this.pool;
    }

    /** A pool missing its snapshot basis is rebuilt each cycle until 09:00. */
    private async ensurePool(ymd: string, now: Date, sm: number): Promise<TrialPool> {
        if (this.pool?.date === ymd && (!this.pool.basis_error || sm >= 0)) return this.pool;
        this.opened = new Set();
        const rows: any[] = [];
        let basisDate: string | null = null;
        let basisError: string | null = null;
        for (const m of ['TSE', 'OTC']) {
            const r = await this.deps.get(`/snapshot/quotes/${m}?type=COMMONSTOCK`);
            if (r.status !== 200 || !Array.isArray(r.body?.data)) {
                basisError = `snapshot_${m}_http_${r.status}`;
                break;
            }
            basisDate = String(r.body.date ?? '') || null;
            rows.push(...r.body.data);
        }
        if (basisError) rows.length = 0;
        let watch: string[] = [];
        try {
            watch = this.deps.watchlist();
        } catch {
            watch = [];
        }
        this.pool = buildTrialPool(rows, watch, ymd, now, { date: basisDate, error: basisError });
        this.append(ymd, [{ t: now.toISOString(), k: 'pool', ...this.pool }]);
        return this.pool;
    }

    /** Called every few seconds; polls only when the cadence for the current minute is due. */
    async tick(now: Date = new Date()): Promise<TrialCycleResult | null> {
        if (this.busy || !isTrialRecordWindow(now)) return null;
        const t = now.getTime();
        if (t < this.backoffUntil) return null;
        const sm = sessionMinuteTaipei(now);
        const gap = sm < DENSE_FROM_MIN ? SLOW_GAP_MS : DENSE_GAP_MS;
        if (this.lastCycleAt && t - this.lastCycleAt < gap && t >= this.lastCycleAt) return null;
        this.busy = true;
        this.lastCycleAt = t;
        try {
            return await this.cycle(now, sm);
        } finally {
            this.busy = false;
        }
    }

    private async cycle(now: Date, sm: number): Promise<TrialCycleResult> {
        const ymd = taipeiYmd(now);
        const pool = await this.ensurePool(ymd, now, sm);
        const symbols = pool.members
            .map((m) => m.symbol)
            .filter((s) => sm < 0 || !this.opened.has(s));
        const res: TrialCycleResult = { requested: 0, ok: 0, other_date: 0, http: {} };
        const rows: Record<string, unknown>[] = [];
        let next = 0;
        let limited = false;
        const started = Date.now();
        const worker = async () => {
            while (next < symbols.length && !limited) {
                const symbol = symbols[next++]!;
                res.requested++;
                const r = await this.deps.get(`/intraday/quote/${symbol}`);
                if (r.status !== 200 || !r.body) {
                    res.http[String(r.status)] = (res.http[String(r.status)] ?? 0) + 1;
                    if (r.status === 429) limited = true;
                    continue;
                }
                res.ok++;
                if (r.body.date !== ymd) res.other_date++;
                rows.push(trialRow(new Date().toISOString(), r.body));
                if (sm >= 0 && r.body.date === ymd && hasOpened(r.body)) this.opened.add(symbol);
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, symbols.length) }, worker));
        if (limited) this.backoffUntil = now.getTime() + BACKOFF_MS;
        rows.push({
            t: now.toISOString(),
            k: 'cycle',
            ...res,
            skipped_opened: pool.members.length - symbols.length,
            rate_limited: limited,
            ms: Date.now() - started,
        });
        this.append(ymd, rows);
        return res;
    }
}

export function startPreopenTrialRecorder(
    getFugleKey: () => string,
    watchlist: () => string[],
    dataDir: string,
): () => void {
    const rec = new TrialRecorder({
        get: async (path) => {
            const key = getFugleKey();
            return key ? fugleGet(key, path, 8_000) : { status: 0, body: null };
        },
        watchlist,
        dataDir,
    });
    const timer = setInterval(() => {
        if (!getFugleKey()) return;
        void rec.tick().catch(() => null);
    }, 5_000);
    timer.unref();
    return () => clearInterval(timer);
}
