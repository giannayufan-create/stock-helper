// server/src/lib/ai-interpretation/radar-aggregate.ts
// Deterministic radar aggregate — LLM must never compute these ratios.

import type { AiInterpretationConfig } from './config.ts';
import type {
    InterpretationStatus,
    RadarAggregate,
    RadarStockRowInput,
} from './types.ts';

function emptyStatus(): Record<InterpretationStatus, number> {
    return {
        NOT_READY: 0,
        WATCH: 0,
        CONFIRMED_STRENGTH: 0,
        EXTENDED: 0,
    };
}

function ratio(n: number, d: number): number {
    if (d <= 0) return 0;
    return Math.round((n / d) * 1000) / 1000;
}

function bump(map: Record<string, number>, key: string | null | undefined) {
    const k = (key ?? 'UNKNOWN').trim() || 'UNKNOWN';
    map[k] = (map[k] ?? 0) + 1;
}

export function buildRadarAggregate(
    rows: RadarStockRowInput[],
    cfg: AiInterpretationConfig,
): RadarAggregate {
    const n = rows.length;
    const status_distribution = emptyStatus();
    const sector_distribution: Record<string, number> = {};
    const sector_state_distribution: Record<string, number> = {};
    const context_alignment_distribution: Record<string, number> = {};
    const confidence_distribution: Record<string, number> = {};
    const chase_risk_distribution: Record<string, number> = {};

    let bp_confirmed_count = 0;
    let above_vwap_count = 0;
    let rvol_available_count = 0;
    let event_confirmed_count = 0;
    let data_stale_count = 0;
    let sector_aligned = 0;
    let sector_aligned_denom = 0;
    let market_regime: string | null = null;

    for (const r of rows) {
        const st = r.decision_status ?? 'NOT_READY';
        status_distribution[st] += 1;
        bump(sector_distribution, r.sector);
        bump(sector_state_distribution, r.sector_state);
        bump(context_alignment_distribution, r.context_alignment);
        bump(confidence_distribution, r.confidence);
        bump(chase_risk_distribution, r.chase_risk);

        if (r.bp_score != null && r.bp_score >= cfg.radar_bp_confirmed_min) {
            bp_confirmed_count += 1;
        }
        if (r.vwap_pos_pct != null && r.vwap_pos_pct > cfg.vwap_above_min_pct) {
            above_vwap_count += 1;
        }
        if (r.rvol != null) rvol_available_count += 1;
        if (
            (r.event_state ?? '').toUpperCase().includes('CONFIRMED') ||
            (r.event_state ?? '').toUpperCase().includes('MARKET_CONFIRMED')
        ) {
            event_confirmed_count += 1;
        }
        if (r.data_stale || (r.data_health ?? '').toLowerCase() === 'stale') {
            data_stale_count += 1;
        }
        if (r.sector_state) {
            sector_aligned_denom += 1;
            const ss = r.sector_state.toUpperCase();
            if (ss.includes('ROTATING_IN') || ss === 'HOT') sector_aligned += 1;
        }
        if (r.taiwan_regime) market_regime = r.taiwan_regime;
    }

    const common_strengths: string[] = [];
    const common_missing_confirmations: string[] = [];
    const common_risks: string[] = [];
    const divergences: string[] = [];

    if (n > 0) {
        if (above_vwap_count / n >= 0.5) {
            common_strengths.push(`${above_vwap_count} / ${n} Above VWAP`);
        }
        if (bp_confirmed_count / n >= 0.4) {
            common_strengths.push(
                `${bp_confirmed_count} / ${n} BP >= ${cfg.radar_bp_confirmed_min}`,
            );
        } else {
            common_missing_confirmations.push(
                `僅 ${bp_confirmed_count} / ${n} 檔 Buy Pressure 已確認`,
            );
        }
        if (rvol_available_count / n < 0.5) {
            common_missing_confirmations.push(
                `RVOL coverage ${rvol_available_count}/${n}`,
            );
        }
        if (data_stale_count > 0) {
            common_risks.push(`${data_stale_count} 檔資料 stale`);
        }
        const highChase =
            (chase_risk_distribution['HIGH'] ?? 0) +
            (chase_risk_distribution['EXTREME'] ?? 0) +
            (chase_risk_distribution['high'] ?? 0) +
            (chase_risk_distribution['extreme'] ?? 0);
        if (highChase > 0) {
            common_risks.push(`${highChase} 檔 Chase Risk 偏高`);
        }

        const cHigh = rows.filter(
            (r) => r.c_score != null && r.c_score >= cfg.c_strong_min,
        ).length;
        if (cHigh / n >= 0.5 && bp_confirmed_count / n < 0.35) {
            divergences.push('相對強度高，但即時買盤尚未全面同步。');
        }
        if (
            market_regime &&
            market_regime.toUpperCase().includes('RISK_OFF') &&
            (status_distribution.CONFIRMED_STRENGTH +
                status_distribution.WATCH) /
                n >=
                0.4
        ) {
            divergences.push('個股結構偏強，但整體市場背景並未同步。');
        }
    }

    const notable_sector_concentration: RadarAggregate['notable_sector_concentration'] =
        [];
    for (const [sector, count] of Object.entries(sector_distribution)) {
        if (sector === 'UNKNOWN') continue;
        const r = ratio(count, n);
        if (r >= cfg.radar_sector_concentration_min) {
            let sector_state: string | null = null;
            let max = 0;
            for (const row of rows) {
                if (row.sector !== sector || !row.sector_state) continue;
                const c = sector_state_distribution[row.sector_state] ?? 0;
                if (c >= max) {
                    max = c;
                    sector_state = row.sector_state;
                }
            }
            notable_sector_concentration.push({
                sector,
                count,
                ratio: r,
                sector_state,
            });
        }
    }

    return {
        matched_count: n,
        status_distribution,
        confirmed_strength_ratio: ratio(
            status_distribution.CONFIRMED_STRENGTH,
            n,
        ),
        watch_ratio: ratio(status_distribution.WATCH, n),
        extended_ratio: ratio(status_distribution.EXTENDED, n),
        not_ready_ratio: ratio(status_distribution.NOT_READY, n),
        bp_confirmed_count,
        bp_confirmed_ratio: ratio(bp_confirmed_count, n),
        above_vwap_count,
        above_vwap_ratio: ratio(above_vwap_count, n),
        rvol_available_count,
        rvol_coverage: ratio(rvol_available_count, n),
        sector_distribution,
        sector_state_distribution,
        sector_alignment_ratio: ratio(
            sector_aligned,
            sector_aligned_denom || n,
        ),
        context_alignment_distribution,
        confidence_distribution,
        chase_risk_distribution,
        event_confirmed_count,
        data_stale_count,
        market_regime,
        common_strengths,
        common_missing_confirmations,
        common_risks,
        divergences,
        notable_sector_concentration,
    };
}
