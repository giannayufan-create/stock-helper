// server/src/lib/learning/types.ts
// Learning research types — recommendations only, never production mutation.

import type { SignalType } from '../strategy-signal/types.ts';

export const LEARNING_SCHEMA_VERSION = 'learning-dataset-v1';
export const SIGNAL_SCHEMA_VERSION = 'strategy-signal-v1';
export const OUTCOME_SCHEMA_VERSION = 'signal-outcome-v1';

export type LearningConfidence = 'low' | 'medium' | 'high';

export type RecommendationStatus =
    | 'RECOMMEND'
    | 'REJECT'
    | 'NEEDS_MORE_DATA';

export type PromotionStatus = 'READY_FOR_MANUAL_REVIEW' | 'NOT_READY';

export type SampleAdequacy =
    | 'insufficient'
    | 'exploratory'
    | 'eligible';

export interface LearningDatasetRow {
    signal_id: string;
    date: string;
    symbol: string;
    signal_type: SignalType;
    signal_time: string;
    session_minute: number | null;

    source_mode: 'live' | 'replay';
    data_resolution: 'tick' | '1m';

    market_regime: string | null;

    a_score: number | null;
    open_score: number | null;
    intraday_score: number | null;
    heat_score: number | null;

    rvol: number | null;
    vwap_pos: number | null;
    momentum: number | null;
    volume_acceleration: number | null;
    relative_strength: number | null;
    breakout_score: number | null;
    pullback_quality: number | null;
    rank_velocity: number | null;
    chase_risk: string | null;

    forward_return_5m: number | null;
    forward_return_15m: number | null;
    forward_return_30m: number | null;
    forward_return_60m: number | null;

    mfe_15m: number | null;
    mae_15m: number | null;
    invalid_hit: boolean | null;
    outcome_sequence: string | null;
    outcome_status: string | null;

    strategy_version: string;
    config_hash: string;
    score_confidence: string | null;
    learning_eligible: boolean;
    universe_source: string | null;

    /** Research-only composite — not B/C production score. */
    signal_quality_score: number | null;

    /** Research labels (multi-objective, not a single win/loss). */
    positive_15m: boolean | null;
    positive_30m: boolean | null;
    mfe_15m_ge_1: boolean | null;
    mfe_15m_ge_2: boolean | null;
    mae_15m_gt_neg1: boolean | null;
    invalid_hit_false: boolean | null;
}

export interface DatasetBuildReport {
    dataset_version: string;
    signal_schema_version: string;
    outcome_schema_version: string;
    eligible_samples: number;
    excluded_samples: number;
    exclusion_reasons: Record<string, number>;
    date_coverage: { from: string | null; to: string | null; days: number };
    regime_coverage: Record<string, number>;
    signal_distribution: Record<string, number>;
    source_mode_coverage: Record<string, number>;
}

export interface BucketAnalysisRow {
    feature: string;
    bucket: string;
    count: number;
    sample_adequacy: SampleAdequacy;
    confidence: LearningConfidence;
    mean: number | null;
    median: number | null;
    positive_15m_rate: number | null;
    avg_return_15m: number | null;
    avg_MFE: number | null;
    avg_MAE: number | null;
    invalid_rate: number | null;
    avg_quality: number | null;
}

export interface FeatureFinding {
    feature: string;
    polarity: 'positive' | 'negative' | 'non_informative' | 'mixed';
    reason: string;
    confidence: LearningConfidence;
    best_bucket?: string;
    worst_bucket?: string;
}

export interface SignalTypeLearningStats {
    signal_type: string;
    count: number;
    sample_adequacy: SampleAdequacy;
    confidence: LearningConfidence;
    positive_15m_rate: number | null;
    avg_return_15m: number | null;
    avg_MFE_15m: number | null;
    avg_MAE_15m: number | null;
    invalid_rate: number | null;
    avg_quality: number | null;
    tag?: 'low_information_signal';
}

export interface CohortMetrics {
    count: number;
    positive_15m_rate: number | null;
    positive_30m_rate: number | null;
    avg_return_15m: number | null;
    avg_mfe_15m: number | null;
    avg_mae_15m: number | null;
    invalid_rate: number | null;
    avg_quality: number | null;
    objective_score: number | null;
}

export interface WalkForwardFold {
    fold_id: string;
    train_from: string;
    train_to: string;
    validate_from: string;
    validate_to: string;
    baseline: CohortMetrics;
    candidate: CohortMetrics;
    delta: {
        positive_15m_rate: number | null;
        avg_mfe_15m: number | null;
        avg_mae_15m: number | null;
        invalid_rate: number | null;
        objective: number | null;
        improved: boolean;
    };
}

export interface CandidateConfig {
    target: 'open-gate' | 'intraday-rank';
    open_gate?: Record<string, number>;
    intraday_rank?: Record<string, number>;
    regime_adjustments?: Record<string, Record<string, number>>;
    complexity: number;
    notes?: string[];
}

export interface ExperimentReport {
    experiment_id: string;
    created_at: string;
    target: 'open-gate' | 'intraday-rank';
    dataset_version: string;
    date_range: { from: string; to: string };
    baseline_config_hash: string;
    candidate_config_hash: string;
    search_space: string;
    baseline: CohortMetrics;
    candidate: CandidateConfig;
    candidate_metrics: CohortMetrics;
    walk_forward: WalkForwardFold[];
    holdout: {
        from: string;
        to: string;
        baseline: CohortMetrics;
        candidate: CohortMetrics;
        delta_objective: number | null;
    } | null;
    stability_score: number;
    confidence: LearningConfidence;
    recommendation_status: RecommendationStatus;
    reasons: string[];
    promotion_status: PromotionStatus;
}

export interface ShadowComparisonRow {
    symbol: string;
    evaluated_at: string;
    production_score: number | null;
    shadow_score: number | null;
    production_state: string | null;
    shadow_state: string | null;
    config_hash_production: string;
    config_hash_shadow: string;
}

export interface LearningConfig {
    dataset: {
        signal_schema_version: string;
        outcome_schema_version: string;
        learning_schema_version: string;
        require_learning_eligible: boolean;
        exclude_universe_sources: string[];
        exclude_score_confidence: string[];
        exclude_outcome_status: string[];
        exclude_replay_quality_invalid: boolean;
    };
    sample_guards: {
        min_sample_warning: number;
        min_sample_recommendation: number;
        min_combo_sample: number;
        insufficient_below: number;
        exploratory_below: number;
    };
    quality_score: {
        forward_return_15m_weight: number;
        mfe_15m_weight: number;
        mae_15m_penalty: number;
        invalid_hit_penalty: number;
        ambiguous_penalty: number;
    };
    objective: {
        positive_15m_weight: number;
        avg_mfe_15m_weight: number;
        avg_mae_15m_penalty: number;
        invalid_rate_penalty: number;
        instability_penalty: number;
        low_sample_penalty: number;
        complexity_penalty: number;
        count_drop_soft_penalty: number;
    };
    walk_forward: {
        train_months_min: number;
        validate_months: number;
        holdout_months: number;
        holdout_tail_months: number;
    };
    search: {
        open_gate_pass_enter: number[];
        open_gate_pass_exit: number[];
        intraday_strong_enter: number[];
        intraday_strong_exit: number[];
        weight_perturb_pct: number[];
        max_stage2_candidates: number;
    };
    recommendation: {
        min_folds_improved_ratio: number;
        max_mae_worsen_abs: number;
        max_invalid_rate_worsen_pp: number;
        min_stability_score: number;
        max_count_drop_pct: number;
    };
    shadow: {
        enabled: boolean;
        min_shadow_days: number;
        min_shadow_signals: number;
        reuse_market_runtime: boolean;
    };
    promotion: {
        auto_promote: false;
        status_when_ready: string;
    };
    feature_buckets: Record<
        string,
        Array<{ label: string; min?: number; max?: number }>
    >;
    time_of_day: Array<{
        label: string;
        min_minute: number;
        max_minute: number;
    }>;
    regimes: string[];
}
