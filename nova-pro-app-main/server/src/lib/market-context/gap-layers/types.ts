// server/src/lib/market-context/gap-layers/types.ts
// Extended Market Context layers — NEVER mutates A/B/C / BP / Heat / Rank.

import type { ContextDataPointMeta, RealtimeLevel } from '../types.ts';

export const GAP_LAYERS_VERSION = 'gap_layers_v1';

export type LayerCompleteness = 'FULL' | 'PARTIAL' | 'UNAVAILABLE';

export interface LayerEnvelope<T> {
    layer: string;
    completeness: LayerCompleteness;
    available: boolean;
    proxy: boolean;
    note: string | null;
    meta: ContextDataPointMeta;
    data: T;
}

/** 1 PreOpen / Close Auction */
export type PreOpenState =
    | 'PREOPEN_POSITIVE'
    | 'PREOPEN_NEGATIVE'
    | 'PREOPEN_NEUTRAL'
    | 'PREOPEN_UNSTABLE'
    | 'CLOSE_AUCTION'
    | 'OUT_OF_WINDOW'
    | 'UNAVAILABLE';

export interface PreOpenAuctionData {
    window: 'PREOPEN' | 'CLOSE_AUCTION' | 'NONE';
    state: PreOpenState;
    simulated_match_price: number | null;
    simulated_match_volume: number | null;
    best_bid_levels: number[];
    best_ask_levels: number[];
    preopen_gap_pct: number | null;
    preopen_volume: number | null;
    price_revision_5m: number | null;
    price_revision_1m: number | null;
    bid_ask_imbalance: number | null;
    sample_count: number;
}

/** 2 Futures Lead */
export type FuturesLeadState =
    | 'FUTURES_LEADING_STRONG'
    | 'FUTURES_LEADING_WEAK'
    | 'CONFIRMED'
    | 'DIVERGENCE'
    | 'UNAVAILABLE';

export interface FuturesLeadData {
    state: FuturesLeadState;
    basis: number | null;
    basis_pct: number | null;
    basis_change: number | null;
    futures_momentum: number | null;
    spot_momentum: number | null;
    lead_lag_30s: number | null;
    lead_lag_60s: number | null;
    lead_lag_120s: number | null;
    symbols: {
        tx: boolean;
        te: boolean;
        sof: boolean;
        taiex: boolean;
    };
}

/** 3 Index Concentration */
export type IndexConcentrationState =
    | 'BROAD_RALLY'
    | 'LARGE_CAP_LED'
    | 'SMALL_CAP_LED'
    | 'NARROW_MARKET'
    | 'BROAD_WEAKNESS'
    | 'UNAVAILABLE';

export interface IndexConcentrationData {
    state: IndexConcentrationState;
    top1_contribution: number | null;
    top5_contribution: number | null;
    large_cap_strength: number | null;
    small_mid_strength: number | null;
    breadth: number | null;
    weight_source: 'PROXY_TURNOVER' | 'OFFICIAL_WEIGHT' | 'NONE';
}

/** 4 Asia Regime */
export type AsiaRegimeState =
    | 'ASIA_RISK_ON'
    | 'ASIA_NEUTRAL'
    | 'ASIA_RISK_OFF'
    | 'UNAVAILABLE';

export type AsiaVsTaiwan = 'ASIA_CONFIRMED' | 'ASIA_DIVERGENCE' | 'UNKNOWN';

export interface AsiaIndexRow {
    id: string;
    name: string;
    change_pct: number | null;
    intraday_trend: 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN';
    freshness: string;
    realtime_level: RealtimeLevel;
    available: boolean;
}

export interface AsiaRegimeData {
    state: AsiaRegimeState;
    vs_taiwan: AsiaVsTaiwan;
    taiwan_regime: string | null;
    indices: AsiaIndexRow[];
}

/** 5 Macro Event Calendar */
export type MacroPhase =
    | 'T_MINUS_24H'
    | 'T_MINUS_3H'
    | 'T_MINUS_30M'
    | 'EVENT_WINDOW'
    | 'POST_EVENT'
    | 'FAR'
    | 'UNKNOWN';

export interface MacroEventRow {
    event_id: string;
    scheduled_at: string;
    country: string;
    event_type: string;
    importance: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    source: string;
    freshness: string;
    phase: MacroPhase;
}

export interface MacroEventCalendarData {
    upcoming: MacroEventRow[];
    active_phase: MacroPhase | null;
    nearest: MacroEventRow | null;
}

/** 6 Passive Flow */
export type PassiveEventType =
    | 'INDEX_REVIEW'
    | 'INDEX_ADD'
    | 'INDEX_DELETE'
    | 'REBALANCE_EFFECTIVE'
    | 'ETF_INDEX_CHANGE';

export interface PassiveFlowEvent {
    event_id: string;
    event_type: PassiveEventType;
    index_name: string;
    effective_at: string;
    symbols: string[];
    source: string;
}

export interface PassiveFlowData {
    events: PassiveFlowEvent[];
    affected_symbols: string[];
    passive_flow_event: boolean;
    note: string;
}

/** 7 Crowding */
export type CrowdingState =
    | 'LEVERAGE_BUILDING'
    | 'SHORT_CROWDING'
    | 'DAYTRADE_HEAVY'
    | 'NORMAL'
    | 'UNAVAILABLE';

export interface CrowdingData {
    state: CrowdingState;
    margin_balance: number | null;
    margin_delta: number | null;
    short_balance: number | null;
    short_delta: number | null;
    securities_lending_sell_balance: number | null;
    day_trade_ratio: number | null;
    sample_symbols: number;
    realtime_level: 'EOD' | 'PREVIOUS_DAY';
}

/** 8 Derivatives Positioning */
export type DerivativesState =
    | 'DERIVATIVES_RISK_ON'
    | 'DERIVATIVES_NEUTRAL'
    | 'DERIVATIVES_RISK_OFF'
    | 'UNAVAILABLE';

export interface DerivativesPositioningData {
    state: DerivativesState;
    put_call_ratio: number | null;
    futures_oi: number | null;
    options_oi: number | null;
    foreign_futures_position: number | null;
    institutional_positioning: number | null;
    as_of: string | null;
}

/** 9 Overseas Company */
export interface OverseasLink {
    taiwan_symbol: string;
    overseas_symbol: string;
    relation: 'ADR' | 'RELATED' | 'HOLDING';
    exposure_confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    overnight_change: number | null;
    relative_move: number | null;
    freshness: string;
    source: string;
}

export interface OverseasCompanyData {
    links: OverseasLink[];
    mapped_count: number;
}

/** 10 Industry Drivers */
export interface IndustryDriver {
    sector: string;
    driver: string;
    source: string;
    frequency: string;
    direction_semantics: string;
    freshness: string;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
    available: boolean;
    value: number | null;
    change_pct: number | null;
    realtime_level: RealtimeLevel;
}

export interface IndustryDriverRegistryData {
    drivers: IndustryDriver[];
}

export interface GapLayersSnapshot {
    as_of: string;
    version: string;
    mutates_strategy: false;
    creates_upstream_subscription: false;
    preopen_auction: LayerEnvelope<PreOpenAuctionData>;
    futures_lead: LayerEnvelope<FuturesLeadData>;
    index_concentration: LayerEnvelope<IndexConcentrationData>;
    asia_regime: LayerEnvelope<AsiaRegimeData>;
    macro_event_calendar: LayerEnvelope<MacroEventCalendarData>;
    passive_flow_calendar: LayerEnvelope<PassiveFlowData>;
    crowding: LayerEnvelope<CrowdingData>;
    derivatives_positioning: LayerEnvelope<DerivativesPositioningData>;
    overseas_company: LayerEnvelope<OverseasCompanyData>;
    industry_drivers: LayerEnvelope<IndustryDriverRegistryData>;
}
