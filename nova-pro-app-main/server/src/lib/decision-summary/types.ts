// server/src/lib/decision-summary/types.ts
// Decision Support Layer — NEVER mutates A/B/C / BP / Heat / Rank / thresholds.

export const DS_VERSION = 'ds_v1';

export type DecisionStatus =
    | 'NOT_READY'
    | 'WATCH'
    | 'CONFIRMED_STRENGTH'
    | 'EXTENDED';

export type DecisionContextAlignment =
    | 'ALIGNED'
    | 'MIXED'
    | 'CONTRARY'
    | 'INSUFFICIENT_DATA';

export type DecisionConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface DecisionLayers {
    stock: boolean;
    sector: boolean;
    market: boolean;
    event: boolean;
}

export interface DecisionSummary {
    symbol: string;
    name: string;
    status: DecisionStatus;
    context_alignment: DecisionContextAlignment;
    confidence: DecisionConfidence;
    headline: string;
    confirmed_reasons: string[];
    missing_confirmations: string[];
    risk_flags: string[];
    next_confirmations: string[];
    data_coverage_pct: number;
    updated_at: string;
    layers: DecisionLayers;
    /** Consecutive core-confirm evaluations (for streak gate). */
    confirm_streak: number;
    version: string;
}

/** Flat read-only inputs — never write back into C/BP. */
export interface DecisionSummaryInput {
    symbol: string;
    name?: string | null;
    c_score: number | null;
    c_state: string | null;
    rank: number | null;
    rank_prev: number | null;
    rank_change: number | null;
    rank_velocity: number | null;
    bp_score: number | null;
    bp_states: string[];
    last_price: number | null;
    vwap: number | null;
    vwap_pos_pct: number | null;
    rvol: number | null;
    volume_acceleration: number | null;
    trade_aggression: number | null;
    breakout_type: string | null;
    chase_risk: string | null;
    heat_score: number | null;
    data_health: string | null;
    data_blocked: boolean;
    data_stale: boolean;
    score_coverage_pct: number | null;
    bp_coverage_pct: number | null;
    has_ca_today: boolean;
    adjusted_change_pct: number | null;
    raw_change_pct: number | null;
    taiwan_regime: string | null;
    market_breadth_advance_pct: number | null;
    market_context_available: boolean;
    sector_state: string | null;
    sector_breadth: number | null;
    sector_rs: number | null;
    sector_coverage_pct: number | null;
    event_status: string | null;
    institutional_realtime_level: string | null;
    institutional_is_proxy: boolean;
}

export interface DecisionSummaryBatch {
    as_of: string;
    version: string;
    count: number;
    items: DecisionSummary[];
    evaluate_interval_sec: number;
    mutates_strategy: false;
    note: string;
}
