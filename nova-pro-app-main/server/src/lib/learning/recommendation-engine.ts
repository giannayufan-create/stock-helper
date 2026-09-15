// server/src/lib/learning/recommendation-engine.ts
// Produce RECOMMEND / REJECT / NEEDS_MORE_DATA — never write production yaml.

import { randomUUID } from 'node:crypto';
import { loadLearningConfig } from './config.ts';
import { computeCohortMetrics, sampleAdequacy } from './evaluator.ts';
import {
    DEFAULT_BASELINE,
    DEFAULT_C_BASELINE,
    baselineFilterFor,
    candidateFilterFor,
    configHashOf,
    searchCandidates,
    selectBestOnTrain,
    sliceTrainOnly,
    type BaselineParams,
} from './parameter-search.ts';
import { assertNoFutureLeak, runWalkForward } from './walk-forward.ts';
import type {
    ExperimentReport,
    LearningDatasetRow,
    RecommendationStatus,
} from './types.ts';

export function buildRecommendation(
    rows: LearningDatasetRow[],
    target: 'open-gate' | 'intraday-rank' = 'open-gate',
    baselineOverride?: Partial<BaselineParams>,
): ExperimentReport {
    const cfg = loadLearningConfig();
    const baseline: BaselineParams = {
        ...(target === 'open-gate' ? DEFAULT_BASELINE : DEFAULT_C_BASELINE),
        ...baselineOverride,
        target,
    };

    const dates = [...new Set(rows.map((r) => r.date))].sort();
    const date_range = {
        from: dates[0] ?? '1970-01-01',
        to: dates[dates.length - 1] ?? '1970-01-01',
    };

    const trainRows = sliceTrainOnly(rows);
    const candidates = searchCandidates(rows, baseline);
    const best = selectBestOnTrain(candidates);

    const baseFilter = baselineFilterFor(baseline);
    const baselineAll = computeCohortMetrics(baseFilter(rows));

    if (!best || sampleAdequacy(trainRows.length) === 'insufficient') {
        return makeReport({
            target,
            date_range,
            baseline,
            candidate: {
                target,
                open_gate:
                    target === 'open-gate'
                        ? {
                              pass_enter_threshold: baseline.pass_enter,
                              pass_exit_threshold: baseline.pass_exit,
                          }
                        : undefined,
                intraday_rank:
                    target === 'intraday-rank'
                        ? {
                              strong_enter: baseline.strong_enter,
                              strong_exit: baseline.strong_exit,
                          }
                        : undefined,
                complexity: 0,
                notes: ['no viable candidate'],
            },
            baselineMetrics: baselineAll,
            candidateMetrics: baselineAll,
            folds: [],
            holdout: null,
            stability_score: 0,
            status: 'NEEDS_MORE_DATA',
            reasons: [
                `eligible/train samples insufficient (n=${trainRows.length})`,
                'Do not promote; collect more learning_eligible outcomes',
            ],
            confidence: 'low',
        });
    }

    const candFilter = candidateFilterFor(best.config);
    const wf = runWalkForward(rows, baseFilter, candFilter);

    for (const f of wf.folds) {
        assertNoFutureLeak(f.train_to, f.validate_from);
    }

    const candidateMetrics = computeCohortMetrics(candFilter(rows));
    const improvedFolds = wf.folds.filter((f) => f.delta.improved).length;
    const foldRatio =
        wf.folds.length === 0 ? 0 : improvedFolds / wf.folds.length;

    const valAvg = averageValidation(wf.folds);
    const reasons: string[] = [];
    let status: RecommendationStatus = 'REJECT';

    if (wf.folds.length === 0) {
        status = 'NEEDS_MORE_DATA';
        reasons.push('No walk-forward folds (need more months of data)');
    } else {
        reasons.push(
            `${improvedFolds}/${wf.folds.length} walk-forward folds improved`,
        );
        reasons.push(`stability_score=${wf.stability_score}`);

        const maeWorsen =
            valAvg.mae_delta != null ? -valAvg.mae_delta : 0;
        // mae_delta > 0 means MAE less negative (better); worsen if delta strongly negative
        const maeBad =
            valAvg.mae_delta != null &&
            valAvg.mae_delta < -cfg.recommendation.max_mae_worsen_abs;
        const invBad =
            valAvg.inv_delta != null &&
            valAvg.inv_delta > cfg.recommendation.max_invalid_rate_worsen_pp;
        const countDropPct =
            baselineAll.count > 0
                ? ((baselineAll.count - candidateMetrics.count) /
                      baselineAll.count) *
                  100
                : 0;

        if (maeBad) {
            reasons.push(
                `MAE worsened beyond limit (delta=${valAvg.mae_delta})`,
            );
        }
        if (invBad) {
            reasons.push(
                `invalid_rate worsened +${valAvg.inv_delta}pp`,
            );
        }
        if (countDropPct > cfg.recommendation.max_count_drop_pct) {
            reasons.push(
                `signal count drop ${countDropPct.toFixed(1)}% too large`,
            );
        }
        if (foldRatio < cfg.recommendation.min_folds_improved_ratio) {
            reasons.push(
                `fold improve ratio ${foldRatio.toFixed(2)} < ${cfg.recommendation.min_folds_improved_ratio}`,
            );
        }
        if (wf.stability_score < cfg.recommendation.min_stability_score) {
            reasons.push('stability below minimum');
        }

        const sampleOk =
            sampleAdequacy(candidateMetrics.count) !== 'insufficient';
        const valBeats =
            valAvg.obj_delta != null && valAvg.obj_delta > 0;

        if (
            sampleOk &&
            valBeats &&
            foldRatio >= cfg.recommendation.min_folds_improved_ratio &&
            !maeBad &&
            !invBad &&
            countDropPct <= cfg.recommendation.max_count_drop_pct &&
            wf.stability_score >= cfg.recommendation.min_stability_score
        ) {
            status = 'RECOMMEND';
            reasons.push('Validation beats baseline with risk guards OK');
            reasons.push(
                'Signal count remains sufficient for research (not trading PnL)',
            );
        } else if (
            sampleAdequacy(candidateMetrics.count) === 'insufficient' ||
            wf.folds.length < 2
        ) {
            status = 'NEEDS_MORE_DATA';
        } else {
            status = 'REJECT';
            reasons.push('Prefer baseline — simple and stable > complex');
        }

        void maeWorsen;
    }

    // Holdout check: if holdout worse, downgrade RECOMMEND
    if (
        status === 'RECOMMEND' &&
        wf.holdout &&
        wf.holdout.delta_objective != null &&
        wf.holdout.delta_objective < 0
    ) {
        status = 'REJECT';
        reasons.push(
            `Holdout objective delta ${wf.holdout.delta_objective} < 0 — do not recommend`,
        );
    }

    const confidence =
        status === 'NEEDS_MORE_DATA'
            ? 'low'
            : wf.stability_score >= 0.7 &&
                sampleAdequacy(candidateMetrics.count) === 'eligible'
              ? 'high'
              : sampleAdequacy(candidateMetrics.count) === 'exploratory'
                ? 'medium'
                : 'medium';

    return makeReport({
        target,
        date_range,
        baseline,
        candidate: best.config,
        baselineMetrics: baselineAll,
        candidateMetrics,
        folds: wf.folds,
        holdout: wf.holdout,
        stability_score: wf.stability_score,
        status,
        reasons,
        confidence,
        candidateHash: best.config_hash,
    });
}

function averageValidation(
    folds: ExperimentReport['walk_forward'],
): {
    obj_delta: number | null;
    mae_delta: number | null;
    inv_delta: number | null;
} {
    if (!folds.length) {
        return { obj_delta: null, mae_delta: null, inv_delta: null };
    }
    const objs = folds
        .map((f) => f.delta.objective)
        .filter((x): x is number => x != null);
    const maes = folds
        .map((f) => f.delta.avg_mae_15m)
        .filter((x): x is number => x != null);
    const invs = folds
        .map((f) => f.delta.invalid_rate)
        .filter((x): x is number => x != null);
    const mean = (a: number[]) =>
        a.length
            ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 1000) /
              1000
            : null;
    return {
        obj_delta: mean(objs),
        mae_delta: mean(maes),
        inv_delta: mean(invs),
    };
}

function makeReport(args: {
    target: 'open-gate' | 'intraday-rank';
    date_range: { from: string; to: string };
    baseline: BaselineParams;
    candidate: ExperimentReport['candidate'];
    baselineMetrics: ExperimentReport['baseline'];
    candidateMetrics: ExperimentReport['candidate_metrics'];
    folds: ExperimentReport['walk_forward'];
    holdout: ExperimentReport['holdout'];
    stability_score: number;
    status: RecommendationStatus;
    reasons: string[];
    confidence: ExperimentReport['confidence'];
    candidateHash?: string;
}): ExperimentReport {
    const baselineHash = configHashOf({
        pass_enter: args.baseline.pass_enter,
        pass_exit: args.baseline.pass_exit,
        strong_enter: args.baseline.strong_enter,
        strong_exit: args.baseline.strong_exit,
        weights: args.baseline.weights,
    });

    const promotion_status =
        args.status === 'RECOMMEND'
            ? 'READY_FOR_MANUAL_REVIEW'
            : 'NOT_READY';

    return {
        experiment_id: `exp_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
        created_at: new Date().toISOString(),
        target: args.target,
        dataset_version: 'learning-dataset-v1',
        date_range: args.date_range,
        baseline_config_hash: baselineHash,
        candidate_config_hash:
            args.candidateHash ?? configHashOf(args.candidate),
        search_space: 'stage1_threshold+stage2_weight_perturb',
        baseline: args.baselineMetrics,
        candidate: args.candidate,
        candidate_metrics: args.candidateMetrics,
        walk_forward: args.folds,
        holdout: args.holdout,
        stability_score: args.stability_score,
        confidence: args.confidence,
        recommendation_status: args.status,
        reasons: args.reasons,
        promotion_status,
    };
}

/** Regime-specific adjustment suggestions (analysis only — not auto-switched). */
export function regimeAdjustmentSuggestions(
    rows: LearningDatasetRow[],
): Record<string, Record<string, number>> {
    const byReg = new Map<string, LearningDatasetRow[]>();
    for (const r of rows) {
        const k = r.market_regime ?? 'unknown';
        if (!byReg.has(k)) byReg.set(k, []);
        byReg.get(k)!.push(r);
    }
    const out: Record<string, Record<string, number>> = {};
    for (const [regime, list] of byReg) {
        const m = computeCohortMetrics(list);
        if ((m.invalid_rate ?? 0) > 25 || (m.avg_mae_15m ?? 0) < -1.5) {
            out[regime] = {
                chase_penalty_delta: 4,
                rs_weight_delta: regime.includes('bear') ? 3 : 0,
            };
        }
    }
    return out;
}
