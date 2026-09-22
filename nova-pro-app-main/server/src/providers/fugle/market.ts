// server/src/providers/fugle/market.ts — real market data via the official
// @fugle/marketdata SDK (REST + WebSocket), keyed by the user's API key.
//
// Design notes:
//  - snapshots are served from a quote cache: WS trades/books keep it hot
//    for subscribed symbols; cold symbols fall back to REST with a TTL
//    (60s for options — the option chain polls ~34 codes every 10s, which
//    would blow the free-tier 60 req/min REST limit otherwise)
//  - minute candles on Fugle cover only the last ~30 days and ignore
//    from/to, so kbars picks a timeframe by range and filters locally
//  - TXFR1/MXFR1 resolve to the nearest-expiry monthly contract via
//    futopt tickers; SSE ticks are emitted under the resolved code and
//    the frontend's registerCodeAlias maps them back for display

/* eslint-disable @typescript-eslint/no-explicit-any */

import type {
    ContractInfo,
    CreditEnquire,
    HistoryTicks,
    KBars,
    OptContract,
    ScannerItem,
    ScannerType,
    SecurityType,
    ShortSource,
    Snapshot,
    SseBidAsk,
    SseTick,
} from '../../types/dto.ts';
import type {
    BidAskChannel,
    ContractKey,
    MarketDataProvider,
    StreamQuoteType,
    TickChannel,
} from '../market-data.ts';
import {
    bidaskFromBooks,
    dayStateFromQuote,
    kbarsFromCandles,
    scannerItemFromRow,
    snapshotFromState,
    splitTime,
    tickFromTrade,
    type DayState,
} from './map.ts';
import { fetchRegulatoryLists } from './regulatory.ts';
import { fetchTwOvernightPool } from '../../lib/tw-overnight-pool.ts';
import {
    dailyBarsToKBars,
    fetchTwDailyBars,
} from '../../lib/tw-daily-bars.ts';
import {
    deliveryMonthOf,
    fromFugleSymbol,
    isContinuousAlias,
    aliasPrefix,
    parseTaifexOption,
    toFugleSymbol,
} from './symbols.ts';

const QUOTE_TTL_MS = 10_000;
const OPT_QUOTE_TTL_MS = 60_000;
const TICKERS_TTL_MS = 10 * 60_000;
const WS_CONNECT_TIMEOUT_MS = 10_000;
const INIT_PROBE_TIMEOUT_MS = 25_000;

/** TW cash session Mon–Fri 08:50–13:40 Taipei. Snapshot movers/actives 403 overnight. */
function isTwCashSession(now = new Date()): boolean {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Taipei',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(now);
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
    if (wd === 'Sat' || wd === 'Sun') return false;
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const hm = hour * 60 + minute;
    return hm >= 8 * 60 + 50 && hm <= 13 * 60 + 40;
}

// the SDK's ws.connect() promise only settles on (un)authenticated events —
// network errors, closes, and unexpected auth replies leave it pending
// forever, so every await on it must be bounded
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(msg)), ms);
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (err) => {
                clearTimeout(timer);
                reject(
                    err instanceof Error
                        ? err
                        : new Error(`${msg}: ${JSON.stringify(err).slice(0, 200)}`),
                );
            },
        );
    });
}

interface CacheEntry {
    state: DayState;
    exchange: string;
    fetchedAt: number;
}

export class FugleMarketDataProvider implements MarketDataProvider {
    private rest: any;
    private stockWs: any = null;
    private futoptWs: any = null;
    private sdk: any;

    private quoteCache = new Map<string, CacheEntry>(); // by fugle symbol
    private contractCache = new Map<string, ContractInfo>();
    private optChain: OptContract[] | null = null;
    private optChainAt = 0;
    private equityTickers: Array<{ code: string; name: string }> | null = null;
    private equityTickersAt = 0;
    private futTickers: any[] | null = null;
    private futTickersAt = 0;
    private aliasMap = new Map<string, string>(); // TXFR1 → TXFF6

    private subs = new Map<string, Set<StreamQuoteType>>(); // by fugle symbol
    private tickCbs: ((ch: TickChannel, t: SseTick) => void)[] = [];
    private bidaskCbs: ((ch: BidAskChannel, b: SseBidAsk) => void)[] = [];
    private disposed = false;
    private wsFailedUntil = 0; // fail fast instead of re-timing-out per subscribe

    constructor(private apiKey: string) {}

    async init(): Promise<void> {
        if (!this.apiKey) throw new Error('需要 Fugle API Key');
        this.sdk = await import('@fugle/marketdata');
        this.rest = new this.sdk.RestClient({ apiKey: this.apiKey });
        // Cold start + overnight quote can exceed 10s; only 401 means a bad key.
        // Anything else (timeout, 403 after hours, empty body) still starts Fugle
        // so Render does not silently fall back to mock until the next restart.
        try {
            const probe: any = await withTimeout<any>(
                this.rest.stock.intraday.quote({ symbol: '2330' }),
                INIT_PROBE_TIMEOUT_MS,
                'Fugle REST API 連線逾時',
            );
            if (probe?.statusCode === 401 || probe?.status === 401) {
                throw new Error('Fugle API Key 無效（401）');
            }
            if (probe?.statusCode && probe.statusCode >= 400) {
                console.warn(
                    `fugle init: quote probe ${probe.statusCode} — starting anyway`,
                );
                return;
            }
            if (!probe?.symbol) {
                console.warn(
                    'fugle init: quote probe empty — starting anyway (key present)',
                );
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/401|無效/.test(msg)) throw err instanceof Error ? err : new Error(msg);
            console.warn(`fugle init: ${msg} — starting anyway (key present)`);
        }
    }

    dispose(): void {
        this.disposed = true;
        try {
            this.stockWs?.disconnect?.();
        } catch { /* already closed */ }
        try {
            this.futoptWs?.disconnect?.();
        } catch { /* already closed */ }
    }

    contractCount(): number {
        return this.contractCache.size + (this.optChain?.length ?? 0);
    }

    // ---- websocket plumbing ----

    private async ensureWs(kind: 'stock' | 'futopt'): Promise<any> {
        const existing = kind === 'stock' ? this.stockWs : this.futoptWs;
        if (existing) return existing;
        if (Date.now() < this.wsFailedUntil) {
            throw new Error('Fugle WebSocket 暫時不可用（稍後自動重試）');
        }
        const client = new this.sdk.WebSocketClient({ apiKey: this.apiKey });
        const ws = kind === 'stock' ? client.stock : client.futopt;
        ws.on('message', (raw: any) => {
            try {
                const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
                this.handleWsMessage(kind, msg);
            } catch {
                // malformed frame — ignore
            }
        });
        ws.on('error', () => undefined);
        ws.on('close', () => {
            if (kind === 'stock') this.stockWs = null;
            else this.futoptWs = null;
            if (!this.disposed) {
                setTimeout(() => void this.resubscribe(kind), 3000);
            }
        });
        try {
            await withTimeout(
                ws.connect(),
                WS_CONNECT_TIMEOUT_MS,
                'Fugle WebSocket 認證逾時（方案可能未含即時行情，或網路被阻擋）',
            );
        } catch (err) {
            this.wsFailedUntil = Date.now() + 60_000;
            try {
                ws.disconnect?.();
            } catch {
                /* socket may not exist */
            }
            throw err;
        }
        this.wsFailedUntil = 0;
        if (kind === 'stock') this.stockWs = ws;
        else this.futoptWs = ws;
        return ws;
    }

    /** probe WS availability once; lets callers degrade to REST-only mode */
    async probeWebSocket(): Promise<string | null> {
        try {
            await this.ensureWs('stock');
            return null;
        } catch (err) {
            return err instanceof Error ? err.message : String(err);
        }
    }

    private async resubscribe(kind: 'stock' | 'futopt'): Promise<void> {
        try {
            const ws = await this.ensureWs(kind);
            for (const [symbol, quotes] of this.subs) {
                if (this.wsKindFor(symbol) !== kind) continue;
                if (quotes.has('Tick')) {
                    ws.subscribe({ channel: 'trades', symbol });
                }
                if (quotes.has('BidAsk')) {
                    ws.subscribe({ channel: 'books', symbol });
                }
            }
        } catch {
            if (!this.disposed) {
                setTimeout(() => void this.resubscribe(kind), 5000);
            }
        }
    }

    private wsKindFor(symbol: string): 'stock' | 'futopt' {
        return /^(TXF|MXF|TMF|TXO|EXF|FXF|ZF|MX)/.test(symbol) &&
            !/^\d/.test(symbol)
            ? 'futopt'
            : 'stock';
    }

    private channelFor(symbol: string): {
        tick: TickChannel;
        bidask: BidAskChannel;
    } {
        return this.wsKindFor(symbol) === 'futopt'
            ? { tick: 'tick_fop', bidask: 'bidask_fop' }
            : { tick: 'tick_stk', bidask: 'bidask_stk' };
    }

    private handleWsMessage(_kind: 'stock' | 'futopt', msg: any): void {
        if (msg?.event !== 'data' || !msg.data) return;
        const data = msg.data;
        const symbol = String(data.symbol ?? '');
        if (!symbol) return;
        const channels = this.channelFor(symbol);
        if (msg.channel === 'trades') {
            const entry = this.quoteCache.get(symbol);
            const state = entry?.state ?? dayStateFromQuote({});
            if (!entry) {
                this.quoteCache.set(symbol, {
                    state,
                    exchange: this.wsKindFor(symbol) === 'futopt' ? 'TAIFEX' : 'TSE',
                    fetchedAt: 0, // REST refresh still allowed to fill totals
                });
            }
            const tick = tickFromTrade(symbol, data, state);
            const appCode = fromFugleSymbol(symbol);
            if (appCode !== symbol) tick.code = appCode;
            for (const cb of this.tickCbs) cb(channels.tick, tick);
        } else if (msg.channel === 'books') {
            const bidask = bidaskFromBooks(symbol, data);
            const entry = this.quoteCache.get(symbol);
            if (entry) {
                entry.state.bid = Number(data.bids?.[0]?.price) || entry.state.bid;
                entry.state.ask = Number(data.asks?.[0]?.price) || entry.state.ask;
            }
            const appCode = fromFugleSymbol(symbol);
            if (appCode !== symbol) bidask.code = appCode;
            for (const cb of this.bidaskCbs) cb(channels.bidask, bidask);
        }
    }

    // ---- REST quote cache ----

    private async fetchQuote(symbol: string): Promise<CacheEntry | null> {
        const isFutopt = this.wsKindFor(symbol) === 'futopt';
        const ttl = symbol.startsWith('TXO') ? OPT_QUOTE_TTL_MS : QUOTE_TTL_MS;
        const cached = this.quoteCache.get(symbol);
        if (cached && Date.now() - cached.fetchedAt < ttl) return cached;
        // WS-hot entries skip REST refresh entirely
        if (cached && Date.now() - cached.state.lastUpdatedMs < QUOTE_TTL_MS) {
            return cached;
        }
        try {
            const q = isFutopt
                ? await this.rest.futopt.intraday.quote({ symbol })
                : await this.rest.stock.intraday.quote({ symbol });
            if (!q || q.statusCode >= 400 || !q.symbol) return cached ?? null;
            const entry: CacheEntry = {
                state: dayStateFromQuote(q),
                exchange: isFutopt
                    ? 'TAIFEX'
                    : q.market === 'OTC' || q.market === 'TPEx'
                      ? 'OTC'
                      : 'TSE',
                fetchedAt: Date.now(),
            };
            // don't clobber a fresher WS price with a stale REST one
            if (cached && cached.state.lastUpdatedMs > entry.state.lastUpdatedMs) {
                entry.state.last = cached.state.last;
            }
            this.quoteCache.set(symbol, entry);
            return entry;
        } catch {
            return cached ?? null;
        }
    }

    // ---- contracts ----

    private futoptForbiddenWarned = false;

    private warnIfForbidden(res: any): void {
        if (res?.statusCode === 403 && !this.futoptForbiddenWarned) {
            this.futoptForbiddenWarned = true;
            console.warn(
                'Fugle 期權行情回應 403 — 此 API Key 的方案未含期貨/選擇權行情，' +
                    '台指期與選擇權 T 字將無資料（證券行情不受影響）',
            );
        }
    }

    private async futuresTickers(): Promise<any[]> {
        if (this.futTickers && Date.now() - this.futTickersAt < TICKERS_TTL_MS) {
            return this.futTickers;
        }
        const res = await this.rest.futopt.intraday.tickers({ type: 'FUTURE' });
        this.warnIfForbidden(res);
        this.futTickers = Array.isArray(res?.data) ? res.data : [];
        this.futTickersAt = Date.now();
        return this.futTickers!;
    }

    /** nearest-expiry monthly contract for a continuous alias like TXFR1 */
    private async resolveAlias(code: string): Promise<string | null> {
        const hit = this.aliasMap.get(code);
        if (hit) return hit;
        const prefix = aliasPrefix(code); // TXF / MXF
        const tickers = await this.futuresTickers();
        const candidates = tickers
            .map((t: any) => String(t.symbol ?? ''))
            .filter((s: string) => new RegExp(`^${prefix}[A-L]\\d$`).test(s));
        if (candidates.length === 0) return null;
        // sort by delivery month and take the nearest non-expired
        const now = new Date();
        const scored = candidates
            .map((s: string) => {
                const letter = s.charCodeAt(3) - 64;
                const month = deliveryMonthOf(letter, Number(s[4]), now);
                return { s, month };
            })
            .sort((a, b) => a.month.localeCompare(b.month));
        const current = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
        const front = scored.find((x) => x.month >= current) ?? scored[0]!;
        this.aliasMap.set(code, front.s);
        return front.s;
    }

    aliasTarget(code: string): string | undefined {
        return this.aliasMap.get(code);
    }

    private async equityTickerList(): Promise<Array<{ code: string; name: string }>> {
        if (
            this.equityTickers &&
            Date.now() - this.equityTickersAt < TICKERS_TTL_MS
        ) {
            return this.equityTickers;
        }
        const [twse, tpex] = await Promise.all([
            this.rest.stock.intraday.tickers({
                type: 'EQUITY',
                exchange: 'TWSE',
            }),
            this.rest.stock.intraday.tickers({
                type: 'EQUITY',
                exchange: 'TPEx',
            }),
        ]);
        const rows = [
            ...(Array.isArray(twse?.data) ? twse.data : []),
            ...(Array.isArray(tpex?.data) ? tpex.data : []),
        ];
        this.equityTickers = rows
            .map((r: any) => ({
                code: String(r.symbol ?? '').trim(),
                name: String(r.name ?? '').trim(),
            }))
            .filter((x: { code: string }) => x.code);
        this.equityTickersAt = Date.now();
        return this.equityTickers;
    }

    async searchSymbols(
        q: string,
    ): Promise<Array<{ code: string; name: string }>> {
        const needle = q.trim();
        if (!needle) return [];
        const nq = needle.toLowerCase();
        const list = await this.equityTickerList();
        const scored: Array<{ code: string; name: string; score: number }> = [];
        for (const t of list) {
            const code = t.code.toLowerCase();
            const name = t.name.toLowerCase();
            let score = -1;
            if (code === nq || t.name === needle) score = 0;
            else if (code.startsWith(nq) || t.name.startsWith(needle)) score = 1;
            else if (name.includes(nq) || t.name.includes(needle)) score = 2;
            if (score >= 0) scored.push({ ...t, score });
        }
        scored.sort(
            (a, b) => a.score - b.score || a.code.localeCompare(b.code),
        );
        return scored.slice(0, 25).map(({ code, name }) => ({ code, name }));
    }

    async resolveContract(
        code: string,
        type: SecurityType,
    ): Promise<ContractInfo | null> {
        const cacheKey = `${code}:${type}`;
        const cached = this.contractCache.get(cacheKey);
        if (cached) return cached;

        let info: ContractInfo | null = null;
        if (type === 'IND') {
            const entry = await this.fetchQuote(toFugleSymbol(code));
            if (entry) {
                info = this.contractInfo(code, 'IND', 'TSE', entry.state);
            }
        } else if (type === 'STK') {
            if (/^[A-Z]/.test(code)) return null; // futures-style code — let FUT fallback handle it
            const entry = await this.fetchQuote(code);
            if (entry) {
                info = this.contractInfo(code, 'STK', entry.exchange, entry.state);
            }
        } else if (type === 'FUT') {
            const actual = isContinuousAlias(code)
                ? await this.resolveAlias(code)
                : code;
            if (!actual) return null;
            const entry = await this.fetchQuote(actual);
            if (entry) {
                info = this.contractInfo(code, 'FUT', 'TAIFEX', entry.state);
                info.target_code = actual !== code ? actual : null;
                info.category = aliasPrefix(actual);
            }
        } else if (type === 'OPT') {
            const chain = await this.listOptionContracts();
            const opt = chain.find((c) => c.code === code);
            if (opt) {
                const entry = await this.fetchQuote(code);
                info = this.contractInfo(
                    code,
                    'OPT',
                    'TAIFEX',
                    entry?.state ?? dayStateFromQuote({}),
                );
                info.category = opt.category;
            }
        }
        if (info) this.contractCache.set(cacheKey, info);
        return info;
    }

    private contractInfo(
        code: string,
        type: SecurityType,
        exchange: string,
        state: DayState,
    ): ContractInfo {
        const ref = state.previousClose || state.last;
        return {
            exchange: exchange as ContractInfo['exchange'],
            code,
            security_type: type,
            target_code: null,
            name: state.name || code,
            currency: 'TWD',
            limit_up: Math.round(ref * 1.1 * 100) / 100,
            limit_down: Math.round(ref * 0.9 * 100) / 100,
            reference: ref,
            day_trade: type === 'STK' ? 'Yes' : '',
            update_date: new Date().toISOString().slice(0, 10).replace(/-/g, '/'),
            category: '',
            margin_trading_balance: 0,
            short_selling_balance: 0,
        };
    }

    displayName(code: string): string | undefined {
        const entry = this.quoteCache.get(toFugleSymbol(code));
        return entry?.state.name || undefined;
    }

    lastPrice(code: string): number | undefined {
        const symbol = this.aliasMap.get(code) ?? toFugleSymbol(code);
        const last = this.quoteCache.get(symbol)?.state.last;
        return last && last > 0 ? last : undefined;
    }

    async listOptionContracts(): Promise<OptContract[]> {
        if (this.optChain && Date.now() - this.optChainAt < TICKERS_TTL_MS) {
            return this.optChain;
        }
        const res = await this.rest.futopt.intraday.tickers({ type: 'OPTION' });
        this.warnIfForbidden(res);
        const rows: any[] = Array.isArray(res?.data) ? res.data : [];
        const out: OptContract[] = [];
        for (const row of rows) {
            const symbol = String(row.symbol ?? '');
            if (!symbol.startsWith('TXO')) continue;
            const parsed = parseTaifexOption(symbol);
            if (!parsed) continue;
            const month = deliveryMonthOf(parsed.month, parsed.yearDigit);
            out.push({
                code: symbol,
                exchange: 'TAIFEX',
                security_type: 'OPT',
                category: 'TXO',
                delivery_month: month,
                delivery_date: '',
                strike_price: parsed.strike,
                option_right: parsed.right,
                reference: Number(row.referencePrice) || 0,
            });
        }
        this.optChain = out;
        this.optChainAt = Date.now();
        return out;
    }

    // ---- market data ----

    async snapshots(keys: ContractKey[]): Promise<Snapshot[]> {
        const out: Snapshot[] = [];
        for (const key of keys) {
            const symbol = isContinuousAlias(key.code)
                ? ((await this.resolveAlias(key.code)) ?? key.code)
                : toFugleSymbol(key.code);
            const entry = await this.fetchQuote(symbol);
            if (entry) {
                out.push(snapshotFromState(key.code, entry.exchange, entry.state));
            }
        }
        return out;
    }

    async kbars(key: ContractKey, start: string, end: string): Promise<KBars> {
        const symbol = isContinuousAlias(key.code)
            ? ((await this.resolveAlias(key.code)) ?? key.code)
            : toFugleSymbol(key.code);
        const isFutopt = this.wsKindFor(symbol) === 'futopt';
        const rangeDays = Math.max(
            0,
            (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000,
        );

        if (isFutopt) {
            // fugle has no historical futopt candles — intraday (today) only
            const res = await this.rest.futopt.intraday.candles({ symbol });
            return kbarsFromCandles(res?.data ?? [], false);
        }

        // Fugle: from~to must be STRICTLY < 1 year (exactly 365 days → 400).
        const safeStart =
            rangeDays >= 364
                ? new Date(new Date(end).getTime() - 360 * 86_400_000)
                      .toISOString()
                      .slice(0, 10)
                : start;

        // minute candles ignore from/to and return ~30 days; filter locally
        const timeframe =
            rangeDays <= 5
                ? '1'
                : rangeDays <= 12
                  ? '5'
                  : rangeDays <= 35
                    ? '15'
                    : rangeDays <= 70
                      ? '60'
                      : 'D';

        const tryFugle = async (tf: string, from: string, to: string) => {
            const res = await this.rest.stock.historical.candles({
                symbol,
                timeframe: tf,
                sort: 'asc',
                from,
                to,
            });
            const rows: any[] = (res?.data ?? []).filter((r: any) => {
                const d = String(r.date ?? '').slice(0, 10);
                return d >= from && d <= to;
            });
            const isIndex = key.security_type === 'IND';
            return kbarsFromCandles(rows, !isIndex);
        };

        try {
            const mapped = await tryFugle(timeframe, safeStart, end);
            if (mapped.datetime.length > 0) return mapped;
        } catch (err) {
            console.warn(
                `Fugle kbars failed for ${symbol} (${timeframe}):`,
                err instanceof Error ? err.message : err,
            );
        }

        // Minute empty / 404 after hours → try Fugle daily before Yahoo
        if (timeframe !== 'D') {
            try {
                const daily = await tryFugle('D', safeStart, end);
                if (daily.datetime.length > 0) {
                    console.info(
                        `Fugle daily kbars fallback for ${symbol}: ${daily.datetime.length} bars`,
                    );
                    return daily;
                }
            } catch (err) {
                console.warn(
                    `Fugle daily fallback failed for ${symbol}:`,
                    err instanceof Error ? err.message : err,
                );
            }
        }

        // After-hours / plan gaps: Yahoo daily fallback for TW stocks
        if (key.security_type === 'STK' || !key.security_type) {
            try {
                const yahooRange =
                    rangeDays > 200 ? '1y' : rangeDays > 60 ? '6mo' : '3mo';
                const daily = await fetchTwDailyBars(key.code, yahooRange);
                const clipped = daily.filter(
                    (b) => b.date >= safeStart && b.date <= end,
                );
                const use = clipped.length >= 5 ? clipped : daily;
                if (use.length > 0) {
                    console.info(
                        `Yahoo daily kbars fallback for ${key.code}: ${use.length} bars`,
                    );
                    return dailyBarsToKBars(use);
                }
            } catch (err) {
                console.warn(
                    `Yahoo kbars fallback failed for ${key.code}:`,
                    err instanceof Error ? err.message : err,
                );
            }
        }
        return kbarsFromCandles([], true);
    }

    async ticks(
        key: ContractKey,
        date: string,
        lastCount?: number,
    ): Promise<HistoryTicks> {
        const out: HistoryTicks = {
            datetime: [],
            close: [],
            volume: [],
            bid_price: [],
            bid_volume: [],
            ask_price: [],
            ask_volume: [],
            tick_type: [],
        };
        const today = new Date().toISOString().slice(0, 10);
        if (date !== today) return out; // fugle serves intraday trades only
        const symbol = isContinuousAlias(key.code)
            ? ((await this.resolveAlias(key.code)) ?? key.code)
            : toFugleSymbol(key.code);
        const isFutopt = this.wsKindFor(symbol) === 'futopt';
        try {
            const res = isFutopt
                ? await this.rest.futopt.intraday.trades({ symbol })
                : await this.rest.stock.intraday.trades({
                      symbol,
                      limit: lastCount ?? 1000,
                  });
            const rows: any[] = (res?.data ?? []).slice().reverse(); // API returns newest first
            for (const row of rows) {
                const { date: d, time } = splitTime(row.time);
                out.datetime.push(`${d} ${time}`);
                out.close.push(Number(row.price) || 0);
                out.volume.push(Number(row.size) || 0);
                out.bid_price.push(Number(row.bid) || 0);
                out.bid_volume.push(0);
                out.ask_price.push(Number(row.ask) || 0);
                out.ask_volume.push(0);
                const price = Number(row.price) || 0;
                out.tick_type.push(
                    row.ask && price >= Number(row.ask)
                        ? 1
                        : row.bid && price <= Number(row.bid)
                          ? 2
                          : 0,
                );
            }
            if (lastCount && out.datetime.length > lastCount) {
                for (const k of Object.keys(out) as (keyof HistoryTicks)[]) {
                    out[k] = out[k].slice(-lastCount) as never;
                }
            }
        } catch {
            // no intraday data (e.g. pre-market) — empty arrays are fine
        }
        return out;
    }

    async scanner(
        type: ScannerType,
        count: number,
        ascending: boolean,
    ): Promise<ScannerItem[]> {
        if (!isTwCashSession()) {
            return fetchTwOvernightPool(type, count);
        }
        const markets = ['TSE', 'OTC'];
        let rows: any[] = [];
        try {
            if (type === 'ChangePercentRank' || type === 'ChangePriceRank') {
                const res = await Promise.all(
                    markets.map((market) =>
                        this.rest.stock.snapshot.movers({
                            market,
                            change:
                                type === 'ChangePercentRank'
                                    ? 'percent'
                                    : 'value',
                            direction: ascending ? 'down' : 'up',
                            type: 'COMMONSTOCK',
                        }),
                    ),
                );
                rows = res.flatMap((r: any) => {
                    if (r?.statusCode && r.statusCode >= 400) {
                        console.warn(
                            `Fugle movers ${r.statusCode}: ${r.message ?? ''}`,
                        );
                        return [];
                    }
                    return r?.data ?? [];
                });
                rows.sort((a, b) =>
                    ascending
                        ? Number(a.changePercent ?? a.change) -
                          Number(b.changePercent ?? b.change)
                        : Number(b.changePercent ?? b.change) -
                          Number(a.changePercent ?? a.change),
                );
            } else if (
                type === 'VolumeRank' ||
                type === 'AmountRank' ||
                type === 'TickCountRank'
            ) {
                const trade = type === 'AmountRank' ? 'value' : 'volume';
                const res = await Promise.all(
                    markets.map((market) =>
                        this.rest.stock.snapshot.actives({
                            market,
                            trade,
                            type: 'COMMONSTOCK',
                        }),
                    ),
                );
                rows = res.flatMap((r: any) => {
                    if (r?.statusCode && r.statusCode >= 400) {
                        console.warn(
                            `Fugle actives ${r.statusCode}: ${r.message ?? ''}`,
                        );
                        return [];
                    }
                    return r?.data ?? [];
                });
                rows.sort((a, b) =>
                    trade === 'value'
                        ? Number(b.tradeValue) - Number(a.tradeValue)
                        : Number(b.tradeVolume) - Number(a.tradeVolume),
                );
            } else {
                rows = [];
            }
        } catch (err) {
            console.warn(
                'Fugle scanner failed:',
                err instanceof Error ? err.message : err,
            );
            rows = [];
        }

        if (rows.length > 0) {
            return rows.slice(0, count).map((row) =>
                scannerItemFromRow(
                    row,
                    type === 'AmountRank'
                        ? Number(row.tradeValue) || 0
                        : type === 'VolumeRank'
                          ? Number(row.tradeVolume) || 0
                          : Number(row.changePercent ?? row.change) || 0,
                ),
            );
        }

        // After hours / plan without snapshot rankings → Yahoo daily pool
        console.warn(
            `Fugle snapshot empty for ${type}; using overnight Yahoo pool`,
        );
        return fetchTwOvernightPool(type, count);
    }

    // credit/short-source data has no fugle source — frontend handles empty
    async creditEnquire(_keys: ContractKey[]): Promise<CreditEnquire[]> {
        return [];
    }

    async shortStockSources(_keys: ContractKey[]): Promise<ShortSource[]> {
        return [];
    }

    async regulatoryPunish(): Promise<{ code: string[]; attention: string[] }> {
        return fetchRegulatoryLists();
    }

    // ---- subscriptions ----

    async subscribe(key: ContractKey, quote: StreamQuoteType): Promise<void> {
        if (key.security_type === 'IND') return; // index served via REST polling
        const symbol = isContinuousAlias(key.code)
            ? ((await this.resolveAlias(key.code)) ?? key.code)
            : toFugleSymbol(key.code);
        let set = this.subs.get(symbol);
        if (!set) {
            set = new Set();
            this.subs.set(symbol, set);
        }
        if (set.has(quote)) return;
        set.add(quote);
        // seed day state so the first WS tick has open/high/low context
        await this.fetchQuote(symbol);
        const ws = await this.ensureWs(this.wsKindFor(symbol));
        ws.subscribe({
            channel: quote === 'Tick' ? 'trades' : 'books',
            symbol,
        });
    }

    async unsubscribe(key: ContractKey, quote: StreamQuoteType): Promise<void> {
        const symbol = this.aliasMap.get(key.code) ?? toFugleSymbol(key.code);
        const set = this.subs.get(symbol);
        if (!set?.delete(quote)) return;
        if (set.size === 0) this.subs.delete(symbol);
        const ws = this.wsKindFor(symbol) === 'stock' ? this.stockWs : this.futoptWs;
        ws?.unsubscribe?.({
            channel: quote === 'Tick' ? 'trades' : 'books',
            symbol,
        });
    }

    onTick(cb: (channel: TickChannel, tick: SseTick) => void): void {
        this.tickCbs.push(cb);
    }

    onBidAsk(cb: (channel: BidAskChannel, bidask: SseBidAsk) => void): void {
        this.bidaskCbs.push(cb);
    }
}
