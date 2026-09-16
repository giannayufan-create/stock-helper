// server/src/lib/buy-pressure/types.ts
// Buy Pressure Context — NEVER mutates A/B/C / Heat / Rank / Events.

export const BP_VERSION = 'bp_v1';

export type BuyPressureState =
    | 'EARLY'
    | 'BUY_SURGE'
    | 'ASK_EATING'
    | 'VOLUME_BREAKOUT'
    | 'LARGE_BID'
    | 'OVERHEATED'
    | 'COOLING';

export type BuyPressureMarket = 'ALL' | 'TSE' | 'OTC' | 'ESM';

export type VwapBucket = 'Above VWAP' | 'Near VWAP' | 'Below VWAP';

export type BreakoutRefType =
    | 'OPENING_RANGE_HIGH'
    | 'LOCAL_HIGH'
    | 'PREVIOUS_BREAKOUT_LEVEL'
    | 'INTRADAY_HIGH';

export type UniverseSource =
    | 'C_TOP_RANK'
    | 'C_DISCOVERY'
    | 'A_POOL'
    | 'B_PASS'
    | 'B_WATCH'
    | 'SCANNER_VOLUME'
    | 'SCANNER_CHANGE'
    | 'SCANNER_AMOUNT'
    | 'SCANNER_TICK'
    | 'SCANNER_DAYRANGE'
    | 'UNKNOWN';

export type DiscoveryReason = UniverseSource;

export type BpInternalEvent =
    | 'EARLY_ENTER'
    | 'BUY_SURGE'
    | 'ASK_EATING'
    | 'ASK_CANCEL'
    | 'VOLUME_BREAKOUT'
    | 'LARGE_BID_APPEAR'
    | 'RANK_ACCELERATION'
    | 'OVERHEATED'
    | 'COOLING';

export interface FeatureSample {
    value: number | null;
    available: boolean;
}

export interface BidAskSnap {
    t: number;
    best_ask: number;
    ask_volume: number;
    best_bid: number;
    bid_volume: number;
    last_price: number;
    total_volume: number;
    ask_executed_delta: number;
    /** Full available levels from provider (may be length 1 = best-only). */
    bid_levels: number[];
    ask_levels: number[];
    bid_qty: number[];
    ask_qty: number[];
    orderbook_depth_available: number;
}

export interface BuyPressureFeatures {
    volume_acceleration: FeatureSample;
    trade_aggression: FeatureSample;
    rvol: FeatureSample;
    rank_velocity: FeatureSample;
    momentum_acceleration: FeatureSample;
    vwap_structure: FeatureSample;
    bidask_imbalance: FeatureSample;
    distance_from_vwap_pct: number | null;
    vwap_bucket: VwapBucket | null;
    change_pct: number | null;
    heat_score: number | null;
    c_score: number | null;
    chase_risk: string | null;
    last_price: number | null;
    rank: number | null;
    rank_prev: number | null;
    high: number | null;
    data_stale: boolean;
    data_health: string;
}

export interface BuyPressureScoreResult {
    buy_pressure_score: number;
    raw_score: number;
    coverage_pct: number;
    feature_availability: Record<string, boolean>;
    weights_used: Record<string, number>;
}

export interface BuyPressureEvent {
    event_id: string;
    event_type: BpInternalEvent;
    symbol: string;
    timestamp: string;
    price: number | null;
    note: string | null;
    notification_candidate: boolean;
    reasons: string[];
    /** True if emitted in the latest evaluate cycle. */
    cycle_fresh: boolean;
}

export type BuyPressureTag = 'LARGE_BID' | 'OVERHEATED';

export interface BuyPressureItem {
    symbol: string;
    name: string;
    market: BuyPressureMarket | 'UNKNOWN';
    last_price: number | null;
    change_pct: number | null;
    buy_pressure_score: number;
    radar_rank_score: number;
    primary_state: BuyPressureState;
    states: BuyPressureState[];
    /** Non-primary tags — OVERHEATED / LARGE_BID do not replace action state. */
    tags: BuyPressureTag[];
    c_score: number | null;
    heat_score: number | null;
    rank: number | null;
    rank_prev: number | null;
    rank_velocity: number | null;
    volume_acceleration: number | null;
    rvol: number | null;
    trade_aggression: number | null;
    bidask_imbalance: number | null;
    momentum_acceleration: number | null;
    vwap_bucket: VwapBucket | null;
    distance_from_vwap_pct: number | null;
    chase_penalty: number;
    chase_risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
    overheated: boolean;
    overheated_note: string | null;
    ask_eating_note: string | null;
    large_bid_note: string | null;
    data_stale: boolean;
    data_health: string;
    updated_at: string;
    last_updated: string;
    evaluated_at: string;
    last_tick_at: string | null;
    last_bidask_at: string | null;
    data_age_ms: number | null;
    freshness: 'FRESH' | 'AGING' | 'STALE';
    rvol_slope: number | null;
    volume_acceleration_slope: number | null;
    rvol_accel: 'ACCELERATING' | 'DECELERATING' | 'FLAT' | 'UNKNOWN';
    volume_accel_label: 'ACCELERATING' | 'DECELERATING' | 'FLAT' | 'UNKNOWN';
    events: BuyPressureEvent[];
    notification_candidates: BuyPressureEvent[];
    feature_availability: Record<string, boolean>;
    score_coverage_pct: number;
    score_confidence: 'high' | 'medium' | 'low';
    universe_source: UniverseSource;
    discovery_reason: DiscoveryReason | null;
    orderbook_depth_available: number;
    ask_eating_confidence: 'high' | 'medium' | 'low' | 'none';
    breakout_type: BreakoutRefType | null;
    reference_level: number | null;
    reference_time: string | null;
    slope_window_ms: number;
    slope_sample_count: number;
}

export interface BuyPressureBatch {
    as_of: string;
    version: string;
    count: number;
    items: BuyPressureItem[];
    evaluate_interval_sec: number;
    default_price_filter: 'ALL';
    warnings: string[];
    data_stale_global: boolean;
}

export interface BuyPressureQuery {
    min_price?: number;
    max_price?: number;
    min_score?: number;
    state?: BuyPressureState | 'ALL' | 'OVERHEATED_STRONG';
    market?: BuyPressureMarket;
    /** User-opt-in only; default undefined = include overheated. */
    overheated?: boolean;
    sort?:
        | 'strongest'
        | 'early'
        | 'rank_surge'
        | 'volume_surge'
        | 'ask_eating'
        | 'overheated_strong';
    limit?: number;
}

export interface BuyPressureHealth {
    enabled: boolean;
    status: 'HEALTHY' | 'STALE' | 'PARTIAL' | 'UNAVAILABLE' | 'ERROR';
    version: string;
    last_evaluate_at: string | null;
    item_count: number;
    note: string;
    creates_upstream_subscription: false;
    mutates_strategy: false;
}
