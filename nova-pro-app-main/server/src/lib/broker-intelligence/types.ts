// server/src/lib/broker-intelligence/types.ts

export const BI_VERSION = 'bi_v1';

export type BranchFreshness =
    | 'INTRADAY'
    | 'EOD'
    | 'T_PLUS_1'
    | 'DELAYED'
    | 'UNKNOWN';

export type BiHealthStatus =
    | 'HEALTHY'
    | 'STALE'
    | 'PARTIAL'
    | 'UNAVAILABLE'
    | 'ERROR';

export type BiConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type BrokerMarketAlignment =
    | 'BULLISH_ALIGNMENT'
    | 'NEUTRAL'
    | 'DIVERGENCE'
    | 'UNKNOWN';

export interface BranchTradeRow {
    symbol: string;
    trade_date: string;
    broker_id: string;
    broker_name: string;
    branch_id: string;
    branch_name: string;
    buy_volume: number;
    sell_volume: number;
    net_volume: number;
    buy_amount: number | null;
    sell_amount: number | null;
    net_amount: number | null;
    amount_available: boolean;
    source: string;
    updated_at: string;
    freshness: BranchFreshness;
}

export interface BrokerProviderCapability {
    provider_id: string;
    branch_trading: boolean;
    branch_history: boolean;
    intraday: boolean;
    amount_fields: boolean;
    notes: string;
}

export interface BranchDayBundle {
    symbol: string;
    trade_date: string;
    freshness: BranchFreshness;
    source: string;
    rows: BranchTradeRow[];
    available: boolean;
    error: string | null;
}

export interface BranchHistoryRow {
    broker_id: string;
    broker_name: string;
    branch_id: string;
    branch_name: string;
    buy_volume: number;
    sell_volume: number;
    net_volume: number;
    days_buying: number;
    days_selling: number;
    consecutive_buy_days: number;
    consecutive_sell_days: number;
    active_days: number;
    first_seen: string | null;
    last_seen: string | null;
}

export interface BranchHistoryReport {
    symbol: string;
    requested_days: number;
    available_days: number;
    sample_days: string[];
    data_coverage: number;
    insufficient: boolean;
    rows: BranchHistoryRow[];
    freshness: BranchFreshness;
    source: string;
}

export interface ConcentrationReport {
    symbol: string;
    trade_date: string | null;
    total_positive_net_buy: number;
    top1_positive_net_buy: number;
    top3_positive_net_buy: number;
    top5_positive_net_buy: number;
    concentration_top1: number | null;
    concentration_top3: number | null;
    concentration_top5: number | null;
    branch_count: number;
    positive_branch_count: number;
    negative_branch_count: number;
    eligible_for_ranking: boolean;
}

export interface MainForceEstimate {
    score: number | null;
    label: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
    method: 'branch_concentration_estimate';
    inferred: true;
    confidence: BiConfidence;
    reasons: string[];
}

export interface InstitutionalContext {
    available: boolean;
    freshness: 'T_PLUS_1' | 'EOD' | 'UNKNOWN';
    as_of: string | null;
    foreign_net: number | null;
    trust_net: number | null;
    dealer_net: number | null;
    inst_net: number | null;
    label: string | null;
    summary: string | null;
    note: string;
}

export interface BrokerSymbolSummary {
    symbol: string;
    name: string | null;
    trade_date: string | null;
    freshness: BranchFreshness;
    branch_available: boolean;
    institutional: InstitutionalContext;
    top_buy_branches: BranchTradeRow[];
    top_sell_branches: BranchTradeRow[];
    concentration: ConcentrationReport | null;
    history_5d: BranchHistoryReport | null;
    main_force: MainForceEstimate;
    alignment: BrokerMarketAlignment;
    alignment_note: string;
    radar_context: {
        c_score: number | null;
        stock_heat: number | null;
        state: string | null;
        events: string[];
    } | null;
    data_health: BrokerIntelligenceHealth;
    version: string;
    unavailable_reason: string | null;
}

export interface BrokerIntelligenceHealth {
    provider: string;
    freshness: BranchFreshness;
    last_success_at: string | null;
    latest_trade_date: string | null;
    coverage_days: number | null;
    status: BiHealthStatus;
    error: string | null;
    capability: BrokerProviderCapability;
    quota?: {
        limit: number;
        used: number;
        remaining: number;
        window_hours: number;
    } | null;
}

export interface RankingRow {
    symbol: string;
    name: string | null;
    main_force_score: number | null;
    confidence: BiConfidence;
    concentration_top3: number | null;
    net_buy_5d: number | null;
    consecutive_buy_days: number | null;
    c_score: number | null;
    stock_heat: number | null;
    state: string | null;
    events: string[];
    alignment: BrokerMarketAlignment;
    eligible_for_ranking: boolean;
    freshness: BranchFreshness;
}
