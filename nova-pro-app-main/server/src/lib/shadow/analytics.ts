// Shadow multi-experiment analytics — per experiment BOTH / PROD_ONLY / SHADOW_ONLY.

import type {
    ShadowAnalyticsSummary,
    ShadowArmGroup,
    ShadowArmMetrics,
    ShadowComparisonRow,
    ShadowConfig,
    ShadowOutcomeHint,
} from './types.ts';

function avg(nums: number[]): number | null {
    if (!nums.length) return null;
    return (
        Math.round(
            (nums.reduce((a, b) => a + b, 0) / nums.length) * 100,
        ) / 100
    );
}

function median(nums: number[]): number | null {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    if (s.length % 2 === 0) {
        return Math.round(((s[mid - 1]! + s[mid]!) / 2) * 100) / 100;
    }
    return Math.round(s[mid]! * 100) / 100;
}

function rate(ok: number, n: number): number | null {
    if (!n) return null;
    return Math.round((ok / n) * 1000) / 10;
}

function ratio(num: number, den: number): number | null {
    if (!den) return null;
    return Math.round((num / den) * 1000) / 1000;
}

export function hasProductionSignal(row: ShadowComparisonRow): boolean {
    return (
        row.production.signal_type != null ||
        row.production.b_status === 'pass' ||
        row.production.b_status === 'early_pass' ||
        row.production.c_state === 'STRONG' ||
        row.delta.signal_only_production
    );
}

export function hasShadowSignal(row: ShadowComparisonRow): boolean {
    return (
        row.shadow.signal_type != null ||
        row.shadow.b_status === 'pass' ||
        row.shadow.b_status === 'early_pass' ||
        row.shadow.c_state === 'STRONG' ||
        row.delta.signal_only_shadow
    );
}

export function classifyComparison(
    row: ShadowComparisonRow,
): ShadowArmGroup | 'NEITHER' {
    const p = hasProductionSignal(row);
    const s = hasShadowSignal(row);
    if (p && s) return 'BOTH';
    if (p && !s) return 'PRODUCTION_ONLY';
    if (!p && s) return 'SHADOW_ONLY';
    return 'NEITHER';
}

function emptyMetrics(group: ShadowArmGroup): ShadowArmMetrics {
    return {
        group,
        signal_count: 0,
        positive_5m_rate: null,
        positive_15m_rate: null,
        positive_30m_rate: null,
        avg_forward_return_5m: null,
        avg_forward_return_15m: null,
        avg_forward_return_30m: null,
        median_forward_return_15m: null,
        avg_MFE: null,
        avg_MAE: null,
        avg_MFE_15m: null,
        avg_MAE_15m: null,
        invalid_hit_rate: null,
        signal_coverage_ratio: null,
        avg_score_coverage_pct: null,
        median_score_coverage_pct: null,
        low_confidence_signal_count: 0,
    };
}

function joinKey(symbol: string, timestamp: string): string {
    return `${symbol}|${timestamp.slice(0, 19)}`;
}

function isPromotionEligible(
    side: {
        learning_eligible?: boolean | null;
        score_confidence?: string | null;
    },
    cfg?: Pick<
        ShadowConfig,
        'require_learning_eligible' | 'exclude_low_confidence_from_promotion'
    >,
): boolean {
    if (cfg?.require_learning_eligible !== false) {
        if (side.learning_eligible === false) return false;
        // null treated as unknown — allow for legacy rows without the field
    }
    if (cfg?.exclude_low_confidence_from_promotion !== false) {
        if (side.score_confidence === 'low') return false;
    }
    return true;
}

function metricsForOutcomes(
    group: ShadowArmGroup,
    signalCount: number,
    outcomes: ShadowOutcomeHint[],
    coverageRatio: number | null,
    coveragePcts: number[],
    lowConfCount: number,
): ShadowArmMetrics {
    const fr5 = outcomes
        .map((o) => o.forward_return_5m)
        .filter((v): v is number => v != null);
    const fr15 = outcomes
        .map((o) => o.forward_return_15m)
        .filter((v): v is number => v != null);
    const fr30 = outcomes
        .map((o) => o.forward_return_30m)
        .filter((v): v is number => v != null);
    const mfe = outcomes
        .map((o) => o.mfe)
        .filter((v): v is number => v != null);
    const mae = outcomes
        .map((o) => o.mae)
        .filter((v): v is number => v != null);
    const inv = outcomes.filter((o) => o.invalid_hit != null);
    const invHit = inv.filter((o) => o.invalid_hit).length;

    return {
        group,
        signal_count: signalCount,
        positive_5m_rate: rate(fr5.filter((v) => v > 0).length, fr5.length),
        positive_15m_rate: rate(fr15.filter((v) => v > 0).length, fr15.length),
        positive_30m_rate: rate(fr30.filter((v) => v > 0).length, fr30.length),
        avg_forward_return_5m: avg(fr5),
        avg_forward_return_15m: avg(fr15),
        avg_forward_return_30m: avg(fr30),
        median_forward_return_15m: median(fr15),
        avg_MFE: avg(mfe),
        avg_MAE: avg(mae),
        avg_MFE_15m: avg(mfe),
        avg_MAE_15m: avg(mae),
        invalid_hit_rate: rate(invHit, inv.length),
        signal_coverage_ratio: coverageRatio,
        avg_score_coverage_pct: avg(coveragePcts),
        median_score_coverage_pct: median(coveragePcts),
        low_confidence_signal_count: lowConfCount,
    };
}

export function filterComparisonsByExperiment(
    comparisons: ShadowComparisonRow[],
    experimentId: string,
): ShadowComparisonRow[] {
    return comparisons.filter((r) => r.experiment_id === experimentId);
}

/**
 * Build analytics for ONE experiment.
 * Do not mix experiment_ids.
 */
export function buildShadowAnalytics(
    comparisons: ShadowComparisonRow[],
    outcomes: ShadowOutcomeHint[] = [],
    range?: {
        from?: string;
        to?: string;
        experiment_id?: string;
        experiment_label?: string;
        cfg?: Pick<
            ShadowConfig,
            | 'require_learning_eligible'
            | 'exclude_low_confidence_from_promotion'
        >;
    },
): ShadowAnalyticsSummary {
    const from = range?.from ?? '1970-01-01';
    const to = range?.to ?? '9999-12-31';
    const experiment_id =
        range?.experiment_id ??
        comparisons[0]?.experiment_id ??
        'unknown';
    const experiment_label =
        range?.experiment_label ??
        comparisons[0]?.experiment_label ??
        experiment_id;
    const cfg = range?.cfg;

    let rows = comparisons.filter((r) => {
        const d = r.timestamp.slice(0, 10);
        return d >= from && d <= to;
    });
    if (range?.experiment_id) {
        rows = rows.filter((r) => r.experiment_id === range.experiment_id);
    }

    const outcomeByKey = new Map<string, ShadowOutcomeHint[]>();
    for (const o of outcomes) {
        if (
            o.experiment_id &&
            range?.experiment_id &&
            o.experiment_id !== range.experiment_id
        ) {
            continue;
        }
        const k = joinKey(o.symbol, o.timestamp);
        if (!outcomeByKey.has(k)) outcomeByKey.set(k, []);
        outcomeByKey.get(k)!.push(o);
    }

    const groups: Record<ShadowArmGroup, ShadowComparisonRow[]> = {
        BOTH: [],
        PRODUCTION_ONLY: [],
        SHADOW_ONLY: [],
    };
    for (const row of rows) {
        const g = classifyComparison(row);
        if (g === 'NEITHER') continue;
        groups[g].push(row);
    }

    let production_signal_count = 0;
    let shadow_signal_count = 0;
    let eligible_production_signal_count = 0;
    let eligible_shadow_signal_count = 0;
    const allCoverage: number[] = [];
    let low_confidence_signal_count = 0;

    for (const row of rows) {
        if (hasProductionSignal(row)) {
            production_signal_count += 1;
            if (isPromotionEligible(row.production, cfg)) {
                eligible_production_signal_count += 1;
            }
        }
        if (hasShadowSignal(row)) {
            shadow_signal_count += 1;
            if (isPromotionEligible(row.shadow, cfg)) {
                eligible_shadow_signal_count += 1;
            }
            if (row.shadow.score_confidence === 'low') {
                low_confidence_signal_count += 1;
            }
            if (row.shadow.score_coverage_pct != null) {
                allCoverage.push(row.shadow.score_coverage_pct);
            }
        }
    }

    const signal_coverage_ratio = ratio(
        shadow_signal_count,
        production_signal_count,
    );

    const groupMetrics = {} as Record<ShadowArmGroup, ShadowArmMetrics>;
    for (const g of Object.keys(groups) as ShadowArmGroup[]) {
        const gRows = groups[g];
        const arms: ShadowOutcomeHint[] = [];
        const covPcts: number[] = [];
        let lowConf = 0;
        for (const row of gRows) {
            const hints =
                outcomeByKey.get(joinKey(row.symbol, row.timestamp)) ?? [];
            if (g === 'BOTH') {
                arms.push(...hints);
            } else if (g === 'PRODUCTION_ONLY') {
                arms.push(...hints.filter((h) => h.arm === 'production'));
            } else {
                arms.push(...hints.filter((h) => h.arm === 'shadow'));
            }
            const side = g === 'PRODUCTION_ONLY' ? row.production : row.shadow;
            if (side.score_coverage_pct != null) {
                covPcts.push(side.score_coverage_pct);
            }
            if (side.score_confidence === 'low') lowConf += 1;
        }
        if (arms.length === 0) {
            for (const row of gRows) {
                arms.push(
                    ...(outcomeByKey.get(
                        joinKey(row.symbol, row.timestamp),
                    ) ?? []),
                );
            }
        }
        groupMetrics[g] =
            gRows.length === 0
                ? emptyMetrics(g)
                : metricsForOutcomes(
                      g,
                      gRows.length,
                      arms,
                      signal_coverage_ratio,
                      covPcts,
                      lowConf,
                  );
    }

    const dayMap = new Map<
        string,
        {
            prod: number;
            shadow: number;
            regime: string | null;
            cov: number[];
            maeProd: number[];
            maeShadow: number[];
        }
    >();
    for (const row of rows) {
        const d = row.timestamp.slice(0, 10);
        if (!dayMap.has(d)) {
            dayMap.set(d, {
                prod: 0,
                shadow: 0,
                regime: row.market_regime ?? null,
                cov: [],
                maeProd: [],
                maeShadow: [],
            });
        }
        const bucket = dayMap.get(d)!;
        if (row.market_regime) bucket.regime = row.market_regime;
        if (hasProductionSignal(row)) bucket.prod += 1;
        if (hasShadowSignal(row)) {
            bucket.shadow += 1;
            if (row.shadow.score_coverage_pct != null) {
                bucket.cov.push(row.shadow.score_coverage_pct);
            }
        }
        const hints =
            outcomeByKey.get(joinKey(row.symbol, row.timestamp)) ?? [];
        for (const h of hints) {
            if (h.mae == null) continue;
            if (h.arm === 'production') bucket.maeProd.push(h.mae);
            if (h.arm === 'shadow') bucket.maeShadow.push(h.mae);
        }
    }

    const by_day = [...dayMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => {
            const avgProd = avg(v.maeProd);
            const avgShadow = avg(v.maeShadow);
            let improved: boolean | null = null;
            if (avgProd != null && avgShadow != null) {
                improved = avgShadow >= avgProd;
            }
            return {
                date,
                market_regime: v.regime,
                production_signal_count: v.prod,
                shadow_signal_count: v.shadow,
                signal_coverage_ratio: ratio(v.shadow, v.prod),
                avg_score_coverage_pct: avg(v.cov),
                improved,
            };
        });

    const daysWithVerdict = by_day.filter((d) => d.improved != null);
    const daysImproved = daysWithVerdict.filter((d) => d.improved).length;
    const daysWorsened = daysWithVerdict.filter((d) => d.improved === false)
        .length;
    const days_improved_ratio =
        daysWithVerdict.length === 0
            ? null
            : Math.round((daysImproved / daysWithVerdict.length) * 1000) /
              1000;
    const days_worsened_ratio =
        daysWithVerdict.length === 0
            ? null
            : Math.round((daysWorsened / daysWithVerdict.length) * 1000) /
              1000;

    const regimeMap = new Map<string, { prod: number; shadow: number }>();
    for (const row of rows) {
        const regime = row.market_regime ?? 'unknown';
        if (!regimeMap.has(regime)) {
            regimeMap.set(regime, { prod: 0, shadow: 0 });
        }
        const b = regimeMap.get(regime)!;
        if (hasProductionSignal(row)) b.prod += 1;
        if (hasShadowSignal(row)) b.shadow += 1;
    }
    const by_regime = [...regimeMap.entries()].map(([regime, v]) => ({
        regime,
        production_signal_count: v.prod,
        shadow_signal_count: v.shadow,
    }));

    const typeMap = new Map<string, { prod: number; shadow: number }>();
    for (const row of rows) {
        const pt = row.production.signal_type;
        const st = row.shadow.signal_type;
        if (pt) {
            if (!typeMap.has(String(pt))) {
                typeMap.set(String(pt), { prod: 0, shadow: 0 });
            }
            typeMap.get(String(pt))!.prod += 1;
        }
        if (st) {
            if (!typeMap.has(String(st))) {
                typeMap.set(String(st), { prod: 0, shadow: 0 });
            }
            typeMap.get(String(st))!.shadow += 1;
        }
    }
    const by_signal_type = [...typeMap.entries()].map(([signal_type, v]) => ({
        signal_type,
        production_signal_count: v.prod,
        shadow_signal_count: v.shadow,
    }));

    const coverages = by_day
        .map((d) => d.signal_coverage_ratio)
        .filter((v): v is number => v != null);
    let stability_score = 0;
    if (coverages.length >= 2) {
        const mean = coverages.reduce((a, b) => a + b, 0) / coverages.length;
        const variance =
            coverages.reduce((a, b) => a + (b - mean) ** 2, 0) /
            coverages.length;
        const cv = mean === 0 ? 1 : Math.sqrt(variance) / Math.abs(mean);
        stability_score = Math.max(0, Math.min(1, 1 - cv));
        stability_score = Math.round(stability_score * 1000) / 1000;
    } else if (coverages.length === 1) {
        stability_score = 0.5;
    }

    return {
        experiment_id,
        experiment_label,
        from,
        to,
        comparison_count: rows.length,
        production_signal_count,
        shadow_signal_count,
        eligible_production_signal_count,
        eligible_shadow_signal_count,
        signal_coverage_ratio,
        avg_score_coverage_pct: avg(allCoverage),
        median_score_coverage_pct: median(allCoverage),
        low_confidence_signal_count,
        groups: groupMetrics,
        by_day,
        by_regime,
        by_signal_type,
        stability_score,
        days_improved_ratio,
        days_worsened_ratio,
    };
}

/** Build one summary per experiment_id present in comparisons. */
export function buildAllExperimentAnalytics(
    comparisons: ShadowComparisonRow[],
    outcomes: ShadowOutcomeHint[] = [],
    range?: {
        from?: string;
        to?: string;
        cfg?: Pick<
            ShadowConfig,
            | 'require_learning_eligible'
            | 'exclude_low_confidence_from_promotion'
        >;
    },
): ShadowAnalyticsSummary[] {
    const ids = [
        ...new Set(
            comparisons
                .filter((r) => {
                    const d = r.timestamp.slice(0, 10);
                    const from = range?.from ?? '1970-01-01';
                    const to = range?.to ?? '9999-12-31';
                    return d >= from && d <= to;
                })
                .map((r) => r.experiment_id)
                .filter(Boolean),
        ),
    ];
    return ids.map((id) => {
        const label =
            comparisons.find((r) => r.experiment_id === id)
                ?.experiment_label ?? id;
        return buildShadowAnalytics(comparisons, outcomes, {
            ...range,
            experiment_id: id,
            experiment_label: label,
        });
    });
}

export function computeSignalCoverageRatio(
    shadowCount: number,
    productionCount: number,
): number | null {
    return ratio(shadowCount, productionCount);
}
