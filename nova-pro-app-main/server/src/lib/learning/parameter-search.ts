// server/src/lib/learning/parameter-search.ts
// Staged threshold (+ light weight proposal) search → candidate_config only.

import { createHash } from 'node:crypto';
import { loadLearningConfig } from './config.ts';
import {
    computeCohortMetrics,
    filterByDateRange,
    objectiveScore,
} from './evaluator.ts';
import { planWalkForward } from './walk-forward.ts';
import type {
    CandidateConfig,
    CohortMetrics,
    LearningDatasetRow,
} from './types.ts';

export interface BaselineParams {
    target: 'open-gate' | 'intraday-rank';
    pass_enter: number;
    pass_exit: number;
    strong_enter: number;
    strong_exit: number;
    weights?: Record<string, number>;
}

export const DEFAULT_BASELINE: BaselineParams = {
    target: 'open-gate',
    pass_enter: 78,
    pass_exit: 74,
    strong_enter: 80,
    strong_exit: 74,
    weights: {
        rvol: 30,
        vwap: 20,
        open_hold: 15,
        pullback: 15,
        momentum: 15,
        gap: 5,
    },
};

export const DEFAULT_C_BASELINE: BaselineParams = {
    target: 'intraday-rank',
    pass_enter: 78,
    pass_exit: 74,
    strong_enter: 80,
    strong_exit: 74,
    weights: {
        momentum: 20,
        volume_acceleration: 20,
        relative_strength: 15,
        vwap_structure: 15,
        breakout: 10,
        trade_aggression: 10,
        pullback_quality: 5,
        liquidity: 5,
    },
};

function hashConfig(obj: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify(obj))
        .digest('hex')
        .slice(0, 12);
}

/**
 * Retrospective filter: signals that would remain under a score threshold.
 * Does NOT re-run B/C engines — uses frozen feature_snapshot scores.
 */
export function filterByThreshold(
    rows: LearningDatasetRow[],
    target: 'open-gate' | 'intraday-rank',
    enter: number,
): LearningDatasetRow[] {
    if (target === 'open-gate') {
        return rows.filter(
            (r) =>
                r.signal_type === 'OPEN_PASS' &&
                (r.open_score ?? -Infinity) >= enter,
        );
    }
    return rows.filter((r) => {
        if (
            r.signal_type === 'STRONG_ENTER' ||
            r.signal_type === 'SURGE' ||
            r.signal_type === 'BREAKOUT' ||
            r.signal_type === 'REBREAK' ||
            r.signal_type === 'RANK_JUMP' ||
            r.signal_type === 'PULLBACK_READY'
        ) {
            return (r.intraday_score ?? r.heat_score ?? -Infinity) >= enter;
        }
        return false;
    });
}

export interface SearchCandidate {
    config: CandidateConfig;
    train_metrics: CohortMetrics;
    config_hash: string;
}

/**
 * Stage 1: threshold grid on train months only.
 * Stage 2: small weight perturbations (proposals; complexity counted).
 */
export function searchCandidates(
    rows: LearningDatasetRow[],
    baseline: BaselineParams,
): SearchCandidate[] {
    const cfg = loadLearningConfig();
    const plan = planWalkForward(rows);
    // Use all non-holdout months as train pool for ranking candidates
    const holdout = plan.holdout_months;
    const trainRows =
        holdout.length === 0
            ? rows
            : (() => {
                  const lastHold = holdout[0]!;
                  const cutoff = `${lastHold}-01`;
                  return rows.filter((r) => r.date < cutoff);
              })();

    const target = baseline.target;
    const enters =
        target === 'open-gate'
            ? cfg.search.open_gate_pass_enter
            : cfg.search.intraday_strong_enter;
    const exits =
        target === 'open-gate'
            ? cfg.search.open_gate_pass_exit
            : cfg.search.intraday_strong_exit;

    const out: SearchCandidate[] = [];

    // Stage 1
    for (const enter of enters) {
        for (const exit of exits) {
            if (exit >= enter) continue;
            const filtered = filterByThreshold(trainRows, target, enter);
            const metrics = computeCohortMetrics(filtered);
            metrics.objective_score = objectiveScore(metrics, {
                complexity: 0,
                stability: 1,
                baselineCount: filterByThreshold(
                    trainRows,
                    target,
                    target === 'open-gate'
                        ? baseline.pass_enter
                        : baseline.strong_enter,
                ).length,
            });
            const config: CandidateConfig =
                target === 'open-gate'
                    ? {
                          target,
                          open_gate: {
                              pass_enter_threshold: enter,
                              pass_exit_threshold: exit,
                          },
                          complexity: 0,
                          notes: ['stage1_threshold'],
                      }
                    : {
                          target,
                          intraday_rank: {
                              strong_enter: enter,
                              strong_exit: exit,
                          },
                          complexity: 0,
                          notes: ['stage1_threshold'],
                      };
            out.push({
                config,
                train_metrics: metrics,
                config_hash: hashConfig(config),
            });
        }
    }

    // Stage 2 — weight perturbations (proposal only; still evaluated via same threshold filter)
    const baseEnter =
        target === 'open-gate' ? baseline.pass_enter : baseline.strong_enter;
    const baseExit =
        target === 'open-gate' ? baseline.pass_exit : baseline.strong_exit;
    const weights = { ...(baseline.weights ?? {}) };
    const keys = Object.keys(weights);
    let stage2 = 0;
    for (const key of keys) {
        if (stage2 >= cfg.search.max_stage2_candidates) break;
        for (const pct of cfg.search.weight_perturb_pct) {
            if (pct === 0) continue;
            if (stage2 >= cfg.search.max_stage2_candidates) break;
            const next = { ...weights };
            next[key] = Math.round(
                (weights[key] ?? 0) * (1 + pct / 100),
            );
            const filtered = filterByThreshold(trainRows, target, baseEnter);
            const metrics = computeCohortMetrics(filtered);
            const complexity = 0.15;
            metrics.objective_score = objectiveScore(metrics, {
                complexity,
                stability: 1,
                baselineCount: filterByThreshold(
                    trainRows,
                    target,
                    baseEnter,
                ).length,
            });
            const config: CandidateConfig =
                target === 'open-gate'
                    ? {
                          target,
                          open_gate: {
                              pass_enter_threshold: baseEnter,
                              pass_exit_threshold: baseExit,
                              [`${key}_weight`]: next[key]!,
                          },
                          complexity,
                          notes: [
                              'stage2_weight_perturb',
                              `${key}${pct > 0 ? '+' : ''}${pct}%`,
                              'weight change not re-scored from bars — proposal only',
                          ],
                      }
                    : {
                          target,
                          intraday_rank: {
                              strong_enter: baseEnter,
                              strong_exit: baseExit,
                              [`${key}_weight`]: next[key]!,
                          },
                          complexity,
                          notes: [
                              'stage2_weight_perturb',
                              `${key}${pct > 0 ? '+' : ''}${pct}%`,
                              'weight change not re-scored from bars — proposal only',
                          ],
                      };
            out.push({
                config,
                train_metrics: metrics,
                config_hash: hashConfig(config),
            });
            stage2++;
        }
    }

    // Prefer higher train objective, then higher count
    out.sort((a, b) => {
        const oa = a.train_metrics.objective_score ?? -999;
        const ob = b.train_metrics.objective_score ?? -999;
        if (ob !== oa) return ob - oa;
        return b.train_metrics.count - a.train_metrics.count;
    });

    return out;
}

export function selectBestOnTrain(
    candidates: SearchCandidate[],
): SearchCandidate | null {
    return candidates[0] ?? null;
}

export function baselineFilterFor(
    baseline: BaselineParams,
): (rows: LearningDatasetRow[]) => LearningDatasetRow[] {
    const enter =
        baseline.target === 'open-gate'
            ? baseline.pass_enter
            : baseline.strong_enter;
    return (rows) => filterByThreshold(rows, baseline.target, enter);
}

export function candidateFilterFor(
    candidate: CandidateConfig,
): (rows: LearningDatasetRow[]) => LearningDatasetRow[] {
    const enter =
        candidate.target === 'open-gate'
            ? (candidate.open_gate?.pass_enter_threshold ?? 78)
            : (candidate.intraday_rank?.strong_enter ?? 80);
    return (rows) => filterByThreshold(rows, candidate.target, enter);
}

export function configHashOf(obj: unknown): string {
    return hashConfig(obj);
}

export function sliceTrainOnly(
    rows: LearningDatasetRow[],
): LearningDatasetRow[] {
    const plan = planWalkForward(rows);
    if (!plan.holdout_months.length) return rows;
    const firstHold = `${plan.holdout_months[0]}-01`;
    return filterByDateRange(rows, '1970-01-01', prevDay(firstHold));
}

function prevDay(ymd: string): string {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}
