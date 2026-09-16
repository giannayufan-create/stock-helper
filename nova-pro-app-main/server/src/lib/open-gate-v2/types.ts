// server/src/lib/open-gate-v2/types.ts — A→B contracts + Final Patch fields

export type OpenPhase = 'provisional' | 'early' | 'confirmed' | 'after';

export type OpenConfirmStatus =
    | 'provisional'
    | 'early_pass'
    | 'pass'
    | 'watch'
    | 'reject';

export type ChaseRisk = 'low' | 'medium' | 'high' | 'extreme';

export type DataHealth =
    | 'healthy'
    | 'degraded'
    | 'stale'
    | 'disconnected';

export type MarketRegimeLabel =
    | 'strong_bull'
    | 'bull'
    | 'neutral'
    | 'bear'
    | 'strong_bear';

export type SignalStatus = 'active' | 'expired';

export type VwapSource =
    | 'tick'
    | 'snapshot'
    | 'calculated'
    | 'approx_1m'
    | 'fallback';

export type VwapConfidence = 'high' | 'degraded' | 'none';

export type SignalMaturity = 'new' | 'forming' | 'stable' | 'weakening';

export type AScoreSource = 'legacy_frontend' | 'server';

/** A candidate input (adapter fills gaps; A API untouched). */
export interface ACandidate {
    symbol: string;
    name: string;
    exchange: 'tse' | 'otc' | 'unknown';
    a_score: number;
    a_score_source: AScoreSource;
    prev_close: number | null;
    avg_volume_20d: number | null;
    avg_amount_20d: number | null;
    sector: string | null;
    warning_status: boolean;
    disposition_status: boolean;
    source?: 'eod_a' | 'scanner_candidate';
    lite?: boolean;
}

export interface SymbolMarketState {
    symbol: string;
    timestamp: number;
    last_price: number;
    open: number;
    high: number;
    low: number;
    prev_close: number;
    total_volume: number;
    total_amount: number;
    turnover: number;
    avg_price: number;
    best_bid: number;
    best_ask: number;
    bid_volume: number;
    ask_volume: number;
    /** Full book levels when provider sends them; length 1 = best-only. */
    bid_levels?: number[];
    ask_levels?: number[];
    bid_qty_levels?: number[];
    ask_qty_levels?: number[];
    /** Count of usable ask/bid price levels from last BidAsk event. */
    orderbook_depth?: number;
    tick_count: number;
    last_tick_at: number | null;
    last_bidask_at: number | null;
    /** stream-local accumulator — fallback / consistency only */
    vwap_num: number;
    vwap_den: number;
    vwap_source: VwapSource;
    vwap_valid: boolean;
    /** Prefer over vwap_valid for replay: true whenever a VWAP number exists. */
    vwap_available?: boolean;
    vwap_confidence?: VwapConfidence;
    recent_prices: Array<{ t: number; p: number; v: number }>;
}

export interface ScoreComponents {
    rvol_score: number;
    vwap_score: number;
    open_hold_score: number;
    pullback_score: number;
    momentum_score: number;
    gap_score: number;
}

export interface OpenConfirmMetrics {
    gap_pct: number;
    rvol_same_time: number | null;
    vwap: number | null;
    vwap_pos_pct: number | null;
    vwap_source: VwapSource | null;
    vwap_valid: boolean;
    vwap_available?: boolean;
    vwap_confidence?: VwapConfidence | string;
    open_pos_pct: number | null;
    high_pullback_pct: number | null;
    momentum_score: number;
    spread_pct: number | null;
}

export interface OpenConfirmRisk {
    chase_risk: ChaseRisk;
    invalid_price: number | null;
    invalid_reason: string | null;
    risk_pct: number | null;
    risk_distance_pct: number | null;
    risk_score: number;
    risk_adjustment: number;
}

export interface OpenConfirmResult {
    symbol: string;
    name?: string;
    timestamp: string;
    a_score: number;
    a_score_source: AScoreSource;
    phase: OpenPhase;
    /** @deprecated prefer tradeable_candidate */
    tradeable: boolean;
    tradeable_candidate: boolean;
    raw_open_score: number;
    market_adjustment: number;
    liquidity_adjustment: number;
    risk_adjustment: number;
    final_open_score: number;
    open_confirm: OpenConfirmStatus;
    hard_reject: boolean;
    soft_reject: boolean;
    data_blocked: boolean;
    market_regime: MarketRegimeLabel;
    market_score: number;
    score_components: ScoreComponents;
    metrics: OpenConfirmMetrics;
    risk: OpenConfirmRisk;
    liquidity_score: number;
    reasons: string[];
    risks: string[];
    data_health: DataHealth;
    signal_status: SignalStatus;
    evaluation_stale: boolean;
    signal_expired: boolean;
    confirmation_count: number;
    pass_streak: number;
    watch_streak: number;
    reject_streak: number;
    status_since: string;
    first_pass_at: string | null;
    last_pass_at: string | null;
    signal_maturity: SignalMaturity;
    open_gate_passed_before_cutoff: boolean;
    open_gate_baseline: number | null;
    /** Frozen open-gate score after cutoff (from baseline / prior freeze). */
    open_gate_final_score: number | null;
    /** Live metrics after cutoff while final score is frozen. */
    current_open_metrics?: OpenConfirmMetrics & {
        live_final_open_score?: number;
    };
    late_candidate: boolean;
    feature_availability: Record<string, boolean>;
    score_coverage_pct: number;
    score_confidence: 'high' | 'medium' | 'low';
    evaluation_id: string;
    signal_id: string | null;
    generated_at: string;
    fresh_until: string;
    signal_valid_until: string;
    /** @deprecated use signal_valid_until */
    expires_at: string;
    ttl_seconds: number;
    previous_confirm?: OpenConfirmStatus | null;
}

export interface OpenConfirmLogRow {
    date: string;
    timestamp: string;
    evaluation_id: string;
    signal_id: string | null;
    symbol: string;
    a_score: number;
    a_score_source: AScoreSource;
    phase: OpenPhase;
    raw_open_score: number;
    final_open_score: number;
    rvol_same_time: number | null;
    vwap: number | null;
    vwap_pos_pct: number | null;
    vwap_source: VwapSource | null;
    vwap_valid: boolean;
    open_pos_pct: number | null;
    high_pullback_pct: number | null;
    momentum_score: number;
    market_score: number;
    market_adjustment: number;
    liquidity_score: number;
    liquidity_adjustment: number;
    risk_score: number;
    risk_adjustment: number;
    invalid_price: number | null;
    invalid_reason: string | null;
    risk_distance_pct: number | null;
    chase_risk: ChaseRisk;
    open_confirm: OpenConfirmStatus;
    hard_reject: boolean;
    soft_reject: boolean;
    data_blocked: boolean;
    data_health: DataHealth;
    tradeable_candidate: boolean;
    open_gate_passed_before_cutoff: boolean;
    late_candidate: boolean;
    reasons_json: string;
    risks_json: string;
    price_at_signal: number | null;
    log_reason: string;
    return_5m?: number | null;
    return_15m?: number | null;
    return_30m?: number | null;
    return_60m?: number | null;
    close_return?: number | null;
    mfe?: number | null;
    mae?: number | null;
}
