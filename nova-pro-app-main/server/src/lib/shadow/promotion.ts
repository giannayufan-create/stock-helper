// Shadow promotion — AND gate, never AUTO_PROMOTE, never writes production.

import { loadShadowConfig } from './config.ts';
import type {
    ShadowAnalyticsSummary,
    ShadowConfig,
    ShadowPromotionRecommendation,
    ShadowPromotionStatus,
} from './types.ts';

export interface PromotionInput {
    experiment_id: string;
    analytics: ShadowAnalyticsSummary;
    shadowDays: number;
    eligibleShadowSignals: number;
    cfg: ShadowConfig;
}

function fail(
    experiment_id: string,
    status: ShadowPromotionStatus,
    reasons: string[],
): ShadowPromotionRecommendation {
    return {
        experiment_id,
        status,
        reasons,
        auto_promote: false,
    };
}

/**
 * Evaluate one experiment.
 * READY_FOR_MANUAL_REVIEW requires (when promotion_require_both_gates):
 *   shadow_days >= min AND eligible_signals >= min
 * Otherwise NEEDS_MORE_DATA.
 * Never returns AUTO_PROMOTE. Never mutates production config.
 */
export function evaluateShadowPromotion(
    input: PromotionInput,
): ShadowPromotionRecommendation {
    const { experiment_id, analytics, shadowDays, eligibleShadowSignals, cfg } =
        input;
    const reasons: string[] = [];

    const daysOk = shadowDays >= cfg.min_shadow_days;
    const signalsOk = eligibleShadowSignals >= cfg.min_shadow_signals;

    if (cfg.promotion_require_both_gates) {
        if (!daysOk || !signalsOk) {
            if (!daysOk) {
                reasons.push(
                    `shadow_days=${shadowDays} < ${cfg.min_shadow_days}`,
                );
            }
            if (!signalsOk) {
                reasons.push(
                    `eligible_signals=${eligibleShadowSignals} < ${cfg.min_shadow_signals}`,
                );
            }
            reasons.push(
                'AND gate: need both days and eligible signals for READY',
            );
            return fail(experiment_id, 'NEEDS_MORE_DATA', reasons);
        }
    } else if (!daysOk && !signalsOk) {
        reasons.push(
            `shadow_days=${shadowDays} < ${cfg.min_shadow_days} AND eligible_signals=${eligibleShadowSignals} < ${cfg.min_shadow_signals}`,
        );
        return fail(experiment_id, 'NEEDS_MORE_DATA', reasons);
    }

    const both = analytics.groups.BOTH;
    const prodOnly = analytics.groups.PRODUCTION_ONLY;
    const shadowOnly = analytics.groups.SHADOW_ONLY;

    const coverage = analytics.signal_coverage_ratio;
    if (
        coverage != null &&
        coverage < 1 - cfg.promotion.max_signal_coverage_drop_pct / 100
    ) {
        reasons.push(
            `signal_coverage_ratio=${coverage} drops more than ${cfg.promotion.max_signal_coverage_drop_pct}%`,
        );
        return fail(experiment_id, 'REJECT', reasons);
    }

    const avgCov = analytics.avg_score_coverage_pct;
    if (
        avgCov != null &&
        avgCov < cfg.min_promotion_coverage_pct
    ) {
        reasons.push(
            `avg_score_coverage_pct=${avgCov} < min_promotion_coverage_pct=${cfg.min_promotion_coverage_pct}`,
        );
        return fail(experiment_id, 'REJECT', reasons);
    }

    const maeBoth = both.avg_MAE_15m ?? both.avg_MAE;
    const maeProd = prodOnly.avg_MAE_15m ?? prodOnly.avg_MAE;
    if (
        maeBoth != null &&
        maeProd != null &&
        maeBoth < maeProd - cfg.promotion.max_mae_worsen_abs
    ) {
        reasons.push(
            `BOTH MAE worsened vs PRODUCTION_ONLY beyond ${cfg.promotion.max_mae_worsen_abs}`,
        );
        return fail(experiment_id, 'REJECT', reasons);
    }

    const invBoth = both.invalid_hit_rate;
    const invProd = prodOnly.invalid_hit_rate;
    if (
        invBoth != null &&
        invProd != null &&
        invBoth > invProd + cfg.promotion.max_invalid_rate_worsen_pp
    ) {
        reasons.push(
            `invalid_hit_rate worsened > ${cfg.promotion.max_invalid_rate_worsen_pp}pp`,
        );
        return fail(experiment_id, 'REJECT', reasons);
    }

    if (
        analytics.days_improved_ratio != null &&
        analytics.days_improved_ratio < cfg.promotion.min_days_improved_ratio
    ) {
        reasons.push(
            `days_improved_ratio=${analytics.days_improved_ratio} < ${cfg.promotion.min_days_improved_ratio}`,
        );
        return fail(experiment_id, 'REJECT', reasons);
    }

    if (analytics.stability_score < cfg.promotion.min_stability_score) {
        reasons.push(
            `stability_score=${analytics.stability_score} < ${cfg.promotion.min_stability_score}`,
        );
        return fail(experiment_id, 'REJECT', reasons);
    }

    // Prefer shadow quality signals when enough BOTH samples exist
    if (both.signal_count >= 5) {
        const p15s = both.positive_15m_rate;
        const p15p = prodOnly.positive_15m_rate;
        if (p15s != null && p15p != null && p15s + 1 < p15p) {
            reasons.push(
                `BOTH positive_15m_rate (${p15s}) not better than PRODUCTION_ONLY (${p15p})`,
            );
            return fail(experiment_id, 'REJECT', reasons);
        }
    }

    if (shadowOnly.signal_count > 0 && prodOnly.signal_count > 0) {
        // informational — not hard reject
        reasons.push(
            `cohort sizes BOTH=${both.signal_count} PROD_ONLY=${prodOnly.signal_count} SHADOW_ONLY=${shadowOnly.signal_count}`,
        );
    }

    reasons.push(
        'Passed quality gates — READY_FOR_MANUAL_REVIEW only (auto_promote=false)',
    );
    return {
        experiment_id,
        status: 'READY_FOR_MANUAL_REVIEW',
        reasons,
        auto_promote: false,
    };
}

/** Guard: status string must never be AUTO_PROMOTE. */
export function assertNeverAutoPromote(
    rec: ShadowPromotionRecommendation,
): void {
    if ((rec as { status: string }).status === 'AUTO_PROMOTE') {
        throw new Error('AUTO_PROMOTE is forbidden');
    }
    if (rec.auto_promote !== false) {
        throw new Error('auto_promote must be false');
    }
}

/**
 * Compat wrapper used by CLI/tests.
 * Infers days from analytics.by_day; eligible from eligible_shadow_signal_count.
 */
export function recommendPromotion(
    analytics: ShadowAnalyticsSummary,
    cfg?: ShadowConfig,
): ShadowPromotionRecommendation {
    const resolved = cfg ?? loadShadowConfig();
    return evaluateShadowPromotion({
        experiment_id: analytics.experiment_id,
        analytics,
        shadowDays: analytics.by_day.length,
        eligibleShadowSignals: analytics.eligible_shadow_signal_count,
        cfg: resolved,
    });
}
