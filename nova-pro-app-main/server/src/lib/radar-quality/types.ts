// server/src/lib/radar-quality/types.ts
// Radar Quality Upgrade v1 — Decision Support only.
// NEVER mutates A/B/C / BP / Heat / Raw Rank / strategy thresholds.

export const RQ_VERSION = 'rq_v1';

export type RadarEligibility = 'ELIGIBLE' | 'WATCH_ONLY' | 'BLOCKED';

export type RadarMomentumState =
    | 'ACTIVE'
    | 'PULLBACK'
    | 'WATCH'
    | 'INACTIVE'
    | 'INVALID';

export type ForeignBackground =
    | 'FOREIGN_STRONG_ACCUMULATION'
    | 'FOREIGN_ACCUMULATION'
    | 'FOREIGN_NEUTRAL'
    | 'FOREIGN_DISTRIBUTION'
    | 'TRUST_ACCUMULATION'
    | 'INSUFFICIENT_DATA';

export type InstitutionalContinuation =
    | 'WAITING_CONFIRMATION'
    | 'CONFIRMED_CONTINUATION'
    | 'PARTIAL_CONTINUATION'
    | 'DIVERGENCE'
    | 'REJECTED'
    | 'INSUFFICIENT_DATA';

export interface InstitutionalSnapshot {
    foreign_net_buy_shares: number | null;
    foreign_buy_shares: number | null;
    foreign_sell_shares: number | null;
    investment_trust_net_buy: number | null;
    dealer_net_buy: number | null;
    foreign_net_buy_1d: number | null;
    foreign_net_buy_3d: number | null;
    foreign_net_buy_5d: number | null;
    /** 三大法人合計 multi-day (reused streak series). */
    institutional_net_buy_3d: number | null;
    institutional_net_buy_5d: number | null;
    foreign_buy_streak_days: number | null;
    foreign_net_buy_rank: number | null;
    foreign_net_buy_to_volume_ratio: number | null;
    source_trade_date: string | null;
    freshness: 'PREVIOUS_DAY';
    background: ForeignBackground;
    continuation: InstitutionalContinuation;
    note: string;
}

export interface RadarQualityItem {
    symbol: string;
    name: string;
    eligibility: RadarEligibility;
    momentum_state: RadarMomentumState;
    momentum_reason: string;
    active_confirmations: string[];
    missing_confirmations: string[];
    /** Presentation score for Focus ranking only — not a strategy score. */
    focus_score: number;
    focus_rank: number | null;
    is_focus: boolean;
    focus_reasons: string[];
    raw_rank: number | null;
    raw_rank_change: number | null;
    institutional: InstitutionalSnapshot;
    decision_status: string | null;
    ai_score: number | null;
    data_confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    updated_at: string;
    version: string;
    mutates_strategy: false;
}

export interface FocusSlot {
    focus_rank: 1 | 2 | 3;
    symbol: string;
    name: string;
    momentum_state: RadarMomentumState;
    focus_score: number;
    raw_rank: number | null;
    reasons: string[];
    held_since: string;
}

export interface RadarQualityBatch {
    as_of: string;
    version: string;
    count: number;
    items: RadarQualityItem[];
    focus_top3: FocusSlot[];
    counts: {
        eligible: number;
        active: number;
        pullback: number;
        watch: number;
        inactive: number;
        invalid: number;
    };
    evaluate_interval_sec: number;
    mutates_strategy: false;
    note: string;
    intraday_foreign_identity: 'NOT_AVAILABLE';
}

/** Flat read-only inputs. */
export interface RadarQualityInput {
    symbol: string;
    name: string;
    last_price: number | null;
    change_pct: number | null;
    short_momentum: number | null;
    momentum_acceleration: number | null;
    c_score: number | null;
    c_state: string | null;
    bp_score: number | null;
    bp_states: string[];
    bp_trend_up: boolean;
    rank: number | null;
    rank_prev: number | null;
    rank_change: number | null;
    rank_velocity: number | null;
    vwap_pos_pct: number | null;
    vwap_reclaim: boolean;
    rvol: number | null;
    volume_acceleration: number | null;
    trade_aggression: number | null;
    breakout_type: string | null;
    events: string[];
    pullback_state: string | null;
    sector_state: string | null;
    taiwan_regime: string | null;
    data_health: string | null;
    data_blocked: boolean;
    data_stale: boolean;
    score_coverage_pct: number | null;
    chase_risk: string | null;
    decision_status: string | null;
    ai_score: number | null;
    institutional: InstitutionalSnapshot;
}
