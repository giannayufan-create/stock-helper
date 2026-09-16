// server/src/lib/decision-summary/engine.ts
// Pure Decision Support evaluator — NEVER mutates C / BP / strategy.

import type { DecisionSummaryConfig } from './config.ts';
import {
    DS_VERSION,
    type DecisionConfidence,
    type DecisionContextAlignment,
    type DecisionLayers,
    type DecisionStatus,
    type DecisionSummary,
    type DecisionSummaryInput,
} from './types.ts';

function clampPct(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
}

function isAboveVwap(
    input: DecisionSummaryInput,
    cfg: DecisionSummaryConfig,
): boolean {
    if (input.vwap_pos_pct == null) return false;
    return input.vwap_pos_pct > cfg.vwap_above_min_pct;
}

function hasBpAction(states: string[]): boolean {
    return states.some(
        (s) =>
            s === 'BUY_SURGE' ||
            s === 'ASK_EATING' ||
            s === 'VOLUME_BREAKOUT',
    );
}

function chaseIsExtended(
    chase: string | null | undefined,
    cfg: DecisionSummaryConfig,
): boolean {
    if (!chase) return false;
    return cfg.chase_extended.includes(chase) ||
        cfg.chase_extended.includes(chase.toLowerCase()) ||
        cfg.chase_extended.includes(chase.toUpperCase());
}

function volumeConfirmed(
    input: DecisionSummaryInput,
    cfg: DecisionSummaryConfig,
): boolean {
    const rvolOk =
        input.rvol != null && input.rvol >= cfg.rvol_strong_min;
    const accelOk =
        input.volume_acceleration != null &&
        input.volume_acceleration > cfg.volume_accel_positive_min;
    return rvolOk || accelOk;
}

function rankStrong(
    input: DecisionSummaryInput,
    cfg: DecisionSummaryConfig,
): boolean {
    if (input.rank != null && input.rank <= cfg.rank_strong_max) return true;
    if (
        input.rank_change != null &&
        input.rank_change <= -cfg.rank_improve_min
    ) {
        return true;
    }
    if (input.rank_velocity != null && input.rank_velocity > 0) return true;
    return false;
}

function dataGateFail(
    input: DecisionSummaryInput,
    cfg: DecisionSummaryConfig,
    coverage: number,
): { fail: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const health = (input.data_health ?? '').toLowerCase();
    if (
        input.data_blocked ||
        input.data_stale ||
        health === 'stale' ||
        health === 'disconnected'
    ) {
        reasons.push('Data Health stale');
    }
    if (coverage < cfg.coverage_not_ready_below) {
        reasons.push('核心資料 coverage 過低');
    }
    if (cfg.require_price && (input.last_price == null || input.last_price <= 0)) {
        reasons.push('price unavailable');
    }
    if (
        cfg.require_vwap &&
        (input.vwap == null || input.vwap_pos_pct == null)
    ) {
        reasons.push('VWAP unavailable');
    }
    return { fail: reasons.length > 0, reasons };
}

function computeCoverage(input: DecisionSummaryInput): number {
    const parts: number[] = [];
    if (input.score_coverage_pct != null) parts.push(input.score_coverage_pct);
    if (input.bp_coverage_pct != null) parts.push(input.bp_coverage_pct);
    if (parts.length === 0) {
        let avail = 0;
        let total = 0;
        const flags: Array<boolean> = [
            input.c_score != null,
            input.bp_score != null,
            input.vwap_pos_pct != null,
            input.rvol != null,
            input.volume_acceleration != null,
            input.rank != null,
        ];
        for (const f of flags) {
            total += 1;
            if (f) avail += 1;
        }
        return clampPct((avail / Math.max(1, total)) * 100);
    }
    return clampPct(parts.reduce((a, b) => a + b, 0) / parts.length);
}

function deriveAlignment(
    input: DecisionSummaryInput,
    cfg: DecisionSummaryConfig,
): DecisionContextAlignment {
    if (!input.market_context_available) {
        if (!input.sector_state && !input.taiwan_regime && !input.event_status) {
            return 'INSUFFICIENT_DATA';
        }
    }

    let support = 0;
    let contrary = 0;
    let known = 0;

    const sector = input.sector_state;
    if (
        sector === 'INSUFFICIENT_COVERAGE' ||
        (input.sector_coverage_pct != null &&
            input.sector_coverage_pct < 25)
    ) {
        // sector unknown — don't count
    } else if (sector === 'ROTATING_IN' || sector === 'HOT') {
        known += 1;
        const breadthOk =
            input.sector_breadth == null ||
            input.sector_breadth >= cfg.sector_breadth_strong_min;
        if (breadthOk) support += 1;
        else support += 0.5;
    } else if (sector === 'ROTATING_OUT' || sector === 'COLD') {
        known += 1;
        contrary += 1;
    } else if (sector) {
        known += 0.5;
    }

    const regime = input.taiwan_regime ?? '';
    if (regime === 'RISK_ON_BROAD' || regime === 'RISK_ON_NARROW') {
        known += 1;
        support += 1;
    } else if (regime === 'RISK_OFF_BROAD' || regime === 'RISK_OFF_NARROW') {
        known += 1;
        contrary += 1;
    } else if (regime && regime !== 'UNKNOWN') {
        known += 0.5;
    }

    if (input.event_status === 'EVENT_MARKET_CONFIRMED') {
        known += 0.5;
        support += 0.5;
    } else if (input.event_status === 'EVENT_UNCONFIRMED') {
        known += 0.25;
    }

    if (known < 0.5) return 'INSUFFICIENT_DATA';
    if (support >= 1 && contrary < 0.5) return 'ALIGNED';
    if (contrary >= 1 && support < 0.5) return 'CONTRARY';
    if (support > 0 || contrary > 0) return 'MIXED';
    return 'INSUFFICIENT_DATA';
}

function deriveConfidence(
    input: DecisionSummaryInput,
    coverage: number,
    cfg: DecisionSummaryConfig,
    dataFail: boolean,
): DecisionConfidence {
    if (dataFail) return 'LOW';
    let ctxBonus = 0;
    if (input.market_context_available) ctxBonus += 5;
    if (input.sector_state && input.sector_state !== 'INSUFFICIENT_COVERAGE') {
        ctxBonus += 5;
    }
    if (input.taiwan_regime && input.taiwan_regime !== 'UNKNOWN') {
        ctxBonus += 5;
    }
    const score = clampPct(coverage + ctxBonus * cfg.context_coverage_weight * 4);
    if (score >= cfg.coverage_confidence_high_min) return 'HIGH';
    if (score >= cfg.coverage_confidence_medium_min) return 'MEDIUM';
    return 'LOW';
}

function coreConfirmCandidate(
    input: DecisionSummaryInput,
    cfg: DecisionSummaryConfig,
): boolean {
    const c = input.c_score ?? 0;
    if (c < cfg.c_min_confirmed) return false;
    const bpOk =
        (input.bp_score != null && input.bp_score >= cfg.bp_min_confirmed) ||
        hasBpAction(input.bp_states);
    if (!bpOk) return false;
    if (!isAboveVwap(input, cfg)) return false;
    if (!volumeConfirmed(input, cfg)) return false;
    return true;
}

function watchCandidate(
    input: DecisionSummaryInput,
    cfg: DecisionSummaryConfig,
): boolean {
    const c = input.c_score ?? 0;
    if (c < cfg.c_min_watch) return false;
    return rankStrong(input, cfg) || isAboveVwap(input, cfg);
}

function buildLayers(
    input: DecisionSummaryInput,
    status: DecisionStatus,
): DecisionLayers {
    const stock =
        status === 'CONFIRMED_STRENGTH' ||
        status === 'EXTENDED' ||
        hasBpAction(input.bp_states) ||
        (input.c_score != null && input.c_score >= 80);
    const sector =
        input.sector_state === 'ROTATING_IN' ||
        input.sector_state === 'HOT';
    const market =
        (input.taiwan_regime ?? '').startsWith('RISK_ON') ||
        input.taiwan_regime === 'NEUTRAL';
    const event = input.event_status === 'EVENT_MARKET_CONFIRMED';
    return { stock, sector, market, event };
}

function takeTop(list: string[], n: number): string[] {
    return list.slice(0, n);
}

/**
 * Pure evaluator.
 * @param priorStreak consecutive prior core-confirm evaluations (0 if none)
 */
export function evaluateDecisionSummary(
    input: DecisionSummaryInput,
    cfg: DecisionSummaryConfig,
    priorStreak = 0,
    nowIso = new Date().toISOString(),
): DecisionSummary {
    const coverage = computeCoverage(input);
    const gate = dataGateFail(input, cfg, coverage);
    const alignment = deriveAlignment(input, cfg);
    const confidence = deriveConfidence(input, coverage, cfg, gate.fail);

    const confirmed: string[] = [];
    const missing: string[] = [];
    const risks: string[] = [];
    const next: string[] = [];

    // Corporate action: never trust raw change for decision text.
    if (input.has_ca_today) {
        if (input.adjusted_change_pct != null) {
            confirmed.push(
                `✓ Adjusted Change ${input.adjusted_change_pct.toFixed(2)}%`,
            );
        }
        if (
            input.raw_change_pct != null &&
            input.adjusted_change_pct != null &&
            Math.abs(input.raw_change_pct - input.adjusted_change_pct) > 0.05
        ) {
            risks.push('今日除權息 — 使用 Adjusted，忽略 Raw Change');
        }
    }

    if (input.c_score != null) {
        confirmed.push(`✓ C Score ${Math.round(input.c_score)}`);
    } else {
        missing.push('△ C Score unavailable');
    }

    if (input.rank != null) {
        const prev =
            input.rank_prev != null ? `${input.rank_prev} → ` : '';
        confirmed.push(`✓ Rank ${prev}#${input.rank}`);
    }

    if (input.bp_score != null) {
        const st = input.bp_states.filter((s) =>
            ['BUY_SURGE', 'ASK_EATING', 'VOLUME_BREAKOUT'].includes(s),
        );
        confirmed.push(
            st.length
                ? `✓ BP ${Math.round(input.bp_score)} ${st.join('/')}`
                : `✓ BP ${Math.round(input.bp_score)}`,
        );
        if (input.bp_score < cfg.bp_min_confirmed && !hasBpAction(input.bp_states)) {
            missing.push(`△ BP 尚未達 ${cfg.bp_min_confirmed}`);
            next.push(`觀察 BP 是否突破 ${cfg.bp_min_confirmed}`);
        }
    } else {
        missing.push('△ Buy Pressure unavailable');
        next.push(`觀察 BP 是否突破 ${cfg.bp_min_confirmed}`);
    }

    if (isAboveVwap(input, cfg) && input.vwap_pos_pct != null) {
        confirmed.push(`✓ Above VWAP ${input.vwap_pos_pct.toFixed(2)}%`);
    } else if (input.vwap_pos_pct == null) {
        missing.push('△ VWAP unavailable');
    } else {
        missing.push('△ 尚未站上 VWAP');
        next.push('觀察是否站穩 VWAP 上方');
    }

    if (input.rvol != null && input.rvol >= cfg.rvol_strong_min) {
        confirmed.push(`✓ RVOL ${input.rvol.toFixed(1)}x`);
    } else if (input.rvol == null) {
        missing.push('△ RVOL unavailable');
    } else {
        missing.push('△ RVOL 尚未轉強');
        next.push(`觀察 RVOL 是否達 ${cfg.rvol_strong_min}x`);
    }

    if (
        input.volume_acceleration != null &&
        input.volume_acceleration > cfg.volume_accel_positive_min
    ) {
        confirmed.push('✓ Volume Acceleration positive');
    } else if (input.volume_acceleration == null) {
        missing.push('△ Volume Acceleration unavailable');
        next.push('觀察 Volume Acceleration 是否持續增加');
    } else {
        missing.push('△ Volume Acceleration 尚未轉正');
        next.push('觀察 Volume Acceleration 是否持續增加');
    }

    if (input.sector_state === 'ROTATING_IN' || input.sector_state === 'HOT') {
        confirmed.push(`✓ Sector ${input.sector_state}`);
    } else if (
        !input.sector_state ||
        input.sector_state === 'INSUFFICIENT_COVERAGE'
    ) {
        missing.push('△ Sector context unavailable');
        next.push('觀察 Sector 是否進入 ROTATING_IN');
    } else if (input.sector_state === 'ROTATING_OUT') {
        risks.push('Sector ROTATING_OUT');
    }

    if ((input.taiwan_regime ?? '').startsWith('RISK_ON')) {
        confirmed.push(`✓ Market ${input.taiwan_regime}`);
    } else if (!input.taiwan_regime || input.taiwan_regime === 'UNKNOWN') {
        missing.push('△ Market context unavailable');
    } else if ((input.taiwan_regime ?? '').startsWith('RISK_OFF')) {
        risks.push(`Market ${input.taiwan_regime}（Context CONTRARY 可能）`);
    }

    if (input.event_status === 'EVENT_MARKET_CONFIRMED') {
        confirmed.push('✓ Event MARKET_CONFIRMED');
    } else if (input.event_status === 'EVENT_UNCONFIRMED') {
        // context watch only — not core confirm
        missing.push('△ Event 尚未市場確認');
    }

    if (input.institutional_is_proxy) {
        risks.push('INSTITUTIONAL_RISK_PROXY（PROXY — 非即時外資買賣）');
    } else if (input.institutional_realtime_level === 'PREVIOUS_DAY') {
        // context only — T+1
        confirmed.push('✓ Institutional PREVIOUS_DAY（T+1）');
    }

    if (chaseIsExtended(input.chase_risk, cfg)) {
        risks.push(`Chase Risk ${String(input.chase_risk).toUpperCase()}`);
    }
    if (
        input.vwap_pos_pct != null &&
        input.vwap_pos_pct >= cfg.vwap_extended_pct
    ) {
        risks.push(`VWAP distance ${input.vwap_pos_pct.toFixed(2)}%`);
    }

    let status: DecisionStatus;
    let headline: string;
    let streak = priorStreak;

    if (gate.fail) {
        streak = 0;
        status = 'NOT_READY';
        headline = '資料未就緒，暫不形成決策摘要';
        for (const r of gate.reasons) {
            if (!missing.includes(`△ ${r}`)) missing.unshift(`△ ${r}`);
        }
        next.length = 0;
        next.push('等待 Data Health / coverage / VWAP 恢復');
    } else {
        const coreOk = coreConfirmCandidate(input, cfg);
        streak = coreOk ? priorStreak + 1 : 0;
        const confirmedStrength =
            coreOk && streak >= cfg.confirm_streak_required;

        if (confirmedStrength) {
            const extended =
                chaseIsExtended(input.chase_risk, cfg) ||
                (input.vwap_pos_pct != null &&
                    input.vwap_pos_pct >= cfg.vwap_extended_pct);
            if (extended) {
                status = 'EXTENDED';
                headline = '強勢仍在，但價格已明顯延伸';
            } else {
                status = 'CONFIRMED_STRENGTH';
                headline = '價格結構、買盤與量能同步確認';
            }
        } else if (watchCandidate(input, cfg) || coreOk) {
            status = 'WATCH';
            if (coreOk && streak < cfg.confirm_streak_required) {
                headline = '核心條件剛成立，等待連續確認';
                next.unshift(
                    `需連續 ${cfg.confirm_streak_required} 次 evaluation（目前 ${streak}）`,
                );
            } else if (
                (input.bp_score == null ||
                    input.bp_score < cfg.bp_min_confirmed) &&
                !hasBpAction(input.bp_states)
            ) {
                // 1529-style + general weak BP
                if (input.rvol == null && !volumeConfirmed(input, cfg)) {
                    headline =
                        '相對強度高，但即時買盤與量能尚未確認';
                } else {
                    headline = '相對強度高，等待買盤與量能確認';
                }
            } else if (!volumeConfirmed(input, cfg)) {
                headline = '相對強度高，等待買盤與量能確認';
            } else if (!isAboveVwap(input, cfg)) {
                headline = '相對強度高，等待站上 VWAP';
            } else {
                headline = '相對強度高，等待買盤與量能確認';
            }
        } else {
            status = 'WATCH';
            headline = '條件尚未齊備，持續觀察';
            if ((input.c_score ?? 0) < cfg.c_min_watch) {
                next.unshift(`觀察 C 是否達 ${cfg.c_min_watch}`);
            }
        }
    }

    // Never emit trade advice
    const scrubbedNext = takeTop(
        next.filter((x) => !/建議買|買進|賣出/.test(x)),
        4,
    );

    return {
        symbol: input.symbol,
        name: input.name ?? '',
        status,
        context_alignment: alignment,
        confidence,
        headline,
        confirmed_reasons: takeTop(confirmed, 4),
        missing_confirmations: takeTop(missing, 4),
        risk_flags: takeTop(risks, 4),
        next_confirmations: scrubbedNext,
        data_coverage_pct: Math.round(coverage * 10) / 10,
        updated_at: nowIso,
        layers: buildLayers(input, status),
        confirm_streak: streak,
        version: DS_VERSION,
    };
}

/** Test helper: force streak without service. */
export function evaluateWithStreak(
    input: DecisionSummaryInput,
    cfg: DecisionSummaryConfig,
    streak: number,
): DecisionSummary {
    // priorStreak is count BEFORE this eval; engine adds 1 if coreOk
    return evaluateDecisionSummary(input, cfg, Math.max(0, streak - 1));
}
