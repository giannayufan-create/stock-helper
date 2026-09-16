// server/src/lib/ai-interpretation/types.ts
// AI Interpretation System v1 — Decision Support / Explanation only.
// NEVER mutates A/B/C / BP / Heat / Rank / Decision Summary / Strategy.

export const AI_INTERPRETATION_VERSION = 'AI_INTERPRETATION_V1';

export type InterpretationConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type InterpretationScoreBand =
    | '1.0-2.9'
    | '3.0-4.9'
    | '5.0-6.4'
    | '6.5-7.9'
    | '8.0-8.9'
    | '9.0-10.0';

/** Reuse Decision Summary statuses — do not invent a parallel strategy status. */
export type InterpretationStatus =
    | 'NOT_READY'
    | 'WATCH'
    | 'CONFIRMED_STRENGTH'
    | 'EXTENDED';

export interface StockInterpretationInput {
    symbol: string;
    name?: string | null;
    price?: number | null;
    change_pct?: number | null;
    /** Prefer adjusted when CA today. */
    adjusted_change_pct?: number | null;
    raw_change_pct?: number | null;
    has_ca_today?: boolean;

    c_score: number | null;
    c_state: string | null;

    bp_score: number | null;
    bp_states: string[];

    rank: number | null;
    rank_prev: number | null;
    rank_change: number | null;
    rank_velocity: number | null;

    vwap: number | null;
    vwap_pos_pct: number | null;

    rvol: number | null;
    volume_acceleration: number | null;
    trade_aggression: number | null;

    heat_score: number | null;
    chase_risk: string | null;

    decision_status: InterpretationStatus | null;
    context_alignment: string | null;

    sector: string | null;
    sector_state: string | null;
    sector_rank: number | null;
    sector_rank_velocity: number | null;
    sector_breadth: number | null;
    sector_rs: number | null;
    leader_concentration: boolean | null;
    sector_coverage_pct: number | null;

    taiwan_regime: string | null;
    market_breadth: number | null;

    overnight_bias: string | null;
    preopen_confirmation: string | null;

    event_state: string | null;
    event_confirmation: string | null;

    institutional_realtime_level: string | null;
    institutional_is_proxy: boolean;

    data_health: string | null;
    data_stale: boolean;
    data_blocked: boolean;
    feature_coverage_pct: number | null;
    context_coverage_pct: number | null;
    freshness: string | null;
    cash_session_closed?: boolean;
    last_updated_at?: string | null;
}

export interface ComponentScores {
    core_strength: number;
    buy_volume: number;
    sector_context: number;
    market_context: number;
    structure_rank: number;
    data_confidence: number;
}

export interface StockAIInterpretation {
    symbol: string;
    name: string;
    score: number;
    score_band: InterpretationScoreBand;
    status: InterpretationStatus;
    confidence: InterpretationConfidence;
    headline: string;
    positive_factors: string[];
    limiting_factors: string[];
    missing_confirmations: string[];
    risk_flags: string[];
    data_quality_summary: string;
    components: ComponentScores;
    interpretation_score_version: string;
    config_hash: string;
    snapshot_id: string;
    snapshot_at: string;
    generated_at: string;
    cash_session_closed: boolean;
    last_updated_at: string | null;
    mutates_strategy: false;
    research_persistence: 'NOT_ENABLED';
}

export interface StockAIInterpretationNarrative {
    snapshot_id: string;
    narrative: string | null;
    sections: {
        structure: string;
        why_score: string;
        confirmed: string;
        missing: string;
        sector: string;
        market: string;
        overnight_preopen: string;
        events: string;
        risks: string;
        data_quality: string;
    } | null;
    llm_available: boolean;
    llm_error: string | null;
    generated_at: string;
}

export interface RadarFilterSnapshot {
    tab?: string | null;
    min_c?: number | null;
    min_heat?: number | null;
    min_bp?: number | null;
    market?: string | null;
    sector?: string | null;
    decision_status?: string | null;
    bp_state?: string | null;
    c_state?: string | null;
    event_filter?: string | null;
    corporate_action_filter?: string | null;
    price_max?: number | null;
    price_min?: number | null;
    extra?: Record<string, unknown>;
}

export interface RadarStockRowInput {
    symbol: string;
    name?: string | null;
    c_score: number | null;
    c_state: string | null;
    bp_score: number | null;
    bp_states: string[];
    rank: number | null;
    rank_change: number | null;
    rank_velocity: number | null;
    vwap_pos_pct: number | null;
    rvol: number | null;
    volume_acceleration: number | null;
    trade_aggression: number | null;
    decision_status: InterpretationStatus | null;
    context_alignment: string | null;
    confidence: InterpretationConfidence | null;
    sector: string | null;
    sector_state: string | null;
    sector_rank: number | null;
    sector_breadth: number | null;
    taiwan_regime: string | null;
    overnight_bias?: string | null;
    preopen_confirmation?: string | null;
    event_state?: string | null;
    chase_risk: string | null;
    has_ca_today?: boolean;
    data_health: string | null;
    data_stale: boolean;
    feature_coverage_pct?: number | null;
}

export interface RadarAggregate {
    matched_count: number;
    status_distribution: Record<InterpretationStatus, number>;
    confirmed_strength_ratio: number;
    watch_ratio: number;
    extended_ratio: number;
    not_ready_ratio: number;
    bp_confirmed_count: number;
    bp_confirmed_ratio: number;
    above_vwap_count: number;
    above_vwap_ratio: number;
    rvol_available_count: number;
    rvol_coverage: number;
    sector_distribution: Record<string, number>;
    sector_state_distribution: Record<string, number>;
    sector_alignment_ratio: number;
    context_alignment_distribution: Record<string, number>;
    confidence_distribution: Record<string, number>;
    chase_risk_distribution: Record<string, number>;
    event_confirmed_count: number;
    data_stale_count: number;
    market_regime: string | null;
    common_strengths: string[];
    common_missing_confirmations: string[];
    common_risks: string[];
    divergences: string[];
    notable_sector_concentration: Array<{
        sector: string;
        count: number;
        ratio: number;
        sector_state: string | null;
    }>;
}

export interface RadarAIInterpretation {
    snapshot_id: string;
    score: number;
    score_band: InterpretationScoreBand;
    confidence: InterpretationConfidence;
    matched_count: number;
    filter_summary: string;
    headline: string;
    market_summary: string;
    sector_summary: string;
    group_structure: string;
    common_strengths: string[];
    missing_confirmations: string[];
    divergence_flags: string[];
    risk_flags: string[];
    notable_groups: string[];
    data_quality_summary: string;
    aggregate: RadarAggregate;
    interpretation_score_version: string;
    config_hash: string;
    snapshot_at: string;
    generated_at: string;
    mutates_strategy: false;
    research_persistence: 'NOT_ENABLED';
}

export interface RadarAIInterpretationNarrative {
    snapshot_id: string;
    narrative: string | null;
    llm_available: boolean;
    llm_error: string | null;
    generated_at: string;
}
