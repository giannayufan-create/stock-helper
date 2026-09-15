// server/src/lib/learning/feature-analysis.ts
// F1: bucket / decile / regime / TOD stats — no ML.

import { loadLearningConfig } from './config.ts';
import {
    computeCohortMetrics,
    confidenceFromSample,
    sampleAdequacy,
} from './evaluator.ts';
import type {
    BucketAnalysisRow,
    FeatureFinding,
    LearningDatasetRow,
    SignalTypeLearningStats,
} from './types.ts';

function avg(nums: number[]): number | null {
    if (!nums.length) return null;
    return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) /
        1000;
}

function median(nums: number[]): number | null {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    const v =
        s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
    return Math.round(v * 1000) / 1000;
}

function rate(ok: number, n: number): number | null {
    if (!n) return null;
    return Math.round((ok / n) * 1000) / 10;
}

function matchBucket(
    value: number,
    defs: Array<{ label: string; min?: number; max?: number }>,
): string | null {
    for (const d of defs) {
        if (d.min != null && value < d.min) continue;
        if (d.max != null && value >= d.max) continue;
        return d.label;
    }
    return null;
}

function featureValue(
    row: LearningDatasetRow,
    feature: string,
): number | null {
    switch (feature) {
        case 'rvol':
            return row.rvol;
        case 'vwap_pos':
            return row.vwap_pos;
        case 'heat':
            return row.heat_score;
        case 'open_score':
            return row.open_score;
        case 'intraday_score':
            return row.intraday_score;
        case 'momentum':
            return row.momentum;
        case 'volume_acceleration':
            return row.volume_acceleration;
        case 'relative_strength':
            return row.relative_strength;
        case 'breakout_score':
            return row.breakout_score;
        case 'pullback_quality':
            return row.pullback_quality;
        case 'rank_velocity':
            return row.rank_velocity;
        default:
            return null;
    }
}

function bucketRows(
    rows: LearningDatasetRow[],
    feature: string,
    labelFn: (r: LearningDatasetRow) => string | null,
): BucketAnalysisRow[] {
    const groups = new Map<string, LearningDatasetRow[]>();
    for (const r of rows) {
        const b = labelFn(r);
        if (!b) continue;
        if (!groups.has(b)) groups.set(b, []);
        groups.get(b)!.push(r);
    }
    const out: BucketAnalysisRow[] = [];
    for (const [bucket, list] of [...groups.entries()].sort()) {
        const vals = list
            .map((r) => featureValue(r, feature))
            .filter((x): x is number => x != null);
        const fr15 = list
            .map((r) => r.forward_return_15m)
            .filter((x): x is number => x != null);
        const mfe = list
            .map((r) => r.mfe_15m)
            .filter((x): x is number => x != null);
        const mae = list
            .map((r) => r.mae_15m)
            .filter((x): x is number => x != null);
        const invKnown = list.filter((r) => r.invalid_hit != null);
        out.push({
            feature,
            bucket,
            count: list.length,
            sample_adequacy: sampleAdequacy(list.length),
            confidence: confidenceFromSample(list.length),
            mean: avg(vals),
            median: median(vals),
            positive_15m_rate: rate(
                fr15.filter((x) => x > 0).length,
                fr15.length,
            ),
            avg_return_15m: avg(fr15),
            avg_MFE: avg(mfe),
            avg_MAE: avg(mae),
            invalid_rate: rate(
                invKnown.filter((r) => r.invalid_hit).length,
                invKnown.length,
            ),
            avg_quality: avg(
                list
                    .map((r) => r.signal_quality_score)
                    .filter((x): x is number => x != null),
            ),
        });
    }
    return out;
}

export function analyzeFeatureBuckets(
    rows: LearningDatasetRow[],
    feature: string,
): BucketAnalysisRow[] {
    const cfg = loadLearningConfig();
    const defs = cfg.feature_buckets[feature];
    if (defs?.length) {
        return bucketRows(rows, feature, (r) => {
            const v = featureValue(r, feature);
            if (v == null) return null;
            return matchBucket(v, defs);
        });
    }
    return [];
}

/** Decile analysis for continuous features (1=lowest … 10=highest). */
export function analyzeDeciles(
    rows: LearningDatasetRow[],
    feature: string,
): BucketAnalysisRow[] {
    const scored = rows
        .map((r) => ({ r, v: featureValue(r, feature) }))
        .filter((x): x is { r: LearningDatasetRow; v: number } => x.v != null)
        .sort((a, b) => a.v - b.v);
    if (scored.length < 10) {
        return bucketRows(
            scored.map((x) => x.r),
            feature,
            () => 'all',
        );
    }
    const n = scored.length;
    return bucketRows(
        scored.map((x) => x.r),
        feature,
        (r) => {
            const idx = scored.findIndex((x) => x.r.signal_id === r.signal_id);
            if (idx < 0) return null;
            const dec = Math.min(10, Math.floor((idx / n) * 10) + 1);
            return `D${dec}`;
        },
    );
}

export function analyzeChaseRisk(
    rows: LearningDatasetRow[],
): BucketAnalysisRow[] {
    return bucketRows(rows, 'chase_risk', (r) => r.chase_risk);
}

export function analyzeSignalTypes(
    rows: LearningDatasetRow[],
): SignalTypeLearningStats[] {
    const groups = new Map<string, LearningDatasetRow[]>();
    for (const r of rows) {
        if (!groups.has(r.signal_type)) groups.set(r.signal_type, []);
        groups.get(r.signal_type)!.push(r);
    }
    const out: SignalTypeLearningStats[] = [];
    for (const [signal_type, list] of [...groups.entries()].sort()) {
        const m = computeCohortMetrics(list);
        const pos = m.positive_15m_rate ?? 50;
        const nearRandom = Math.abs(pos - 50) < 3 && list.length >= 50;
        out.push({
            signal_type,
            count: list.length,
            sample_adequacy: sampleAdequacy(list.length),
            confidence: confidenceFromSample(list.length),
            positive_15m_rate: m.positive_15m_rate,
            avg_return_15m: m.avg_return_15m,
            avg_MFE_15m: m.avg_mfe_15m,
            avg_MAE_15m: m.avg_mae_15m,
            invalid_rate: m.invalid_rate,
            avg_quality: m.avg_quality,
            tag: nearRandom ? 'low_information_signal' : undefined,
        });
    }
    return out;
}

export function analyzeByRegime(
    rows: LearningDatasetRow[],
): Array<{ regime: string; stats: SignalTypeLearningStats[] }> {
    const byReg = new Map<string, LearningDatasetRow[]>();
    for (const r of rows) {
        const k = r.market_regime ?? 'unknown';
        if (!byReg.has(k)) byReg.set(k, []);
        byReg.get(k)!.push(r);
    }
    return [...byReg.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([regime, list]) => ({
            regime,
            stats: analyzeSignalTypes(list),
        }));
}

export function analyzeTimeOfDay(
    rows: LearningDatasetRow[],
    signalType?: string,
): BucketAnalysisRow[] {
    const cfg = loadLearningConfig();
    const filtered = signalType
        ? rows.filter((r) => r.signal_type === signalType)
        : rows;
    return bucketRows(filtered, 'session_minute', (r) => {
        if (r.session_minute == null) return null;
        for (const t of cfg.time_of_day) {
            if (
                r.session_minute >= t.min_minute &&
                r.session_minute < t.max_minute
            ) {
                return t.label;
            }
        }
        return null;
    });
}

export function analyzeCombinations(
    rows: LearningDatasetRow[],
): BucketAnalysisRow[] {
    const cfg = loadLearningConfig();
    const bySymDay = new Map<string, Set<string>>();
    for (const r of rows) {
        const k = `${r.date}|${r.symbol}`;
        if (!bySymDay.has(k)) bySymDay.set(k, new Set());
        bySymDay.get(k)!.add(r.signal_type);
    }

    const comboKeys = [
        'OPEN_PASS+SURGE',
        'OPEN_PASS+REBREAK',
        'STRONG_ENTER+RANK_JUMP',
        'PULLBACK_READY+high_RS',
    ] as const;

    const groups = new Map<string, LearningDatasetRow[]>();
    for (const r of rows) {
        const set = bySymDay.get(`${r.date}|${r.symbol}`);
        if (!set) continue;
        const tags: string[] = [];
        if (set.has('OPEN_PASS') && set.has('SURGE'))
            tags.push('OPEN_PASS+SURGE');
        if (set.has('OPEN_PASS') && set.has('REBREAK'))
            tags.push('OPEN_PASS+REBREAK');
        if (set.has('STRONG_ENTER') && set.has('RANK_JUMP'))
            tags.push('STRONG_ENTER+RANK_JUMP');
        if (
            set.has('PULLBACK_READY') &&
            (r.relative_strength ?? 0) >= 70
        ) {
            tags.push('PULLBACK_READY+high_RS');
        }
        for (const t of tags) {
            if (!groups.has(t)) groups.set(t, []);
            groups.get(t)!.push(r);
        }
    }

    const out: BucketAnalysisRow[] = [];
    for (const key of comboKeys) {
        const list = groups.get(key) ?? [];
        if (list.length < cfg.sample_guards.min_combo_sample) {
            out.push({
                feature: 'combination',
                bucket: key,
                count: list.length,
                sample_adequacy: sampleAdequacy(list.length),
                confidence: 'low',
                mean: null,
                median: null,
                positive_15m_rate: null,
                avg_return_15m: null,
                avg_MFE: null,
                avg_MAE: null,
                invalid_rate: null,
                avg_quality: null,
            });
            continue;
        }
        const fr15 = list
            .map((r) => r.forward_return_15m)
            .filter((x): x is number => x != null);
        out.push({
            feature: 'combination',
            bucket: key,
            count: list.length,
            sample_adequacy: sampleAdequacy(list.length),
            confidence: confidenceFromSample(list.length),
            mean: null,
            median: null,
            positive_15m_rate: rate(
                fr15.filter((x) => x > 0).length,
                fr15.length,
            ),
            avg_return_15m: avg(fr15),
            avg_MFE: avg(
                list
                    .map((r) => r.mfe_15m)
                    .filter((x): x is number => x != null),
            ),
            avg_MAE: avg(
                list
                    .map((r) => r.mae_15m)
                    .filter((x): x is number => x != null),
            ),
            invalid_rate: rate(
                list.filter((r) => r.invalid_hit).length,
                list.filter((r) => r.invalid_hit != null).length,
            ),
            avg_quality: avg(
                list
                    .map((r) => r.signal_quality_score)
                    .filter((x): x is number => x != null),
            ),
        });
    }
    return out;
}

export function deriveFeatureFindings(
    buckets: BucketAnalysisRow[],
): FeatureFinding | null {
    const usable = buckets.filter(
        (b) =>
            b.sample_adequacy !== 'insufficient' &&
            b.positive_15m_rate != null,
    );
    if (usable.length < 2) {
        return {
            feature: buckets[0]?.feature ?? 'unknown',
            polarity: 'non_informative',
            reason: 'insufficient buckets with sample size',
            confidence: 'low',
        };
    }
    const sorted = [...usable].sort(
        (a, b) => (b.avg_quality ?? 0) - (a.avg_quality ?? 0),
    );
    const best = sorted[0]!;
    const worst = sorted[sorted.length - 1]!;
    const spread =
        (best.positive_15m_rate ?? 50) - (worst.positive_15m_rate ?? 50);

    // Check monotonicity by bucket order if labels sortable by mean
    const byMean = [...usable].sort(
        (a, b) => (a.mean ?? 0) - (b.mean ?? 0),
    );
    let monoUp = 0;
    let monoDown = 0;
    for (let i = 1; i < byMean.length; i++) {
        const prev = byMean[i - 1]!.positive_15m_rate ?? 50;
        const cur = byMean[i]!.positive_15m_rate ?? 50;
        if (cur > prev + 1) monoUp++;
        else if (cur < prev - 1) monoDown++;
    }

    if (Math.abs(spread) < 3) {
        return {
            feature: best.feature,
            polarity: 'non_informative',
            reason: `bucket positive_15m_rate spread ${spread.toFixed(1)}pp near zero`,
            confidence: confidenceFromSample(
                usable.reduce((a, b) => a + b.count, 0),
            ),
            best_bucket: best.bucket,
            worst_bucket: worst.bucket,
        };
    }

    let polarity: FeatureFinding['polarity'] = 'mixed';
    if (monoUp >= byMean.length - 2 && monoDown === 0) polarity = 'positive';
    else if (monoDown >= byMean.length - 2 && monoUp === 0)
        polarity = 'negative';
    else if (spread > 5) polarity = 'positive';
    else if (spread < -5) polarity = 'negative';

    return {
        feature: best.feature,
        polarity,
        reason: `best=${best.bucket} (+15m ${best.positive_15m_rate}%) worst=${worst.bucket} (+15m ${worst.positive_15m_rate}%)`,
        confidence: confidenceFromSample(
            usable.reduce((a, b) => a + b.count, 0),
        ),
        best_bucket: best.bucket,
        worst_bucket: worst.bucket,
    };
}

export interface FeatureAnalysisReport {
    signal_types: SignalTypeLearningStats[];
    rvol: BucketAnalysisRow[];
    vwap_pos: BucketAnalysisRow[];
    heat: BucketAnalysisRow[];
    open_score: BucketAnalysisRow[];
    intraday_score: BucketAnalysisRow[];
    momentum_deciles: BucketAnalysisRow[];
    volume_accel_deciles: BucketAnalysisRow[];
    chase_risk: BucketAnalysisRow[];
    rank_velocity_deciles: BucketAnalysisRow[];
    time_of_day: BucketAnalysisRow[];
    regimes: Array<{ regime: string; stats: SignalTypeLearningStats[] }>;
    combinations: BucketAnalysisRow[];
    findings: FeatureFinding[];
}

export function runFeatureAnalysis(
    rows: LearningDatasetRow[],
    opts?: { signal?: string },
): FeatureAnalysisReport {
    const filtered = opts?.signal
        ? rows.filter((r) => r.signal_type === opts.signal)
        : rows;

    const rvol = analyzeFeatureBuckets(filtered, 'rvol');
    const vwap = analyzeFeatureBuckets(filtered, 'vwap_pos');
    const heat = analyzeFeatureBuckets(filtered, 'heat');
    const openScore = analyzeFeatureBuckets(filtered, 'open_score');
    const intra = analyzeFeatureBuckets(filtered, 'intraday_score');
    const mom = analyzeDeciles(filtered, 'momentum');
    const volA = analyzeDeciles(filtered, 'volume_acceleration');
    const rv = analyzeDeciles(filtered, 'rank_velocity');
    const chase = analyzeChaseRisk(filtered);

    const findings = [
        deriveFeatureFindings(rvol),
        deriveFeatureFindings(vwap),
        deriveFeatureFindings(heat),
        deriveFeatureFindings(openScore),
        deriveFeatureFindings(intra),
        deriveFeatureFindings(mom),
        deriveFeatureFindings(volA),
        deriveFeatureFindings(chase),
        deriveFeatureFindings(rv),
    ].filter((x): x is FeatureFinding => x != null);

    return {
        signal_types: analyzeSignalTypes(filtered),
        rvol,
        vwap_pos: vwap,
        heat,
        open_score: openScore,
        intraday_score: intra,
        momentum_deciles: mom,
        volume_accel_deciles: volA,
        chase_risk: chase,
        rank_velocity_deciles: rv,
        time_of_day: analyzeTimeOfDay(filtered, opts?.signal),
        regimes: analyzeByRegime(filtered),
        combinations: analyzeCombinations(rows),
        findings,
    };
}

export function formatBucketTable(rows: BucketAnalysisRow[]): string {
    const header =
        'Bucket'.padEnd(18) +
        'n'.padStart(6) +
        ' +15m%'.padStart(8) +
        ' avg15'.padStart(8) +
        ' MFE'.padStart(8) +
        ' MAE'.padStart(8) +
        ' inv%'.padStart(7) +
        ' conf'.padStart(8);
    const lines = [header, '-'.repeat(header.length)];
    for (const b of rows) {
        lines.push(
            b.bucket.padEnd(18) +
                String(b.count).padStart(6) +
                String(b.positive_15m_rate ?? '-').padStart(8) +
                String(b.avg_return_15m ?? '-').padStart(8) +
                String(b.avg_MFE ?? '-').padStart(8) +
                String(b.avg_MAE ?? '-').padStart(8) +
                String(b.invalid_rate ?? '-').padStart(7) +
                b.confidence.padStart(8),
        );
    }
    return lines.join('\n');
}
