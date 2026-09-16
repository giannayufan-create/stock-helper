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
    /** Approximate executed volume at best_ask since previous snap. */
    ask_executed_delta: number;
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
}

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
    overheated: boolean;
    ask_eating_note: string | null;
    large_bid_note: string | null;
    data_stale: boolean;
    data_health: string;
    updated_at: string;
    last_updated: string;
    events: BuyPressureEvent[];
    notification_candidates: BuyPressureEvent[];
    feature_availability: Record<string, boolean>;
    score_coverage_pct: number;
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
    state?: BuyPressureState | 'ALL';
    market?: BuyPressureMarket;
    overheated?: boolean;
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
