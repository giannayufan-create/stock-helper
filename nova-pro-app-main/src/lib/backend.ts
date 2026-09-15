// src/lib/backend.ts — REST client for the local nova-pro-server

import { apiGet, apiPost, apiPut } from './api';
import type {
    ContractBase,
    ContractInfo,
    SecurityType,
} from './types/contract';
import type { Health } from './types/health';
import type {
    KBars,
    QuoteTypeName,
    ScannerItem,
    ScannerType,
    Snapshot,
    SubscriptionResponse,
} from './types/market';
import type {
    FuturesOrderReq,
    StockOrderReq,
    Trade,
} from './types/order';
import type {
    Account,
    AccountBalance,
    AccountTypeName,
    FuturePosition,
    Margin,
    StockPosition,
} from './types/portfolio';
import { registerSubscription } from './stream';
import type { HistoryTicks } from './types/tick';
import { todayStr } from './utils/date';

export interface ServerInfo {
    name: string;
    version: string;
    description: string;
    protocols: string[];
    simulation: boolean;
    capabilities?: { futures_trading: boolean };
}

function contractKey(c: ContractBase) {
    return {
        security_type: c.security_type,
        exchange: c.exchange,
        code: c.code,
    };
}

// ---- market source config ----

export interface MarketConfig {
    provider: 'mock' | 'fugle' | 'shioaji';
    has_key: boolean;
    has_shioaji?: boolean;
}

export function fetchMarketConfig() {
    return apiGet<MarketConfig>('/api/v1/config/market');
}

/** validate + save a Fugle API key and hot-swap the market provider */
export function setMarketSource(body: {
    api_key?: string;
    provider?: 'mock' | 'fugle' | 'shioaji';
}) {
    return apiPost<{
        provider: 'mock' | 'fugle' | 'shioaji';
        warning?: string;
    }>('/api/v1/config/market', body);
}

// ---- health / info / auth ----

export function fetchHealth() {
    return apiGet<Health>('/api/v1/health');
}

export function fetchInfo() {
    return apiGet<ServerInfo>('/api/v1/info');
}

export function fetchAccounts() {
    return apiGet<Account[]>('/api/v1/auth/accounts');
}

// ---- contracts ----

export function fetchSymbolSearch(q: string) {
    const qs = new URLSearchParams({ q: q.trim() });
    return apiGet<{ hits: Array<{ code: string; name: string }> }>(
        `/api/v1/data/search?${qs.toString()}`,
    );
}

/** ticker stays uppercase; Chinese names resolve via search API */
export async function resolveSymbolQuery(q: string): Promise<string | null> {
    const raw = q.trim();
    if (!raw) return null;
    if (/^[0-9A-Za-z.]+$/.test(raw)) return raw.toUpperCase();
    const { hits } = await fetchSymbolSearch(raw);
    return hits[0]?.code ?? null;
}

export function fetchContract(
    code: string,
    securityType: SecurityType = 'STK',
) {
    const qs = new URLSearchParams({ security_type: securityType ?? '' });
    return apiGet<ContractInfo>(
        `/api/v1/data/contracts/${encodeURIComponent(code)}?${qs.toString()}`,
    );
}

// ---- market data ----

export function fetchSnapshots(contracts: ContractBase[]) {
    return apiPost<Snapshot[]>('/api/v1/data/snapshots', {
        contracts: contracts.map(contractKey),
    });
}

export function fetchKbars(contract: ContractBase, start: string, end: string) {
    return apiPost<KBars>('/api/v1/data/kbars', {
        contract: contractKey(contract),
        start,
        end,
    });
}

export function fetchHistoryTicks(contract: ContractBase, date: string) {
    return apiPost<HistoryTicks>('/api/v1/data/ticks', {
        contract: contractKey(contract),
        date,
    });
}

export function fetchLastTicks(
    contract: ContractBase,
    count: number,
    date = todayStr(),
) {
    return apiPost<HistoryTicks>('/api/v1/data/ticks', {
        contract: contractKey(contract),
        date,
        query_type: 'LastCount',
        last_cnt: count,
    });
}

export function fetchScanner(
    scannerType: ScannerType,
    count = 30,
    ascending = false,
) {
    return apiPost<ScannerItem[]>('/api/v1/data/scanner', {
        scanner_type: scannerType,
        date: todayStr(),
        ascending,
        count,
    });
}

/** 全上市櫃 OpenAPI 宇宙＋多日技術／法人連買／集保 */
export interface FullScreenerItem extends ScannerItem {
    market?: 'tse' | 'otc';
    tech_delta?: number;
    streak_delta?: number;
    tdcc_delta?: number;
    openapi_delta?: number;
    factors?: {
        vol_ratio_20: number | null;
        rs_20: number | null;
        near_high_20: number | null;
        above_ma20: boolean | null;
        inst_buy_streak: number | null;
        tdcc_large_pct: number | null;
        pe?: number | null;
        pb?: number | null;
        yield_pct?: number | null;
        revenue_yoy?: number | null;
        revenue_mom?: number | null;
        day_trade_pct?: number | null;
        ex_div_soon?: boolean | null;
        industry?: string | null;
        punished?: boolean;
        attention?: boolean;
    };
    factor_notes?: string[];
}

export interface FullScreenerResult {
    as_of: string | null;
    universe_count: number;
    liquid_count: number;
    enriched_count: number;
    items: FullScreenerItem[];
    warnings: string[];
    took_ms: number;
}

export function fetchFullScreener(opts?: {
    techLimit?: number;
    tdccLimit?: number;
}) {
    return apiPost<FullScreenerResult>('/api/v1/data/full-screener', {
        tech_limit: opts?.techLimit ?? 160,
        tdcc_limit: opts?.tdccLimit ?? 50,
    });
}

/** [B] OPEN GATE v1 — legacy snapshot gate (kept for fallback) */
export type OpenConfirmStatus =
    | 'provisional'
    | 'early'
    | 'early_pass'
    | 'pass'
    | 'watch'
    | 'reject'
    | 'n/a';

export interface OpenGateItem {
    code: string;
    name?: string;
    a_score?: number;
    as_of: string;
    stage: 'B0' | 'B1' | 'B2' | 'AFTER';
    open_confirm: OpenConfirmStatus;
    open_score: number;
    dims: {
        gap: number;
        rvol: number;
        price: number;
        momentum: number;
        chase: number;
    };
    metrics: {
        prev_close: number;
        open: number;
        last: number;
        vwap: number | null;
        gap_pct: number;
        chg_from_open_pct: number;
        day_chg_pct: number;
        rvol_5: number | null;
        rvol_10: number | null;
        rvol_15: number | null;
        held_open: boolean;
        above_vwap: boolean;
        higher_highs: boolean;
        pullback_from_high_pct: number;
        session_minutes: number;
    };
    reasons: string[];
    tradable: boolean;
    lite?: boolean;
}

export interface OpenGateResult {
    stage: 'B0' | 'B1' | 'B2' | 'AFTER';
    as_of: string;
    session_minutes: number;
    count: number;
    pass: number;
    watch: number;
    reject: number;
    items: OpenGateItem[];
    warnings: string[];
}

export function fetchOpenGate(opts: {
    codes: Array<{ code: string; name?: string; a_score?: number }>;
    includeScannerSurges?: boolean;
}) {
    return apiPost<OpenGateResult>('/api/v1/data/open-gate', {
        codes: opts.codes,
        include_scanner_surges: opts.includeScannerSurges ?? true,
    });
}

/** [B] OPEN GATE v2 — Final Patch contract */
export interface OpenConfirmV2Item {
    symbol: string;
    name?: string;
    timestamp: string;
    a_score: number;
    a_score_source?: 'legacy_frontend' | 'server';
    phase: 'provisional' | 'early' | 'confirmed' | 'after';
    tradeable: boolean;
    tradeable_candidate?: boolean;
    raw_open_score: number;
    market_adjustment: number;
    liquidity_adjustment: number;
    risk_adjustment: number;
    final_open_score: number;
    open_confirm: OpenConfirmStatus;
    hard_reject: boolean;
    soft_reject?: boolean;
    data_blocked?: boolean;
    market_regime: string;
    market_score: number;
    score_components?: {
        rvol_score: number;
        vwap_score: number;
        open_hold_score: number;
        pullback_score: number;
        momentum_score: number;
        gap_score: number;
    };
    metrics: {
        gap_pct: number;
        rvol_same_time: number | null;
        vwap: number | null;
        vwap_pos_pct: number | null;
        vwap_source?: string | null;
        vwap_valid?: boolean;
        open_pos_pct: number | null;
        high_pullback_pct: number | null;
        momentum_score: number;
        spread_pct: number | null;
    };
    risk: {
        chase_risk: 'low' | 'medium' | 'high' | 'extreme';
        invalid_price: number | null;
        invalid_reason?: string | null;
        risk_pct: number | null;
        risk_distance_pct?: number | null;
        risk_score?: number;
        risk_adjustment?: number;
    };
    liquidity_score: number;
    reasons: string[];
    risks: string[];
    data_health: 'healthy' | 'degraded' | 'stale' | 'disconnected';
    signal_status: 'active' | 'expired';
    signal_expired?: boolean;
    evaluation_stale?: boolean;
    confirmation_count?: number;
    pass_streak?: number;
    signal_maturity?: string;
    open_gate_passed_before_cutoff?: boolean;
    late_candidate?: boolean;
    evaluation_id?: string;
    signal_id?: string | null;
    generated_at: string;
    fresh_until?: string;
    signal_valid_until?: string;
    expires_at: string;
    ttl_seconds: number;
}

export interface OpenConfirmV2Result {
    phase: 'provisional' | 'early' | 'confirmed' | 'after';
    as_of: string;
    session_minutes: number;
    count: number;
    pass: number;
    watch: number;
    reject: number;
    early_pass?: number;
    provisional?: number;
    tradeable_count?: number;
    items: OpenConfirmV2Item[];
    market_regime: string;
    market_score: number;
    warnings: string[];
    evaluate_interval_sec: number;
    adapted?: number;
    a_pool_updated_at?: string | null;
}

export function fetchOpenConfirm(opts: {
    codes: Array<{
        code: string;
        name?: string;
        a_score?: number;
        strength?: number;
        market?: string;
        close?: number;
        total_volume?: number;
        total_amount?: number;
        volume_ratio?: number;
        yesterday_volume?: number;
        factors?: FullScreenerItem['factors'];
        lite?: boolean;
        source?: 'eod_a' | 'scanner_candidate';
    }>;
}) {
    return apiPost<OpenConfirmV2Result>('/api/v1/data/open-confirm', {
        codes: opts.codes,
    });
}

/** Read-only B latest — does NOT setCandidates / sync / evaluate. */
export function fetchOpenConfirmLatest() {
    return apiGet<OpenConfirmV2Result>('/api/v1/data/open-confirm');
}

/** [C] Intraday Rank */
export interface IntradayRankItemDto {
    symbol: string;
    name: string;
    candidate_origin: string;
    candidate_sources: string[];
    rank: number;
    rank_prev: number | null;
    rank_change: number | null;
    rank_1m_ago?: number | null;
    rank_5m_ago?: number | null;
    rank_velocity: number | null;
    intraday_score: number;
    heat_score: number;
    state: string;
    change_pct?: number | null;
    last_price?: number | null;
    open_score?: number | null;
    open_gate_status?: string | null;
    score_coverage_pct?: number | null;
    score_confidence?: string | null;
    metrics: {
        return_1m: number | null;
        return_3m: number | null;
        momentum_acceleration: number;
        volume_acceleration: number | null;
        rvol_same_time?: number | null;
        vwap_pos_pct: number | null;
        relative_strength_score: number;
        breakout_type: string;
        pullback_quality_score: number;
        pullback_state: string;
        liquidity_score?: number | null;
    };
    risk: {
        chase_risk: string;
        invalid_price: number | null;
    };
    events: string[];
    reasons: string[];
    risks: string[];
    data_health: string;
    data_blocked: boolean;
    updated_at: string;
}

export function fetchIntradayRank(opts?: {
    limit?: number;
    state?: string;
    includeWatch?: boolean;
}) {
    const q = new URLSearchParams();
    q.set('limit', String(opts?.limit ?? 20));
    if (opts?.state) q.set('state', opts.state);
    if (opts?.includeWatch) q.set('include_watch', 'true');
    return apiGet<{
        as_of: string;
        strong?: number;
        heating?: number;
        emerging?: number;
        items: IntradayRankItemDto[];
        warnings?: string[];
    }>(`/api/v1/data/intraday-rank?${q.toString()}`);
}

export function fetchIntradayEvents(limit = 50) {
    return apiGet<{
        items: Array<{
            event_type: string;
            symbol: string;
            rank: number | null;
            timestamp: string;
        }>;
    }>(`/api/v1/data/intraday-events?limit=${limit}`);
}

export function fetchIntradayDiscovery() {
    return apiGet<{ count: number; items: unknown[] }>(
        '/api/v1/data/intraday-discovery',
    );
}


// ---- streaming subscriptions ----

export function subscribeQuote(
    contract: ContractBase,
    quoteType: QuoteTypeName,
) {
    const body = {
        ...contractKey(contract),
        target_code: contract.target_code ?? null,
        quote_type: quoteType,
        intraday_odd: false,
    };
    registerSubscription(body);
    return apiPost<SubscriptionResponse>('/api/v1/stream/subscribe', body);
}

export function unsubscribeQuote(
    contract: ContractBase,
    quoteType: QuoteTypeName,
) {
    return apiPost<SubscriptionResponse>('/api/v1/stream/unsubscribe', {
        ...contractKey(contract),
        target_code: contract.target_code ?? null,
        quote_type: quoteType,
        intraday_odd: false,
    });
}

// ---- orders ----

export function placeStockOrder(contract: ContractBase, order: StockOrderReq) {
    return apiPost<Trade>('/api/v1/order/place_order', {
        contract: contractKey(contract),
        stock_order: order,
    });
}

export function placeFuturesOrder(
    contract: ContractBase,
    order: FuturesOrderReq,
) {
    return apiPost<Trade>('/api/v1/order/place_order', {
        contract: contractKey(contract),
        futures_order: order,
    });
}

export function cancelOrder(tradeId: string) {
    return apiPost<Trade>('/api/v1/order/cancel_order', { trade_id: tradeId });
}

export function updateOrderPrice(tradeId: string, price: number) {
    return apiPost<Trade>('/api/v1/order/update_price', {
        trade_id: tradeId,
        price,
    });
}

export function updateOrderQty(tradeId: string, quantity: number) {
    return apiPost<Trade>('/api/v1/order/update_qty', {
        trade_id: tradeId,
        quantity,
    });
}

export function fetchTrades(accountType: AccountTypeName) {
    return apiPost<Trade[]>('/api/v1/order/trades', {
        account_type: accountType,
    });
}

// ---- portfolio ----

export function fetchPositions(accountType: AccountTypeName) {
    return apiPost<(StockPosition | FuturePosition)[]>(
        '/api/v1/portfolio/position_unit',
        { account_type: accountType, unit: 'Common' },
    );
}

export function fetchAccountBalance() {
    return apiPost<AccountBalance>('/api/v1/portfolio/account_balance', {
        account_type: 'S',
    });
}

export function fetchMargin() {
    return apiPost<Margin>('/api/v1/portfolio/margin', {
        account_type: 'F',
    });
}

/** 三大法人＋融資券公開籌碼（通常 T+1） */
export interface PublicChipItem {
    code: string;
    name?: string;
    as_of?: string;
    foreign_net?: number;
    trust_net?: number;
    dealer_net?: number;
    inst_net?: number;
    margin_delta?: number;
    short_delta?: number;
    bias?: string;
    label?: string;
    score_adj?: number;
    strength_delta?: number;
    summary?: string;
}

export function fetchPublicChips(codes?: string[]) {
    const q =
        codes && codes.length
            ? `?codes=${encodeURIComponent(codes.slice(0, 80).join(','))}`
            : '';
    return apiGet<{
        as_of: string;
        count: number;
        items: Record<string, PublicChipItem>;
    }>(`/api/v1/data/chips${q}`);
}

export function fetchPublicChip(code: string) {
    return apiGet<{
        code: string;
        row: PublicChipItem | null;
        signal: {
            available: boolean;
            bias: string;
            label: string;
            summary: string;
            score_adj: number;
            strength_delta: number;
            as_of?: string;
            notes: string[];
        };
    }>(`/api/v1/data/chips/${encodeURIComponent(code)}`);
}

export interface OvernightEdgeItem {
    code: string;
    samples: number;
    win_rate: number;
    avg_gap_pct: number;
    expectancy_pct: number;
    max_drawdown_pct: number;
    last_signal: boolean;
    label: string;
    summary: string;
    note: string;
    score_adj: number;
    strength_boost: number;
}

export function fetchOvernightEdge(codes: string[]) {
    const q = `?codes=${encodeURIComponent(codes.slice(0, 40).join(','))}`;
    return apiGet<{ count: number; items: Record<string, OvernightEdgeItem> }>(
        `/api/v1/data/overnight-edge${q}`,
    );
}

// ---- server watchlists ----

export interface ServerWatchlist {
    id: string;
    name: string;
    contracts: { security_type: SecurityType; exchange: string; code: string }[];
}

export function fetchWatchlists() {
    return apiGet<ServerWatchlist[]>('/api/v1/watchlist');
}

export function createWatchlist(
    name: string,
    contracts: ContractBase[],
) {
    return apiPost<ServerWatchlist>('/api/v1/watchlist', {
        name,
        contracts: contracts.map(contractKey),
    });
}

export function syncWatchlist(id: string, contracts: ContractBase[]) {
    return apiPut<ServerWatchlist>(`/api/v1/watchlist/${id}`, {
        contracts: contracts.map(contractKey),
    });
}
