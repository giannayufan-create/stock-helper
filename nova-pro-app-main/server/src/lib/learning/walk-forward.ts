// server/src/lib/learning/walk-forward.ts
// Time-ordered folds — never random 80/20 for primary validation.

import { loadLearningConfig } from './config.ts';
import {
    computeCohortMetrics,
    deltaMetrics,
    filterByDateRange,
    monthKey,
    stabilityScore,
} from './evaluator.ts';
import type {
    LearningDatasetRow,
    WalkForwardFold,
} from './types.ts';

function uniqueMonths(rows: LearningDatasetRow[]): string[] {
    return [...new Set(rows.map((r) => monthKey(r.date)))].sort();
}

function monthBounds(ym: string): { from: string; to: string } {
    const [y, m] = ym.split('-').map(Number);
    const from = `${ym}-01`;
    const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    const to = `${ym}-${String(last).padStart(2, '0')}`;
    return { from, to };
}

function rangeBounds(months: string[]): { from: string; to: string } {
    const a = monthBounds(months[0]!);
    const b = monthBounds(months[months.length - 1]!);
    return { from: a.from, to: b.to };
}

export interface WalkForwardPlan {
    folds: Array<{
        fold_id: string;
        train_months: string[];
        validate_months: string[];
    }>;
    holdout_months: string[];
}

/**
 * Expanding-window walk-forward:
 * Train Jan–Mar / Val Apr; Train Jan–Apr / Val May; ...
 * Last holdout_tail_months reserved and never used for selection.
 */
export function planWalkForward(
    rows: LearningDatasetRow[],
): WalkForwardPlan {
    const cfg = loadLearningConfig().walk_forward;
    const months = uniqueMonths(rows);
    if (months.length === 0) {
        return { folds: [], holdout_months: [] };
    }

    const holdoutN = Math.max(1, cfg.holdout_tail_months);
    const holdout_months =
        months.length > holdoutN
            ? months.slice(months.length - holdoutN)
            : [];
    const usable =
        holdout_months.length > 0
            ? months.slice(0, months.length - holdout_months.length)
            : months;

    const folds: WalkForwardPlan['folds'] = [];
    const minTrain = Math.max(1, cfg.train_months_min);
    const valN = Math.max(1, cfg.validate_months);

    for (let end = minTrain; end + valN - 1 < usable.length; end++) {
        const train_months = usable.slice(0, end);
        const validate_months = usable.slice(end, end + valN);
        if (validate_months.length < valN) break;
        folds.push({
            fold_id: `wf_${train_months[0]}_${validate_months.join('_')}`,
            train_months,
            validate_months,
        });
    }

    return { folds, holdout_months };
}

export type CohortFilter = (rows: LearningDatasetRow[]) => LearningDatasetRow[];

export function runWalkForward(
    rows: LearningDatasetRow[],
    baselineFilter: CohortFilter,
    candidateFilter: CohortFilter,
): {
    folds: WalkForwardFold[];
    holdout: {
        from: string;
        to: string;
        baseline: ReturnType<typeof computeCohortMetrics>;
        candidate: ReturnType<typeof computeCohortMetrics>;
        delta_objective: number | null;
    } | null;
    stability_score: number;
} {
    const plan = planWalkForward(rows);
    const folds: WalkForwardFold[] = [];
    const monthlyCandObj: number[] = [];

    for (const f of plan.folds) {
        const trainBounds = rangeBounds(f.train_months);
        const valBounds = rangeBounds(f.validate_months);
        // Train period is for search only — evaluation metrics use validation
        // (caller runs search on train; here we only score both on validate)
        void trainBounds;

        const valRows = filterByDateRange(
            rows,
            valBounds.from,
            valBounds.to,
        );
        const base = computeCohortMetrics(baselineFilter(valRows));
        const cand = computeCohortMetrics(candidateFilter(valRows));
        const delta = deltaMetrics(base, cand);
        if (cand.objective_score != null) {
            monthlyCandObj.push(cand.objective_score);
        }
        folds.push({
            fold_id: f.fold_id,
            train_from: trainBounds.from,
            train_to: trainBounds.to,
            validate_from: valBounds.from,
            validate_to: valBounds.to,
            baseline: base,
            candidate: cand,
            delta,
        });
    }

    let holdout: {
        from: string;
        to: string;
        baseline: ReturnType<typeof computeCohortMetrics>;
        candidate: ReturnType<typeof computeCohortMetrics>;
        delta_objective: number | null;
    } | null = null;

    if (plan.holdout_months.length) {
        const hb = rangeBounds(plan.holdout_months);
        const hRows = filterByDateRange(rows, hb.from, hb.to);
        const base = computeCohortMetrics(baselineFilter(hRows));
        const cand = computeCohortMetrics(candidateFilter(hRows));
        holdout = {
            from: hb.from,
            to: hb.to,
            baseline: base,
            candidate: cand,
            delta_objective:
                base.objective_score != null &&
                cand.objective_score != null
                    ? Math.round(
                          (cand.objective_score - base.objective_score) *
                              1000,
                      ) / 1000
                    : null,
        };
    }

    return {
        folds,
        holdout,
        stability_score: stabilityScore(monthlyCandObj),
    };
}

/** Ensure train never sees validate/holdout rows (structural check). */
export function assertNoFutureLeak(
    trainTo: string,
    validateFrom: string,
): void {
    if (validateFrom <= trainTo) {
        throw new Error(
            `Future leak: validate_from ${validateFrom} <= train_to ${trainTo}`,
        );
    }
}
