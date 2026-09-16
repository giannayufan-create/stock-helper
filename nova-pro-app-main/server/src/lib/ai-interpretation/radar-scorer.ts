// server/src/lib/ai-interpretation/radar-scorer.ts
// Deterministic Radar AI Interpretation Score — NOT average of stock scores.

import {
    type AiInterpretationConfig,
    DEFAULT_AI_INTERPRETATION_CONFIG,
    configHash,
} from './config.ts';
import { buildRadarAggregate } from './radar-aggregate.ts';
import { finalizeScore, scoreBand } from './score-bands.ts';
import {
    AI_INTERPRETATION_VERSION,
    type InterpretationConfidence,
    type RadarAIInterpretation,
    type RadarFilterSnapshot,
    type RadarStockRowInput,
} from './types.ts';

function filterSummary(f: RadarFilterSnapshot): string {
    const parts: string[] = [];
    if (f.tab) parts.push(`Tab=${f.tab}`);
    if (f.sector) parts.push(`Sector=${f.sector}`);
    if (f.min_c != null) parts.push(`minC=${f.min_c}`);
    if (f.min_heat != null) parts.push(`minHeat=${f.min_heat}`);
    if (f.min_bp != null) parts.push(`minBP=${f.min_bp}`);
    if (f.price_max != null) parts.push(`price<${f.price_max}`);
    if (f.price_min != null) parts.push(`price>${f.price_min}`);
    if (f.decision_status) parts.push(`status=${f.decision_status}`);
    if (f.market) parts.push(`market=${f.market}`);
    return parts.length ? parts.join(' · ') : '目前篩選條件';
}

export function scoreRadarInterpretation(
    rows: RadarStockRowInput[],
    filter: RadarFilterSnapshot,
    cfg: AiInterpretationConfig = DEFAULT_AI_INTERPRETATION_CONFIG,
    opts?: { snapshot_id?: string; snapshot_at?: string },
): RadarAIInterpretation {
    const aggregate = buildRadarAggregate(rows, cfg);
    const n = aggregate.matched_count;

    let raw = 3.5;
    if (n === 0) {
        raw = 2.0;
    } else {
        raw += aggregate.confirmed_strength_ratio * 3.2;
        raw += aggregate.watch_ratio * 1.2;
        raw += aggregate.bp_confirmed_ratio * 2.0;
        raw += aggregate.above_vwap_ratio * 1.2;
        raw += Math.min(1.0, aggregate.rvol_coverage) * 0.6;
        raw += aggregate.sector_alignment_ratio * 1.0;

        const regime = (aggregate.market_regime ?? '').toUpperCase();
        if (regime.includes('RISK_ON')) raw += 0.8;
        else if (regime.includes('RISK_OFF')) raw -= 1.2;

        raw -= aggregate.extended_ratio * 0.4;
        raw -= aggregate.not_ready_ratio * 1.5;
        raw -= (aggregate.data_stale_count / Math.max(1, n)) * 1.5;

        if (aggregate.divergences.length) {
            raw -= 0.8 * Math.min(2, aggregate.divergences.length);
        }

        // Single-hero cannot dominate: if only one CONFIRMED and rest weak
        if (
            aggregate.status_distribution.CONFIRMED_STRENGTH <= 1 &&
            n >= 5 &&
            aggregate.confirmed_strength_ratio < 0.25
        ) {
            raw = Math.min(raw, 6.2);
        }
    }

    if (aggregate.data_stale_count / Math.max(1, n) >= 0.5) {
        raw = Math.min(raw, cfg.stale_score_cap);
    }

    const score = finalizeScore(raw);

    let confidence: InterpretationConfidence = 'MEDIUM';
    const staleRatio = aggregate.data_stale_count / Math.max(1, n);
    if (staleRatio >= 0.4 || aggregate.rvol_coverage < 0.3) confidence = 'LOW';
    else if (
        aggregate.rvol_coverage >= 0.6 &&
        staleRatio < 0.1 &&
        n >= 3
    ) {
        confidence = 'HIGH';
    }

    let headline = '目前雷達同步程度中等。';
    if (n === 0) {
        headline = '目前篩選無符合標的。';
    } else if (aggregate.divergences.some((d) => d.includes('買盤'))) {
        headline =
            '目前雷達相對強度偏高，但買盤確認尚未全面完成。';
    } else if (aggregate.divergences.some((d) => d.includes('市場背景'))) {
        headline = '個股結構偏強，但整體市場背景並未同步。';
    } else if (score >= 8) {
        headline = '目前雷達整體同步度偏高，個股、產業與市場較一致。';
    } else if (score >= 6.5) {
        headline =
            '目前雷達整體同步度偏高，但買盤確認尚未全面完成。';
    } else if (score >= 5) {
        headline = '目前這批股票條件部分成立，仍以觀察為主。';
    } else {
        headline = '目前雷達訊號零散，同步程度有限。';
    }

    const snapAt = opts?.snapshot_at ?? new Date().toISOString();
    const snapshot_id =
        opts?.snapshot_id ??
        `radar_${snapAt.replace(/[:.]/g, '')}_${n}`;

    const sectorBits = aggregate.notable_sector_concentration
        .map(
            (x) =>
                `${x.sector} ${x.count}檔 (${Math.round(x.ratio * 100)}%)${x.sector_state ? ` ${x.sector_state}` : ''}`,
        )
        .join('；');

    const sector_summary = sectorBits
        ? `目前雷達具有明顯產業集中：${sectorBits}（產業集中不自動視為利多）。`
        : Object.keys(aggregate.sector_distribution).length
          ? `產業分散於 ${Object.keys(aggregate.sector_distribution).join('、')}。`
          : '產業資訊不足。';

    const market_summary = aggregate.market_regime
        ? `Taiwan Market Regime = ${aggregate.market_regime}`
        : '市場背景資訊不足';

    const dist = aggregate.status_distribution;
    const group_structure = `Confirmed ${dist.CONFIRMED_STRENGTH} · Watch ${dist.WATCH} · Extended ${dist.EXTENDED} · Not Ready ${dist.NOT_READY}`;

    return {
        snapshot_id,
        score,
        score_band: scoreBand(score),
        confidence,
        matched_count: n,
        filter_summary: filterSummary(filter),
        headline,
        market_summary,
        sector_summary,
        group_structure,
        common_strengths: aggregate.common_strengths,
        missing_confirmations: aggregate.common_missing_confirmations,
        divergence_flags: aggregate.divergences,
        risk_flags: aggregate.common_risks,
        notable_groups: aggregate.notable_sector_concentration.map(
            (x) => `${x.sector}×${x.count}`,
        ),
        data_quality_summary:
            confidence === 'LOW'
                ? '資料品質偏弱，雷達解讀可信度偏低。'
                : `RVOL coverage ${aggregate.rvol_available_count}/${n} · stale ${aggregate.data_stale_count}`,
        aggregate,
        interpretation_score_version: AI_INTERPRETATION_VERSION,
        config_hash: configHash(cfg),
        snapshot_at: snapAt,
        generated_at: new Date().toISOString(),
        mutates_strategy: false,
        research_persistence: 'NOT_ENABLED',
    };
}
