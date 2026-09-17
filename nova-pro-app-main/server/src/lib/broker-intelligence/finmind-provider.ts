// server/src/lib/broker-intelligence/finmind-provider.ts
// FinMind 券商分點（盤後）。Never fabricates names; never mutates A/B/C.

import type {
    BranchDayBundle,
    BranchFreshness,
    BranchTradeRow,
    BrokerProviderCapability,
} from './types.ts';
import {
    UnavailableBrokerBranchProvider,
    type BrokerBranchProvider,
} from './broker-provider.ts';

const FINMIND_BASE = 'https://api.finmindtrade.com/api/v4';
const FRESHNESS: BranchFreshness = 'EOD';
const SOURCE = 'finmind';
/** Covers daily view + history windows (config lookback 20d × 1.6 ≈ 32d). */
const LOOKBACK_CAL_DAYS = 36;
const HOUR_MS = 60 * 60 * 1000;
/** Leave headroom under FinMind free 600/hour. */
export const DEFAULT_FINMIND_MAX_PER_HOUR = 480;
const CACHE_MS = 12 * HOUR_MS;

interface FinMindAggRow {
    securities_trader?: string;
    securities_trader_id?: string;
    stock_id?: string;
    date?: string;
    buy_volume?: number | string;
    sell_volume?: number | string;
    buy?: number | string;
    sell?: number | string;
    buy_price?: number | string;
    sell_price?: number | string;
    price?: number | string;
}

interface FinMindPayload {
    msg?: string;
    status?: number;
    data?: FinMindAggRow[];
}

export interface FinMindFetch {
    (url: string, init?: RequestInit): Promise<Response>;
}

function taipeiYmd(d = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

function addDays(ymd: string, delta: number): string {
    const parts = ymd.split('-');
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    const dt = new Date(Date.UTC(y, m - 1, d + delta));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

function num(v: unknown): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'string') return 0;
    const n = Number(v.replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
}

function sharesToLots(shares: number): number {
    return Math.round((shares / 1000) * 1000) / 1000;
}

export function splitTraderName(raw: string): {
    broker_name: string;
    branch_name: string;
} {
    const name = raw.trim() || '未知分點';
    const cut = name.search(/[-－—]/);
    if (cut > 0) {
        return {
            broker_name: name.slice(0, cut).trim() || name,
            branch_name: name,
        };
    }
    return { broker_name: name, branch_name: name };
}

function brokerIdOf(traderId: string): string {
    if (/^\d{4,}$/.test(traderId)) return traderId.slice(0, 4);
    return traderId || 'unknown';
}

export function rowsFromFinMind(
    symbol: string,
    tradeDate: string,
    raw: FinMindAggRow[],
): BranchTradeRow[] {
    const byId = new Map<
        string,
        {
            name: string;
            buyShares: number;
            sellShares: number;
            buyAmt: number;
            sellAmt: number;
        }
    >();
    for (const r of raw) {
        const id = String(r.securities_trader_id ?? '').trim();
        if (!id) continue;
        const buyShares = num(r.buy_volume ?? r.buy);
        const sellShares = num(r.sell_volume ?? r.sell);
        const buyPx = num(r.buy_price ?? r.price);
        const sellPx = num(r.sell_price ?? r.price);
        const prev = byId.get(id) ?? {
            name: String(r.securities_trader ?? '').trim(),
            buyShares: 0,
            sellShares: 0,
            buyAmt: 0,
            sellAmt: 0,
        };
        const nextName = String(r.securities_trader ?? '').trim();
        prev.name = nextName || prev.name;
        prev.buyShares += buyShares;
        prev.sellShares += sellShares;
        prev.buyAmt += buyPx > 0 ? buyPx * buyShares : 0;
        prev.sellAmt += sellPx > 0 ? sellPx * sellShares : 0;
        byId.set(id, prev);
    }

    const now = new Date().toISOString();
    const rows: BranchTradeRow[] = [];
    for (const [id, v] of byId) {
        const buy_volume = sharesToLots(v.buyShares);
        const sell_volume = sharesToLots(v.sellShares);
        const names = splitTraderName(v.name || id);
        const amount_available = v.buyAmt > 0 || v.sellAmt > 0;
        rows.push({
            symbol,
            trade_date: tradeDate,
            broker_id: brokerIdOf(id),
            broker_name: names.broker_name,
            branch_id: id,
            branch_name: names.branch_name,
            buy_volume,
            sell_volume,
            net_volume:
                Math.round((buy_volume - sell_volume) * 1000) / 1000,
            buy_amount: amount_available ? Math.round(v.buyAmt) : null,
            sell_amount: amount_available ? Math.round(v.sellAmt) : null,
            net_amount: amount_available
                ? Math.round(v.buyAmt - v.sellAmt)
                : null,
            amount_available,
            source: SOURCE,
            updated_at: now,
            freshness: FRESHNESS,
        });
    }
    return rows.sort((a, b) => b.net_volume - a.net_volume);
}

function emptyBundle(
    symbol: string,
    date: string,
    error: string | null,
    available = false,
): BranchDayBundle {
    return {
        symbol,
        trade_date: date,
        freshness: FRESHNESS,
        source: SOURCE,
        rows: [],
        available,
        error,
    };
}

function permissionHint(status: number, body: string): string | null {
    const t = body.toLowerCase();
    if (status === 402) {
        return 'FinMind 本小時次數已用完（免費 600 次/小時），稍後再看個股分點';
    }
    if (status === 401 || status === 403) {
        return 'FinMind token 無效或沒有分點資料權限（免費版通常沒有分點，需要 Sponsor）';
    }
    if (
        t.includes('sponsor') ||
        t.includes('permission') ||
        t.includes('upgrade') ||
        t.includes('level') ||
        t.includes('plan')
    ) {
        return 'FinMind 免費方案沒有券商分點資料集，需要 Sponsor（或以上）才會有分點名稱';
    }
    return null;
}

class HourlyBudget {
    private hits: number[] = [];
    constructor(readonly limit: number) {}
    used(now = Date.now()): number {
        const cut = now - HOUR_MS;
        this.hits = this.hits.filter((t) => t > cut);
        return this.hits.length;
    }
    remaining(now = Date.now()): number {
        return Math.max(0, this.limit - this.used(now));
    }
    take(now = Date.now()): boolean {
        if (this.remaining(now) <= 0) return false;
        this.hits.push(now);
        return true;
    }
    snapshot(now = Date.now()) {
        const used = this.used(now);
        return {
            limit: this.limit,
            used,
            remaining: Math.max(0, this.limit - used),
            window_hours: 1,
        };
    }
}

export interface FinMindProviderOpts {
    fetcher?: FinMindFetch;
    maxPerHour?: number;
}

export class FinMindBrokerBranchProvider implements BrokerBranchProvider {
    readonly id = 'finmind';
    private cache = new Map<
        string,
        { at: number; start: string; end: string; byDate: Map<string, BranchTradeRow[]> }
    >();
    private inflight = new Map<
        string,
        Promise<Map<string, BranchTradeRow[]>>
    >();
    private budget: HourlyBudget;
    private planBlock: string | null = null;
    private fetcher: FinMindFetch;

    constructor(private token: string, opts: FinMindProviderOpts = {}) {
        this.fetcher = opts.fetcher ?? fetch;
        this.budget = new HourlyBudget(
            opts.maxPerHour && opts.maxPerHour > 0
                ? Math.min(opts.maxPerHour, 600)
                : DEFAULT_FINMIND_MAX_PER_HOUR,
        );
    }

    capability(): BrokerProviderCapability {
        return {
            provider_id: this.id,
            branch_trading: true,
            branch_history: true,
            intraday: false,
            amount_fields: true,
            notes:
                'FinMind 分點為盤後資料。免費 600 次/小時：一檔一次、長快取、排名不掃全市場。分點資料集本身通常要 Sponsor。',
        };
    }

    getQuota() {
        return this.budget.snapshot();
    }

    peekCached(symbol: string): BranchDayBundle | null {
        const hit = this.cache.get(symbol.trim());
        if (!hit) return null;
        const end = taipeiYmd();
        for (let i = 0; i <= LOOKBACK_CAL_DAYS; i++) {
            const d = addDays(end, -i);
            const rows = hit.byDate.get(d) ?? [];
            if (rows.length) {
                return {
                    symbol: symbol.trim(),
                    trade_date: d,
                    freshness: FRESHNESS,
                    source: SOURCE,
                    rows,
                    available: true,
                    error: null,
                };
            }
        }
        return null;
    }

    async getBranchTrading(
        symbol: string,
        date?: string,
    ): Promise<BranchDayBundle> {
        const code = symbol.trim();
        const end = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : taipeiYmd();
        const start = addDays(end, -LOOKBACK_CAL_DAYS);
        try {
            const byDate = await this.ensureRange(code, start, end);
            if (date) {
                const rows = byDate.get(date) ?? [];
                if (!rows.length) {
                    return emptyBundle(code, date, '該日尚無 FinMind 分點明細');
                }
                return {
                    symbol: code,
                    trade_date: date,
                    freshness: FRESHNESS,
                    source: SOURCE,
                    rows,
                    available: true,
                    error: null,
                };
            }
            for (let i = 0; i <= LOOKBACK_CAL_DAYS; i++) {
                const d = addDays(end, -i);
                const rows = byDate.get(d) ?? [];
                if (rows.length) {
                    return {
                        symbol: code,
                        trade_date: d,
                        freshness: FRESHNESS,
                        source: SOURCE,
                        rows,
                        available: true,
                        error: null,
                    };
                }
            }
            return emptyBundle(code, end, '近兩週尚無 FinMind 分點明細');
        } catch (e) {
            return emptyBundle(
                code,
                end,
                e instanceof Error ? e.message : String(e),
            );
        }
    }

    async getBranchHistory(
        symbol: string,
        startDate: string,
        endDate: string,
    ): Promise<BranchDayBundle[]> {
        const code = symbol.trim();
        try {
            const byDate = await this.ensureRange(code, startDate, endDate);
            const out: BranchDayBundle[] = [];
            for (const [trade_date, rows] of [...byDate.entries()].sort(
                (a, b) => (a[0] < b[0] ? 1 : -1),
            )) {
                if (trade_date < startDate || trade_date > endDate) continue;
                if (!rows.length) continue;
                out.push({
                    symbol: code,
                    trade_date,
                    freshness: FRESHNESS,
                    source: SOURCE,
                    rows,
                    available: true,
                    error: null,
                });
            }
            return out;
        } catch (e) {
            return [
                emptyBundle(
                    code,
                    endDate,
                    e instanceof Error ? e.message : String(e),
                ),
            ];
        }
    }

    async getTopBranches(
        symbol: string,
        date: string | undefined,
        side: 'buy' | 'sell',
        limit = 10,
    ): Promise<BranchDayBundle> {
        const day = await this.getBranchTrading(symbol, date);
        const sorted = [...day.rows].sort((a, b) =>
            side === 'buy'
                ? b.net_volume - a.net_volume
                : a.net_volume - b.net_volume,
        );
        return { ...day, rows: sorted.slice(0, limit) };
    }

    private async ensureRange(
        symbol: string,
        start: string,
        end: string,
    ): Promise<Map<string, BranchTradeRow[]>> {
        const hit = this.cache.get(symbol);
        if (
            hit &&
            Date.now() - hit.at < CACHE_MS &&
            hit.start <= start &&
            hit.end >= end
        ) {
            return hit.byDate;
        }
        const pending = this.inflight.get(symbol);
        if (pending) return pending;
        const run = this.loadRange(symbol, start, end);
        this.inflight.set(symbol, run);
        try {
            return await run;
        } finally {
            this.inflight.delete(symbol);
        }
    }

    private async loadRange(
        symbol: string,
        start: string,
        end: string,
    ): Promise<Map<string, BranchTradeRow[]>> {
        const rows = await this.fetchAgg(symbol, start, end);
        const byDate = new Map<string, BranchTradeRow[]>();
        const grouped = new Map<string, FinMindAggRow[]>();
        for (const r of rows) {
            const d = String(r.date ?? '').slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
            const list = grouped.get(d) ?? [];
            list.push(r);
            grouped.set(d, list);
        }
        for (const [d, list] of grouped) {
            byDate.set(d, rowsFromFinMind(symbol, d, list));
        }
        this.cache.set(symbol, { at: Date.now(), start, end, byDate });
        return byDate;
    }

    private async fetchAgg(
        symbol: string,
        start: string,
        end: string,
    ): Promise<FinMindAggRow[]> {
        if (this.planBlock) throw new Error(this.planBlock);
        if (!this.budget.take()) {
            throw new Error(
                `FinMind 免費額度保護：本小時最多 ${this.budget.limit} 次（官方 600）。再開過的個股仍可用快取。`,
            );
        }
        const url =
            `${FINMIND_BASE}/taiwan_stock_trading_daily_report_secid_agg` +
            `?data_id=${encodeURIComponent(symbol)}` +
            `&start_date=${encodeURIComponent(start)}` +
            `&end_date=${encodeURIComponent(end)}` +
            `&token=${encodeURIComponent(this.token)}`;
        const res = await this.fetcher(url, {
            headers: {
                Authorization: `Bearer ${this.token}`,
                Accept: 'application/json',
            },
            signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        let payload: FinMindPayload = {};
        try {
            payload = JSON.parse(text) as FinMindPayload;
        } catch {
            const hint = permissionHint(res.status, text);
            if (hint) this.planBlock = hint;
            throw new Error(
                hint ?? `FinMind 回應無法解析（HTTP ${res.status}）`,
            );
        }
        const hint = permissionHint(
            res.status,
            `${payload.msg ?? ''} ${text.slice(0, 400)}`,
        );
        if (hint && (res.status === 401 || res.status === 403 || res.status === 402)) {
            if (res.status !== 402) this.planBlock = hint;
            throw new Error(hint);
        }
        if (!res.ok) {
            throw new Error(
                hint ??
                    `FinMind HTTP ${res.status}${payload.msg ? `：${payload.msg}` : ''}`,
            );
        }
        if (hint) {
            this.planBlock = hint;
            throw new Error(hint);
        }
        if (
            payload.status != null &&
            payload.status !== 200 &&
            payload.status !== 0
        ) {
            const msg =
                permissionHint(payload.status, payload.msg ?? '') ??
                `FinMind：${payload.msg ?? `status ${payload.status}`}`;
            if (payload.status === 401 || payload.status === 403) {
                this.planBlock = msg;
            }
            throw new Error(msg);
        }
        return Array.isArray(payload.data) ? payload.data : [];
    }
}

export function createBrokerBranchProvider(
    token: string | undefined,
    opts?: FinMindProviderOpts,
): BrokerBranchProvider {
    const t = String(token ?? '').trim();
    if (!t) return new UnavailableBrokerBranchProvider();
    return new FinMindBrokerBranchProvider(t, opts);
}
