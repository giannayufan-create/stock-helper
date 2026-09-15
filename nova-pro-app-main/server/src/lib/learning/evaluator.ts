// server/src/lib/learning/evaluator.ts
// Multi-objective cohort metrics — never a single win_rate.

import { loadLearningConfig } from './config.ts';
import type {
    CohortMetrics,
    LearningConfidence,
    LearningDatasetRow,
    SampleAdequacy,
} from './types.ts';

function avg(nums: number[]): number | null {
    if (!nums.length) return null;
    return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) /
        1000;
}

function rate(ok: number, n: number): number | null {
    if (!n) return null;
    return Math.round((ok / n) * 1000) / 10;
}

export function sampleAdequacy(n: number): SampleAdequacy {
    const g = loadLearningConfig().sample_guards;
    if (n < g.insufficient_below) return 'insufficient';
    if (n < g.exploratory_below) return 'exploratory';
    return 'eligible';
}

export function confidenceFromSample(
    n: number,
    extras?: {
        regimeCount?: number;
        monthCount?: number;
        stable?: boolean;
    },
): LearningConfidence {
    const adeq = sampleAdequacy(n);
    if (adeq === 'insufficient') return 'low';
    let score = adeq === 'eligible' ? 2 : 1;
    if ((extras?.regimeCount ?? 0) >= 3) score += 1;
    if ((extras?.monthCount ?? 0) >= 3) score += 1;
    if (extras?.stable === false) score -= 1;
    if (score >= 3) return 'high';
    if (score >= 2) return 'medium';
    return 'low';
}

export function computeCohortMetrics(
    rows: LearningDatasetRow[],
): CohortMetrics {
    const fr15 = rows
        .map((r) => r.forward_return_15m)
        .filter((x): x is number => x != null);
    const fr30 = rows
        .map((r) => r.forward_return_30m)
        .filter((x): x is number => x != null);
    const mfe = rows
        .map((r) => r.mfe_15m)
        .filter((x): x is number => x != null);
    const mae = rows
        .map((r) => r.mae_15m)
        .filter((x): x is number => x != null);
    const quality = rows
        .map((r) => r.signal_quality_score)
        .filter((x): x is number => x != null);
    const invalidKnown = rows.filter((r) => r.invalid_hit != null);
    const invalidHits = invalidKnown.filter((r) => r.invalid_hit).length;

    const metrics: CohortMetrics = {
        count: rows.length,
        positive_15m_rate: rate(fr15.filter((x) => x > 0).length, fr15.length),
        positive_30m_rate: rate(fr30.filter((x) => x > 0).length, fr30.length),
        avg_return_15m: avg(fr15),
        avg_mfe_15m: avg(mfe),
        avg_mae_15m: avg(mae),
        invalid_rate: rate(invalidHits, invalidKnown.length),
        avg_quality: avg(quality),
        objective_score: null,
    };
    metrics.objective_score = objectiveScore(metrics, {
        complexity: 0,
        stability: 1,
        baselineCount: rows.length,
    });
    return metrics;
}

export function objectiveScore(
    m: CohortMetrics,
    ctx: {
        complexity: number;
        stability: number;
        baselineCount: number;
    },
): number {
    const o = loadLearningConfig().objective;
    const pos = (m.positive_15m_rate ?? 50) / 100;
    const mfe = m.avg_mfe_15m ?? 0;
    const maeAbs = Math.abs(Math.min(0, m.avg_mae_15m ?? 0));
    const inv = (m.invalid_rate ?? 0) / 100;

    let score =
        pos * o.positive_15m_weight +
        mfe * o.avg_mfe_15m_weight -
        maeAbs * o.avg_mae_15m_penalty -
        inv * o.invalid_rate_penalty;

    score -= (1 - Math.max(0, Math.min(1, ctx.stability))) *
        o.instability_penalty;
    score -= ctx.complexity * o.complexity_penalty;

    if (sampleAdequacy(m.count) === 'insufficient') {
        score -= o.low_sample_penalty;
    } else if (sampleAdequacy(m.count) === 'exploratory') {
        score -= o.low_sample_penalty * 0.4;
    }

    if (ctx.baselineCount > 0 && m.count < ctx.baselineCount) {
        const drop =
            ((ctx.baselineCount - m.count) / ctx.baselineCount) * 100;
        score -= (drop / 10) * o.count_drop_soft_penalty;
    }

    return Math.round(score * 1000) / 1000;
}

export function deltaMetrics(
    baseline: CohortMetrics,
    candidate: CohortMetrics,
): {
    positive_15m_rate: number | null;
    avg_mfe_15m: number | null;
    avg_mae_15m: number | null;
    invalid_rate: number | null;
    objective: number | null;
    improved: boolean;
} {
    const dPos =
        baseline.positive_15m_rate != null &&
        candidate.positive_15m_rate != null
            ? Math.round(
                  (candidate.positive_15m_rate - baseline.positive_15m_rate) *
                      10,
              ) / 10
            : null;
    const dMfe =
        baseline.avg_mfe_15m != null && candidate.avg_mfe_15m != null
            ? Math.round(
                  (candidate.avg_mfe_15m - baseline.avg_mfe_15m) * 1000,
              ) / 1000
            : null;
    const dMae =
        baseline.avg_mae_15m != null && candidate.avg_mae_15m != null
            ? Math.round(
                  (candidate.avg_mae_15m - baseline.avg_mae_15m) * 1000,
              ) / 1000
            : null;
    const dInv =
        baseline.invalid_rate != null && candidate.invalid_rate != null
            ? Math.round(
                  (candidate.invalid_rate - baseline.invalid_rate) * 10,
              ) / 10
            : null;
    const dObj =
        baseline.objective_score != null &&
        candidate.objective_score != null
            ? Math.round(
                  (candidate.objective_score - baseline.objective_score) *
                      1000,
              ) / 1000
            : null;

    // MAE: less negative is better → positive delta on mae (e.g. -0.8 → -0.6 = +0.2) is good
    const maeOk = dMae == null || dMae >= -0.05;
    const improved =
        (dObj != null && dObj > 0) ||
        ((dPos != null && dPos > 0) && maeOk);

    return {
        positive_15m_rate: dPos,
        avg_mfe_15m: dMfe,
        avg_mae_15m: dMae,
        invalid_rate: dInv,
        objective: dObj,
        improved,
    };
}

/** Month key YYYY-MM from date YYYY-MM-DD */
export function monthKey(ymd: string): string {
    return ymd.slice(0, 7);
}

export function stabilityScore(
    monthlyObjectives: number[],
): number {
    if (monthlyObjectives.length < 2) return 0.3;
    const mean =
        monthlyObjectives.reduce((a, b) => a + b, 0) /
        monthlyObjectives.length;
    if (mean === 0) return 0.5;
    const variance =
        monthlyObjectives.reduce((a, b) => a + (b - mean) ** 2, 0) /
        monthlyObjectives.length;
    const cv = Math.sqrt(variance) / Math.abs(mean);
    // lower CV → higher stability; clamp
    const s = 1 / (1 + cv);
    return Math.round(Math.max(0, Math.min(1, s)) * 1000) / 1000;
}

export function filterByDateRange(
    rows: LearningDatasetRow[],
    from: string,
    to: string,
): LearningDatasetRow[] {
    return rows.filter((r) => r.date >= from && r.date <= to);
}
