// server/src/lib/market-context/types.ts
// Market Context Phase 1 — read-only; NEVER mutates A/B/C / Heat / Rank / BP.

export const MC_VERSION = 'mc_v1';

export type RealtimeLevel =
    | 'REALTIME'
    | 'NEAR_REALTIME'
    | 'DELAYED'
    | 'EOD'
    | 'PREVIOUS_DAY'
    | 'UNKNOWN';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export type TaiwanRegimeState =
    | 'RISK_ON_BROAD'
    | 'RISK_ON_NARROW'
    | 'NEUTRAL'
    | 'RISK_OFF_NARROW'
    | 'RISK_OFF_BROAD'
    | 'UNKNOWN';

export type GlobalRegimeState =
    | 'RISK_ON'
    | 'NEUTRAL'
    | 'RISK_OFF'
    | 'UNKNOWN';

export type SectorRotationState =
    | 'ROTATING_IN'
    | 'HOT'
    | 'STABLE'
    | 'ROTATING_OUT'
    | 'COLD'
    | 'INSUFFICIENT_COVERAGE';

export type TurnoverAccelLabel =
    | 'ACCELERATING'
    | 'DECELERATING'
    | 'FLAT'
    | 'UNKNOWN';

export interface ContextDataPointMeta {
    source: string;
    source_type: string;
    observed_at: string | null;
    published_at: string | null;
    fetched_at: string;
    freshness: string;
    age_ms: number | null;
    available: boolean;
    coverage_pct: number | null;
    confidence: ConfidenceLevel;
    realtime_level: RealtimeLevel;
}

export interface BroadUniverseReport {
    broad_universe_size: number;
    expected_universe_size: number;
    coverage_pct: number;
    source: string;
    update_frequency: string;
    realtime_level: RealtimeLevel;
    meta: ContextDataPointMeta;
}

export interface MarketBreadth {
    advancers: number;
    decliners: number;
    unchanged: number;
    advance_decline_ratio: number | null;
    advance_pct: number | null;
    decline_pct: number | null;
    coverage_pct: number;
    confidence: ConfidenceLevel;
    universe_size: number;
    /** Must never equal BP active-80 size as claimed full market. */
    uses_active_watch_pool: false;
    meta: ContextDataPointMeta;
}

export interface TaiwanRegime {
    state: TaiwanRegimeState;
    taiex_change_pct: number | null;
    tpex_change_pct: number | null;
    taiex_direction: 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN';
    tpex_direction: 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN';
    market_breadth_advance_pct: number | null;
    advance_decline_ratio: number | null;
    turnover_acceleration: TurnoverAccelLabel;
    large_vs_small_rs: number | null;
    electronics_strength: number | null;
    financial_strength: number | null;
    sector_breadth_pct: number | null;
    score: number | null;
    reasons: string[];
    meta: ContextDataPointMeta;
}

export interface GlobalRegime {
    state: GlobalRegimeState;
    summary: string | null;
    meta: ContextDataPointMeta;
}

export interface SectorRotationRow {
    sector: string;
    sector_rank: number | null;
    sector_rank_prev: number | null;
    sector_rank_change: number | null;
    sector_rank_velocity: number | null;
    sector_turnover: number;
    turnover_share: number;
    turnover_share_prev: number | null;
    turnover_share_delta: number | null;
    sector_turnover_acceleration: number | null;
    sector_relative_strength: number | null;
    breadth: number | null;
    c_strong_count: number;
    bp_strong_count: number;
    member_count: number;
    covered_members: number;
    coverage_pct: number;
    top1_turnover_share: number | null;
    top3_turnover_share: number | null;
    high_concentration: boolean;
    capital_rotation_score: number | null;
    /** Alias for UI copy — same as capital_rotation_score. */
    attention_flow_score: number | null;
    state: SectorRotationState;
    tags: string[];
    leaders: Array<{ symbol: string; name: string; turnover: number; change_pct: number }>;
    meta: ContextDataPointMeta;
}

export interface InstitutionalEodBlock {
    label: 'INSTITUTIONAL_EOD';
    available: boolean;
    as_of: string | null;
    note: string;
    realtime_level: 'PREVIOUS_DAY';
    meta: ContextDataPointMeta;
}

export interface InstitutionalRiskProxy {
    label: 'INSTITUTIONAL_RISK_PROXY';
    available: false;
    proxy: true;
    not_actual_foreign_identity: true;
    note: string;
    meta: ContextDataPointMeta;
}

export interface MarketContextOverview {
    as_of: string;
    version: string;
    global_regime: GlobalRegime;
    taiwan_regime: TaiwanRegime;
    breadth: MarketBreadth;
    broad_universe: BroadUniverseReport;
    top_rotating: SectorRotationRow[];
    institutional_eod: InstitutionalEodBlock;
    institutional_risk_proxy: InstitutionalRiskProxy;
    /** Gap-completion layers — Decision Support only; never mutates strategy. */
    gap_layers?: import('./gap-layers/types.ts').GapLayersSnapshot | null;
    creates_upstream_subscription: false;
    mutates_strategy: false;
    warnings: string[];
}

export interface MarketContextHealth {
    enabled: boolean;
    status: 'HEALTHY' | 'PARTIAL' | 'STALE' | 'UNAVAILABLE' | 'ERROR';
    version: string;
    last_evaluate_at: string | null;
    broad_universe_size: number;
    coverage_pct: number;
    creates_upstream_subscription: false;
    mutates_strategy: false;
    note: string;
}
