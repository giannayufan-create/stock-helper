// Shadow multi-experiment types — never production mutation / auto-promote.

import type { SignalType, StrategySignal } from '../strategy-signal/types.ts';

export type ShadowPromotionStatus =
    | 'REJECT'
    | 'NEEDS_MORE_DATA'
    | 'READY_FOR_MANUAL_REVIEW';

export type ForbiddenPromotionStatus = 'AUTO_PROMOTE';

export type ShadowArmGroup = 'BOTH' | 'PRODUCTION_ONLY' | 'SHADOW_ONLY';

export type ShadowExperimentLabel =
    | 'SHADOW_B'
    | 'SHADOW_C'
    | 'SHADOW_BC'
    | string;

export interface ShadowExperimentDef {
    experiment_id: string;
    label: ShadowExperimentLabel;
    /** Partial overlays — missing keys keep production values. */
    open_gate?: Record<string, number>;
    intraday_rank?: Record<string, number>;
}

export interface ShadowPromotionConfig {
    auto_promote: false;
    max_mae_worsen_abs: number;
    max_invalid_rate_worsen_pp: number;
    min_days_improved_ratio: number;
    max_signal_coverage_drop_pct: number;
    min_stability_score: number;
}

export interface ShadowConfig {
    enabled: boolean;
    min_shadow_days: number;
    min_shadow_signals: number;
    /** READY requires days AND signals (not OR). */
    promotion_require_both_gates: boolean;
    require_learning_eligible: boolean;
    exclude_low_confidence_from_promotion: boolean;
    min_promotion_coverage_pct: number;
    experiments: ShadowExperimentDef[];
    promotion: ShadowPromotionConfig;
}

export interface ShadowSideSnapshot {
    b_score: number | null;
    b_status: string | null;
    c_score: number | null;
    c_state: string | null;
    signal_type?: SignalType | string | null;
    score_coverage_pct?: number | null;
    score_confidence?: string | null;
    learning_eligible?: boolean | null;
}

export interface ShadowComparisonDelta {
    score_delta_b: number | null;
    score_delta_c: number | null;
    state_changed: boolean;
    signal_only_production: boolean;
    signal_only_shadow: boolean;
}

export interface ShadowComparisonRow {
    experiment_id: string;
    experiment_label: string;
    symbol: string;
    timestamp: string;
    production: ShadowSideSnapshot;
    shadow: ShadowSideSnapshot;
    delta: ShadowComparisonDelta;
    production_config_hash: string;
    candidate_config_hash: string;
    /** @deprecated use candidate_config_hash */
    shadow_config_hash?: string;
    market_regime?: string | null;
    session_minute?: number | null;
}

export type ShadowStrategySignal = StrategySignal & {
    shadow: true;
    experiment_id: string;
    experiment_label?: string;
    production_config_hash: string;
    candidate_config_hash: string;
};

export interface ShadowOutcomeHint {
    symbol: string;
    timestamp: string;
    arm: 'production' | 'shadow';
    experiment_id?: string;
    forward_return_5m?: number | null;
    forward_return_15m?: number | null;
    forward_return_30m?: number | null;
    mfe?: number | null;
    mae?: number | null;
    invalid_hit?: boolean | null;
    signal_type?: string | null;
    learning_eligible?: boolean | null;
    score_confidence?: string | null;
    score_coverage_pct?: number | null;
}

export interface ShadowArmMetrics {
    group: ShadowArmGroup;
    signal_count: number;
    positive_5m_rate: number | null;
    positive_15m_rate: number | null;
    positive_30m_rate: number | null;
    avg_forward_return_5m: number | null;
    avg_forward_return_15m: number | null;
    avg_forward_return_30m: number | null;
    median_forward_return_15m: number | null;
    avg_MFE: number | null;
    avg_MAE: number | null;
    avg_MFE_15m: number | null;
    avg_MAE_15m: number | null;
    invalid_hit_rate: number | null;
    signal_coverage_ratio: number | null;
    avg_score_coverage_pct: number | null;
    median_score_coverage_pct: number | null;
    low_confidence_signal_count: number;
}

export interface ShadowAnalyticsSummary {
    experiment_id: string;
    experiment_label: string;
    from: string;
    to: string;
    comparison_count: number;
    production_signal_count: number;
    shadow_signal_count: number;
    eligible_production_signal_count: number;
    eligible_shadow_signal_count: number;
    signal_coverage_ratio: number | null;
    avg_score_coverage_pct: number | null;
    median_score_coverage_pct: number | null;
    low_confidence_signal_count: number;
    groups: Record<ShadowArmGroup, ShadowArmMetrics>;
    by_day: Array<{
        date: string;
        market_regime?: string | null;
        production_signal_count: number;
        shadow_signal_count: number;
        signal_coverage_ratio: number | null;
        avg_score_coverage_pct?: number | null;
        improved: boolean | null;
    }>;
    by_regime: Array<{
        regime: string;
        production_signal_count: number;
        shadow_signal_count: number;
    }>;
    by_signal_type: Array<{
        signal_type: string;
        production_signal_count: number;
        shadow_signal_count: number;
    }>;
    stability_score: number;
    days_improved_ratio: number | null;
    days_worsened_ratio: number | null;
}

export interface ShadowPromotionRecommendation {
    experiment_id: string;
    status: ShadowPromotionStatus;
    reasons: string[];
    auto_promote: false;
}
