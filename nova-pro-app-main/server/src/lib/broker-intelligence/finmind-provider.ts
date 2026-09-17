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
const CACHE_MS = 30 * 60 * 1000;
const LOOKBACK_CAL_DAYS = 14;

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
    if (status === 401 || status === 403) {
        return 'FinMind token 無效或沒有分點資料權限（此資料集通常要 Sponsor）';
    }
    if (
        t.includes('sponsor') ||
        t.includes('permission') ||
        t.includes('upgrade') ||
        t.includes('level')
    ) {
        return 'FinMind 帳號方案不足，分點資料需要 Sponsor（或以上）';
    }
    return null;
}

export class FinMindBrokerBranchProvider implements BrokerBranchProvider {
    readonly id = 'finmind';
    private cache = new Map<
        string,
        { at: number; start: string; end: string; byDate: Map<string, BranchTradeRow[]> }
    >();

    constructor(
        private token: string,
        private fetcher: FinMindFetch = fetch,
    ) {}

    capability(): BrokerProviderCapability {
        return {
            provider_id: this.id,
            branch_trading: true,
            branch_history: true,
            intraday: false,
            amount_fields: true,
            notes:
                'FinMind 分點為盤後資料（約 21:00 更新），不是盤中即時主力。',
        };
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
            throw new Error(
                hint ?? `FinMind 回應無法解析（HTTP ${res.status}）`,
            );
        }
        const hint = permissionHint(
            res.status,
            `${payload.msg ?? ''} ${text.slice(0, 400)}`,
        );
        if (!res.ok) {
            throw new Error(
                hint ??
                    `FinMind HTTP ${res.status}${payload.msg ? `：${payload.msg}` : ''}`,
            );
        }
        if (hint) throw new Error(hint);
        if (
            payload.status != null &&
            payload.status !== 200 &&
            payload.status !== 0
        ) {
            throw new Error(
                permissionHint(payload.status, payload.msg ?? '') ??
                    `FinMind：${payload.msg ?? `status ${payload.status}`}`,
            );
        }
        return Array.isArray(payload.data) ? payload.data : [];
    }
}

export function createBrokerBranchProvider(
    token: string | undefined,
    fetcher?: FinMindFetch,
): BrokerBranchProvider {
    const t = String(token ?? '').trim();
    if (!t) return new UnavailableBrokerBranchProvider();
    return new FinMindBrokerBranchProvider(t, fetcher);
}
