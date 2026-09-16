// server/src/lib/context-research/types.ts
// Context Snapshot + Attribution — RESEARCH / SHADOW ONLY.
// NEVER mutates A/B/C / Heat / Rank / Buy Pressure / production thresholds.

export const CR_VERSION = 'cr_v1';
export const CONTEXT_SNAPSHOT_VERSION = 'context_snapshot_v1';
export const EXPOSURE_MAP_VERSION = 'exposure_map_v1';
export const CONFIRMATION_VERSION = 'confirmation_v1';
export const SECTOR_ROTATION_VERSION = 'sector_rotation_v1';

export type ContextAlignment =
    | 'ALIGNED'
    | 'MIXED'
    | 'CONTRARY'
    | 'INSUFFICIENT_DATA';

export type ContextTag =
    | 'MARKET_RISK_ON'
    | 'MARKET_RISK_OFF'
    | 'SECTOR_ROTATING_IN'
    | 'SECTOR_HOT'
    | 'SECTOR_ROTATING_OUT'
    | 'SECTOR_BROAD_STRENGTH'
    | 'SECTOR_HIGH_CONCENTRATION'
    | 'CAPITAL_ATTENTION_RISING'
    | 'EVENT_RELEVANT'
    | 'EVENT_CONFIRMED'
    | 'EVENT_UNCONFIRMED'
    | 'COMPANY_EXPOSURE_HIGH'
    | 'COMPANY_EXPOSURE_LOW'
    | 'INSTITUTIONAL_EOD_POSITIVE'
    | 'INSTITUTIONAL_EOD_NEGATIVE'
    | 'INSTITUTIONAL_PROXY_STRONG'
    | 'INSTITUTIONAL_PROXY_WEAK';

export type SampleGuardLabel =
    | 'INSUFFICIENT_DATA'
    | 'EXPLORATORY'
    | 'ANALYSIS_ELIGIBLE';

export type ShadowCohortId =
    | 'BASELINE'
    | 'SHADOW_CONTEXT_MARKET'
    | 'SHADOW_CONTEXT_SECTOR'
    | 'SHADOW_CONTEXT_EVENT'
    | 'SHADOW_CONTEXT_FULL';

export interface ActiveEventSnap {
    event_id: string;
    event_type: string;
    title: string;
    confirmation_state: string | null;
    event_relevance: number | null;
    market_confirmation_score: number | null;
    published_at: string | null;
    available: boolean;
}

export interface ContextSnapshot {
    global_regime: string | null;
    taiwan_regime: string | null;
    market_breadth: number | null;
    market_turnover_acceleration: string | null;

    sector: string | null;
    sector_rank: number | null;
    sector_rank_change: number | null;
    sector_rank_velocity: number | null;
    sector_rotation_state: string | null;
    sector_turnover_share: number | null;
    sector_turnover_share_delta: number | null;
    sector_breadth: number | null;
    sector_relative_strength: number | null;
    capital_rotation_score: number | null;
    sector_c_strong_count: number | null;
    sector_bp_strong_count: number | null;
    leader_concentration: boolean | null;

    institutional_eod_context: {
        available: boolean;
        realtime_level: 'PREVIOUS_DAY';
        note: string;
    };
    institutional_risk_proxy: {
        available: false;
        proxy: true;
        not_actual_foreign_identity: true;
        note: string;
    };

    active_events: ActiveEventSnap[];
    event_relevance_score: number | null;
    event_market_confirmation_score: number | null;
    event_confirmation_state: string | null;
    company_exposure_confidence: string | null;

    /** Feature availability map — missing ≠ 0. */
    feature_availability: Record<string, boolean>;

    context_coverage_pct: number;
    context_confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    context_source_mode: 'LIVE' | 'REPLAY';
    captured_at: string;

    market_context_version: string;
    sector_rotation_version: string;
    event_engine_version: string;
    exposure_map_version: string;
    confirmation_version: string;
    config_hash: string;
    schema_version: string;
}

export interface ContextBundle {
    context_snapshot: ContextSnapshot;
    context_tags: ContextTag[];
    context_alignment: ContextAlignment;
    context_strength_score: number | null;
}

export interface CohortStatRow {
    cohort_id: string;
    label: string;
    n: number;
    sample_guard: SampleGuardLabel;
    positive_5m_rate: number | null;
    positive_15m_rate: number | null;
    median_forward_return_15m: number | null;
    median_mfe_15m: number | null;
    median_mae_15m: number | null;
    invalid_hit_rate: number | null;
    coverage_note: string | null;
}

export interface DailyContextResearchSummary {
    date: string;
    signals: number;
    context_coverage_pct: number | null;
    market_aligned: number;
    sector_rotating_in: number;
    event_confirmed: number;
    contrary: number;
    insufficient_context: number;
    completed_outcome_stats: CohortStatRow[];
    note: string;
    mutates_strategy: false;
}
