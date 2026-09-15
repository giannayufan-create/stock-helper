// server/src/lib/learning/dataset-builder.ts
// Join StrategySignal + Outcome → LearningDatasetRow (eligible only).

import type { StrategySignal } from '../strategy-signal/types.ts';
import type { SignalOutcome } from '../signal-outcome/types.ts';
import { loadLearningConfig } from './config.ts';
import {
    LEARNING_SCHEMA_VERSION,
    OUTCOME_SCHEMA_VERSION,
    SIGNAL_SCHEMA_VERSION,
    type DatasetBuildReport,
    type LearningDatasetRow,
} from './types.ts';

function num(v: unknown): number | null {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
    if (v == null) return null;
    return String(v);
}

function taipeiDate(iso: string): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(iso));
}

export function computeSignalQualityScore(
    o: Pick<
        SignalOutcome,
        | 'forward_return_15m'
        | 'mfe_15m'
        | 'mae_15m'
        | 'invalid_hit'
        | 'outcome_sequence'
        | 'status'
    >,
): number | null {
    const cfg = loadLearningConfig().quality_score;
    const fr = o.forward_return_15m;
    const mfe = o.mfe_15m;
    const mae = o.mae_15m;
    if (fr == null && mfe == null && mae == null) return null;

    let q = 0;
    if (fr != null) q += fr * cfg.forward_return_15m_weight;
    if (mfe != null) q += mfe * cfg.mfe_15m_weight;
    if (mae != null) q -= Math.abs(Math.min(0, mae)) * cfg.mae_15m_penalty;
    if (o.invalid_hit === true) q -= cfg.invalid_hit_penalty;
    if (
        o.outcome_sequence === 'ambiguous' ||
        o.status === 'ambiguous'
    ) {
        q -= cfg.ambiguous_penalty;
    }
    return Math.round(q * 100) / 100;
}

export interface BuildDatasetResult {
    rows: LearningDatasetRow[];
    report: DatasetBuildReport;
}

export function buildLearningDataset(
    signals: StrategySignal[],
    outcomes: SignalOutcome[],
    opts?: { from?: string; to?: string },
): BuildDatasetResult {
    const cfg = loadLearningConfig();
    const om = new Map(outcomes.map((o) => [o.signal_id, o]));
    const exclusion_reasons: Record<string, number> = {};
    const bump = (k: string) => {
        exclusion_reasons[k] = (exclusion_reasons[k] ?? 0) + 1;
    };

    const rows: LearningDatasetRow[] = [];
    let excluded = 0;

    for (const s of signals) {
        const date = taipeiDate(s.signal_time);
        if (opts?.from && date < opts.from) {
            excluded++;
            bump('date_out_of_range');
            continue;
        }
        if (opts?.to && date > opts.to) {
            excluded++;
            bump('date_out_of_range');
            continue;
        }

        const o = om.get(s.signal_id);
        if (!o) {
            excluded++;
            bump('missing_outcome');
            continue;
        }

        if (
            cfg.dataset.require_learning_eligible &&
            !s.learning_eligible
        ) {
            excluded++;
            bump('not_learning_eligible');
            continue;
        }

        const uni = s.universe_source ?? '';
        if (
            cfg.dataset.exclude_universe_sources.some((x) =>
                uni.toLowerCase().includes(x.toLowerCase()),
            )
        ) {
            excluded++;
            bump('excluded_universe');
            continue;
        }

        if (
            s.score_confidence &&
            cfg.dataset.exclude_score_confidence.includes(s.score_confidence)
        ) {
            excluded++;
            bump('low_score_confidence');
            continue;
        }

        if (
            cfg.dataset.exclude_outcome_status.includes(o.status)
        ) {
            excluded++;
            bump('invalid_outcome');
            continue;
        }

        if (
            cfg.dataset.exclude_replay_quality_invalid &&
            s.metadata?.replay_quality === 'invalid'
        ) {
            excluded++;
            bump('replay_quality_invalid');
            continue;
        }

        const snap = s.feature_snapshot ?? {};
        const quality = computeSignalQualityScore(o);
        const fr15 = o.forward_return_15m ?? null;
        const fr30 = o.forward_return_30m ?? null;
        const mfe15 = o.mfe_15m ?? null;
        const mae15 = o.mae_15m ?? null;

        rows.push({
            signal_id: s.signal_id,
            date,
            symbol: s.symbol,
            signal_type: s.signal_type,
            signal_time: s.signal_time,
            session_minute: s.session_minute ?? null,
            source_mode: s.source_mode,
            data_resolution: s.data_resolution,
            market_regime: s.market_regime ?? null,
            a_score: num(snap.a_score),
            open_score:
                num(snap.final_open_score) ??
                (s.source === 'B' ? (s.score ?? null) : null),
            intraday_score:
                num(snap.intraday_score) ??
                (s.source === 'C' ? (s.score ?? null) : null),
            heat_score: s.heat_score ?? num(snap.heat_score),
            rvol: num(snap.rvol_same_time) ?? num(snap.rvol),
            vwap_pos: num(snap.vwap_pos) ?? num(snap.vwap_structure),
            momentum: num(snap.momentum) ?? num(snap.momentum_acceleration),
            volume_acceleration: num(snap.volume_acceleration),
            relative_strength: num(snap.relative_strength),
            breakout_score: num(snap.breakout_score),
            pullback_quality: num(snap.pullback_quality),
            rank_velocity: num(snap.rank_velocity),
            chase_risk: str(snap.chase_risk),
            forward_return_5m: o.forward_return_5m ?? null,
            forward_return_15m: fr15,
            forward_return_30m: fr30,
            forward_return_60m: o.forward_return_60m ?? null,
            mfe_15m: mfe15,
            mae_15m: mae15,
            invalid_hit: o.invalid_hit ?? null,
            outcome_sequence: o.outcome_sequence ?? null,
            outcome_status: o.status,
            strategy_version: s.strategy_version,
            config_hash: s.config_hash,
            score_confidence: s.score_confidence ?? null,
            learning_eligible: s.learning_eligible,
            universe_source: s.universe_source ?? null,
            signal_quality_score: quality,
            positive_15m: fr15 == null ? null : fr15 > 0,
            positive_30m: fr30 == null ? null : fr30 > 0,
            mfe_15m_ge_1: mfe15 == null ? null : mfe15 >= 1,
            mfe_15m_ge_2: mfe15 == null ? null : mfe15 >= 2,
            mae_15m_gt_neg1: mae15 == null ? null : mae15 > -1,
            invalid_hit_false:
                o.invalid_hit == null ? null : o.invalid_hit === false,
        });
    }

    const dates = [...new Set(rows.map((r) => r.date))].sort();
    const regime_coverage: Record<string, number> = {};
    const signal_distribution: Record<string, number> = {};
    const source_mode_coverage: Record<string, number> = {};
    for (const r of rows) {
        const reg = r.market_regime ?? 'unknown';
        regime_coverage[reg] = (regime_coverage[reg] ?? 0) + 1;
        signal_distribution[r.signal_type] =
            (signal_distribution[r.signal_type] ?? 0) + 1;
        source_mode_coverage[r.source_mode] =
            (source_mode_coverage[r.source_mode] ?? 0) + 1;
    }

    return {
        rows,
        report: {
            dataset_version: LEARNING_SCHEMA_VERSION,
            signal_schema_version:
                cfg.dataset.signal_schema_version || SIGNAL_SCHEMA_VERSION,
            outcome_schema_version:
                cfg.dataset.outcome_schema_version || OUTCOME_SCHEMA_VERSION,
            eligible_samples: rows.length,
            excluded_samples: excluded,
            exclusion_reasons,
            date_coverage: {
                from: dates[0] ?? null,
                to: dates[dates.length - 1] ?? null,
                days: dates.length,
            },
            regime_coverage,
            signal_distribution,
            source_mode_coverage,
        },
    };
}
