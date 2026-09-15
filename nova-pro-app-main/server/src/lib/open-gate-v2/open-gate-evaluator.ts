// server/src/lib/open-gate-v2/open-gate-evaluator.ts
// Final Patch: hysteresis, dual TTL, data_blocked, 09:30 B/C boundary.

import type { OpenGateConfig } from './config.ts';
import type { DataHealthReport } from './data-health.ts';
import { runLiquidityGate } from './liquidity-gate.ts';
import type { MarketRegimeResult } from './market-regime.ts';
import { runMomentumEngine } from './momentum-engine.ts';
import { runRiskGate } from './risk-gate.ts';
import type {
    ACandidate,
    OpenConfirmResult,
    OpenConfirmStatus,
    OpenPhase,
    ScoreComponents,
    SignalMaturity,
    SymbolMarketState,
    VwapSource,
} from './types.ts';

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

function taipeiParts(now = new Date()): {
    mins: number;
    weekday: number;
    ymd: string;
} {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
        hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const dayMap: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
    };
    return {
        mins: Number(get('hour')) * 60 + Number(get('minute')),
        weekday: dayMap[get('weekday')] ?? 0,
        ymd: `${get('year')}-${get('month')}-${get('day')}`,
    };
}

export function resolvePhase(
    cfg: OpenGateConfig,
    now = new Date(),
): { phase: OpenPhase; sessionMinutes: number } {
    const { mins, weekday } = taipeiParts(now);
    if (weekday === 0 || weekday === 6) {
        return { phase: 'after', sessionMinutes: 0 };
    }
    const open = 9 * 60;
    if (mins < open) return { phase: 'after', sessionMinutes: 0 };
    const sessionMinutes = mins - open;
    if (sessionMinutes < cfg.phase.provisional_end_min) {
        return { phase: 'provisional', sessionMinutes };
    }
    if (sessionMinutes < cfg.phase.early_end_min) {
        return { phase: 'early', sessionMinutes };
    }
    if (sessionMinutes < cfg.phase.confirmed_end_min) {
        return { phase: 'confirmed', sessionMinutes };
    }
    return { phase: 'after', sessionMinutes };
}

function scoreRvol(
    rvol: number | null,
    cfg: OpenGateConfig,
): { score: number; available: boolean } {
    if (rvol == null) return { score: 0, available: false };
    const t = cfg.rvol_thresholds;
    if (rvol >= t.excellent) return { score: 100, available: true };
    if (rvol >= t.good) return { score: 85, available: true };
    if (rvol >= t.ok) return { score: 70, available: true };
    if (rvol >= t.weak) return { score: 45, available: true };
    return { score: 20, available: true };
}

function scoreVwapPos(
    pct: number | null,
    cfg: OpenGateConfig,
): { score: number; available: boolean } {
    if (pct == null) return { score: 0, available: false };
    const t = cfg.vwap_thresholds;
    if (pct >= t.strong_above) return { score: 90, available: true };
    if (pct >= t.above) return { score: 78, available: true };
    if (pct >= t.soft_below) return { score: 55, available: true };
    if (pct >= t.hard_below) return { score: 30, available: true };
    return { score: 10, available: true };
}

function scoreOpenHold(
    pct: number | null,
    cfg: OpenGateConfig,
): { score: number; available: boolean } {
    if (pct == null) return { score: 0, available: false };
    const t = cfg.open_hold_thresholds;
    if (pct >= t.strong_above) return { score: 95, available: true };
    if (pct >= t.above) return { score: 80, available: true };
    if (pct >= t.soft_below) return { score: 50, available: true };
    if (pct >= t.hard_below) return { score: 25, available: true };
    return { score: 8, available: true };
}

function scorePullback(
    pct: number | null,
    cfg: OpenGateConfig,
): { score: number; available: boolean } {
    if (pct == null) return { score: 0, available: false };
    const t = cfg.pullback_thresholds;
    if (pct <= t.ideal_max) return { score: 95, available: true };
    if (pct <= t.ok_max) return { score: 75, available: true };
    if (pct <= t.weak_max) return { score: 45, available: true };
    return { score: 15, available: true };
}

function scoreGap(gap: number, cfg: OpenGateConfig): number {
    const t = cfg.gap_thresholds;
    if (gap >= t.ideal_low && gap <= t.ideal_high) {
        return clamp(100 - Math.abs(gap - 2) * 10, 70, 100);
    }
    if (gap > t.ideal_high && gap <= t.hot) return 55;
    if (gap > t.hot) return 25;
    if (gap >= t.cold) return 40;
    return 20;
}

type FeatureAvailKey =
    | 'rvol'
    | 'vwap'
    | 'open_hold'
    | 'pullback'
    | 'momentum'
    | 'gap';

function weightedRaw(
    comps: ScoreComponents,
    cfg: OpenGateConfig,
    available: Record<FeatureAvailKey, boolean>,
): { raw: number; coverage_pct: number } {
    const w = cfg.score_weights;
    const parts: Array<{ key: FeatureAvailKey; w: number; s: number }> = [
        { key: 'rvol', w: w.rvol, s: comps.rvol_score },
        { key: 'vwap', w: w.vwap, s: comps.vwap_score },
        { key: 'open_hold', w: w.open_hold, s: comps.open_hold_score },
        { key: 'pullback', w: w.pullback, s: comps.pullback_score },
        { key: 'momentum', w: w.momentum, s: comps.momentum_score },
        { key: 'gap', w: w.gap, s: comps.gap_score },
    ];
    const avail = parts.filter((p) => available[p.key]);
    const wSum = avail.reduce((a, p) => a + p.w, 0) || 1;
    const raw = avail.reduce((a, p) => a + (p.w / wSum) * p.s, 0);
    const totalW = parts.reduce((a, p) => a + p.w, 0) || 1;
    const coverage_pct = Math.round(
        (avail.reduce((a, p) => a + p.w, 0) / totalW) * 100,
    );
    return { raw: clamp(raw, 0, 100), coverage_pct };
}

function newEvalId(symbol: string, now: Date): string {
    const t = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    return `ev_${t}_${symbol}`;
}

function newSignalId(symbol: string, now: Date): string {
    const t = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    return `sig_${t}_${symbol}`;
}

function maturityFrom(
    status: OpenConfirmStatus,
    passStreak: number,
    prev: OpenConfirmResult | null | undefined,
): SignalMaturity {
    if (status === 'pass' || status === 'early_pass') {
        if (passStreak >= 10) return 'stable';
        if (passStreak >= 3) return 'forming';
        return 'new';
    }
    if (
        prev &&
        (prev.open_confirm === 'pass' || prev.open_confirm === 'early_pass')
    ) {
        return 'weakening';
    }
    return 'new';
}

/**
 * Apply hysteresis + confirmation counts on top of a raw desired status.
 */
function applyHysteresis(opts: {
    cfg: OpenGateConfig;
    phase: OpenPhase;
    score: number;
    hard_reject: boolean;
    soft_reject: boolean;
    data_blocked: boolean;
    force_watch: boolean;
    allowsNewPass: boolean;
    immediateDowngrade: boolean;
    previous: OpenConfirmResult | null | undefined;
}): {
    open_confirm: OpenConfirmStatus;
    confirmation_count: number;
    pass_streak: number;
    watch_streak: number;
    reject_streak: number;
} {
    const {
        cfg,
        phase,
        score,
        hard_reject,
        soft_reject,
        data_blocked,
        force_watch,
        allowsNewPass,
        immediateDowngrade,
        previous,
    } = opts;

    const prevStatus = previous?.open_confirm ?? null;
    let pass_streak = previous?.pass_streak ?? 0;
    let watch_streak = previous?.watch_streak ?? 0;
    let reject_streak = previous?.reject_streak ?? 0;
    let confirmation_count = previous?.confirmation_count ?? 0;

    if (phase === 'provisional') {
        return {
            open_confirm: 'provisional',
            confirmation_count: 0,
            pass_streak: 0,
            watch_streak: 0,
            reject_streak: 0,
        };
    }

    if (hard_reject) {
        return {
            open_confirm: 'reject',
            confirmation_count: 0,
            pass_streak: 0,
            watch_streak: 0,
            reject_streak: reject_streak + 1,
        };
    }

    // Desired band from score (hysteresis-aware intent)
    const wantPass =
        !soft_reject &&
        !force_watch &&
        !data_blocked &&
        allowsNewPass &&
        score >= cfg.pass_enter_threshold;

    const stayPass =
        (prevStatus === 'pass' || prevStatus === 'early_pass') &&
        score > cfg.pass_exit_threshold &&
        !immediateDowngrade &&
        !hard_reject &&
        !data_blocked;

    const wantWatch =
        score >= cfg.watch_enter_threshold ||
        force_watch ||
        soft_reject ||
        data_blocked;

    const leaveReject =
        prevStatus === 'reject' && score >= cfg.reject_exit_threshold;

    let open_confirm: OpenConfirmStatus = 'watch';

    if (prevStatus === 'pass' || prevStatus === 'early_pass') {
        if (immediateDowngrade || score <= cfg.pass_exit_threshold) {
            // need 2 consecutive exits unless immediate
            const exitCount =
                (previous?.open_confirm === 'pass' ||
                previous?.open_confirm === 'early_pass') &&
                (previous.final_open_score ?? 100) <= cfg.pass_exit_threshold
                    ? (previous.watch_streak || 0) + 1
                    : immediateDowngrade
                      ? cfg.min_confirm_evaluations
                      : 1;
            // track with confirmation_count inverted for exit
            if (immediateDowngrade || exitCount >= cfg.min_confirm_evaluations) {
                open_confirm =
                    score < cfg.watch_enter_threshold ? 'reject' : 'watch';
                confirmation_count = 0;
                pass_streak = 0;
            } else {
                open_confirm = prevStatus;
                confirmation_count = exitCount;
                pass_streak = previous?.pass_streak ?? 0;
            }
        } else if (stayPass) {
            open_confirm = prevStatus;
            pass_streak = (previous?.pass_streak ?? 0) + 1;
            confirmation_count = cfg.min_confirm_evaluations;
        } else {
            open_confirm = 'watch';
            confirmation_count = 0;
            pass_streak = 0;
        }
    } else if (wantPass) {
        const nextCount =
            previous &&
            previous.final_open_score >= cfg.pass_enter_threshold &&
            !previous.soft_reject &&
            !previous.data_blocked
                ? (previous.confirmation_count || 0) + 1
                : 1;
        confirmation_count = nextCount;
        if (nextCount >= cfg.min_confirm_evaluations) {
            open_confirm = phase === 'early' ? 'early_pass' : 'pass';
            pass_streak = 1;
        } else {
            open_confirm = 'watch';
            pass_streak = 0;
        }
    } else if (prevStatus === 'reject' && !leaveReject && !wantWatch) {
        open_confirm = 'reject';
        reject_streak = reject_streak + 1;
        confirmation_count = 0;
        pass_streak = 0;
    } else if (wantWatch || leaveReject) {
        open_confirm = 'watch';
        confirmation_count = 0;
        pass_streak = 0;
        watch_streak = (watch_streak || 0) + 1;
        reject_streak = 0;
    } else {
        open_confirm = 'reject';
        reject_streak = reject_streak + 1;
        confirmation_count = 0;
        pass_streak = 0;
        watch_streak = 0;
    }

    // Hard reject never auto-recovers to pass same session if previous hard
    if (previous?.hard_reject && hard_reject) {
        open_confirm = 'reject';
    } else if (
        previous?.hard_reject &&
        (open_confirm === 'pass' || open_confirm === 'early_pass')
    ) {
        open_confirm = 'watch';
        confirmation_count = 0;
    }

    // data_blocked: never produce NEW pass; keep last soft state demoted
    if (
        data_blocked &&
        (open_confirm === 'pass' || open_confirm === 'early_pass')
    ) {
        open_confirm = 'watch';
        confirmation_count = 0;
        pass_streak = 0;
    }

    // streak bookkeeping
    if (open_confirm === 'pass' || open_confirm === 'early_pass') {
        watch_streak = 0;
        reject_streak = 0;
        if (prevStatus !== 'pass' && prevStatus !== 'early_pass') {
            pass_streak = Math.max(pass_streak, 1);
        }
    } else if (open_confirm === 'watch') {
        pass_streak = 0;
        reject_streak = 0;
        watch_streak =
            prevStatus === 'watch' ? (previous?.watch_streak ?? 0) + 1 : 1;
    } else if (open_confirm === 'reject') {
        pass_streak = 0;
        watch_streak = 0;
        reject_streak =
            prevStatus === 'reject' ? (previous?.reject_streak ?? 0) + 1 : 1;
    }

    return {
        open_confirm,
        confirmation_count,
        pass_streak,
        watch_streak,
        reject_streak,
    };
}

export function evaluateOpenGate(opts: {
    cfg: OpenGateConfig;
    candidate: ACandidate;
    state: SymbolMarketState | undefined;
    vwapInfo: {
        vwap: number | null;
        source: VwapSource;
        valid: boolean;
        available?: boolean;
        confidence?: string;
    };
    rvolSameTime: number | null;
    regime: MarketRegimeResult;
    health: DataHealthReport;
    previous?: OpenConfirmResult | null;
    now?: Date;
}): OpenConfirmResult {
    const now = opts.now ?? new Date();
    const { cfg, candidate, state, regime, health } = opts;
    const { phase, sessionMinutes } = resolvePhase(cfg, now);
    const reasons: string[] = [];
    const risks: string[] = [];

    const last = state?.last_price ?? 0;
    const open = state?.open ?? 0;
    const high = state?.high ?? 0;
    const prevPx =
        state?.prev_close && state.prev_close > 0
            ? state.prev_close
            : candidate.prev_close && candidate.prev_close > 0
              ? candidate.prev_close
              : open || last;

    const gap_pct =
        prevPx > 0 && open > 0 ? ((open - prevPx) / prevPx) * 100 : 0;
    const day_chg_pct =
        prevPx > 0 && last > 0 ? ((last - prevPx) / prevPx) * 100 : 0;

    const vwap = opts.vwapInfo.vwap;
    const vwap_available =
        (opts.vwapInfo as { available?: boolean }).available ??
        (opts.vwapInfo.valid && vwap != null && vwap > 0);
    const vwap_confidence =
        (opts.vwapInfo as { confidence?: string }).confidence ??
        (opts.vwapInfo.valid ? 'high' : vwap_available ? 'degraded' : 'none');
    const vwap_valid = Boolean(vwap_available && vwap != null && vwap > 0);
    const vwap_pos_pct =
        vwap_valid && vwap != null && last > 0
            ? ((last - vwap) / vwap) * 100
            : null;
    const open_pos_pct =
        open > 0 && last > 0 ? ((last - open) / open) * 100 : null;
    const high_pullback_pct =
        high > 0 && last > 0 ? ((high - last) / high) * 100 : null;

    if (!vwap_valid) {
        risks.push('VWAP 不可靠（未假裝正常）');
    }

    const mom = runMomentumEngine(state);
    const liq = runLiquidityGate({
        cfg,
        candidate,
        state,
        sessionMinutes,
        rvolSameTime: opts.rvolSameTime,
    });
    const risk = runRiskGate({
        cfg,
        state,
        vwap: vwap_valid ? vwap : null,
        gap_pct,
        day_chg_pct,
        vwap_pos_pct,
        open_pos_pct,
        high_pullback_pct,
    });

    const rvolFeat = scoreRvol(opts.rvolSameTime, cfg);
    const vwapFeat = vwap_valid
        ? scoreVwapPos(vwap_pos_pct, cfg)
        : { score: 0, available: false };
    const openHoldFeat = scoreOpenHold(open_pos_pct, cfg);
    const pullbackFeat = scorePullback(high_pullback_pct, cfg);
    const momAvailable = mom.available && mom.momentum_score != null;
    const gapAvailable = open > 0 && prevPx > 0;

    const feature_availability: Record<string, boolean> = {
        rvol: rvolFeat.available,
        vwap: vwapFeat.available,
        open_hold: openHoldFeat.available,
        pullback: pullbackFeat.available,
        momentum: momAvailable,
        gap: gapAvailable,
    };

    const comps: ScoreComponents = {
        rvol_score: rvolFeat.score,
        vwap_score: vwapFeat.score,
        open_hold_score: openHoldFeat.score,
        pullback_score: pullbackFeat.score,
        momentum_score: mom.momentum_score ?? 0,
        gap_score: gapAvailable ? scoreGap(gap_pct, cfg) : 0,
    };

    const weighted = weightedRaw(comps, cfg, {
        rvol: rvolFeat.available,
        vwap: vwapFeat.available,
        open_hold: openHoldFeat.available,
        pullback: pullbackFeat.available,
        momentum: momAvailable,
        gap: gapAvailable,
    });
    const score_coverage_pct = weighted.coverage_pct;
    const score_confidence: 'high' | 'medium' | 'low' =
        score_coverage_pct >= 90
            ? 'high'
            : score_coverage_pct >= 70
              ? 'medium'
              : 'low';

    const raw_open_score = Math.round(weighted.raw);
    let final_open_score = Math.round(
        clamp(
            raw_open_score +
                regime.market_adjustment +
                liq.liquidity_adjustment +
                risk.risk_adjustment,
            0,
            100,
        ),
    );

    if (opts.rvolSameTime != null) {
        reasons.push(`Same-time RVOL ${opts.rvolSameTime.toFixed(2)}x`);
    } else {
        risks.push('Same-time RVOL 不可用');
    }
    if (vwap_pos_pct != null && vwap_pos_pct >= 0) reasons.push('股價站上VWAP');
    else if (vwap_pos_pct != null) risks.push('暫時跌破 VWAP');
    if (open_pos_pct != null && open_pos_pct >= 0) reasons.push('守住開盤價');
    else if (open_pos_pct != null) risks.push('失守開盤價');
    if (
        high_pullback_pct != null &&
        high_pullback_pct <= cfg.pullback_thresholds.ok_max
    ) {
        reasons.push('高點回撤小');
    }
    reasons.push(...mom.notes.filter((x) => !x.includes('不足')));
    reasons.push(...liq.reasons, ...risk.reasons);
    risks.push(...liq.risks, ...risk.risks);
    if (health.data_blocked) {
        risks.push(`DATA ${health.health.toUpperCase()} — 禁止新 PASS`);
    }
    if (!momAvailable) risks.push('momentum 不可用');

    const hard_reject =
        liq.hard_reject ||
        (cfg.hard_reject.disposition && candidate.disposition_status);

    let soft_reject = liq.soft_reject;
    if (
        vwap_pos_pct != null &&
        vwap_pos_pct < cfg.vwap_thresholds.soft_below
    ) {
        soft_reject = true;
    }
    if (
        opts.rvolSameTime != null &&
        opts.rvolSameTime < cfg.rvol_thresholds.ok
    ) {
        soft_reject = true;
    }
    if (momAvailable && (mom.momentum_score ?? 0) < 40) soft_reject = true;

    const immediateDowngrade =
        (risk.invalid_price != null &&
            last > 0 &&
            last < risk.invalid_price) ||
        health.data_blocked;

    if (immediateDowngrade && risk.invalid_price != null && last < risk.invalid_price) {
        risks.push('價格跌破 invalid_price — 立即降級');
    }

    const allowsNewPass =
        phase !== 'after' &&
        !health.data_blocked &&
        (health.health === 'healthy' || health.health === 'degraded') &&
        !(
            cfg.data_health.require_profile_for_pass &&
            !health.historical_profile_available
        );

    const hyst = applyHysteresis({
        cfg,
        phase,
        score: final_open_score,
        hard_reject,
        soft_reject,
        data_blocked: health.data_blocked,
        force_watch: risk.force_watch,
        allowsNewPass,
        immediateDowngrade,
        previous: opts.previous,
    });

    let open_confirm = hyst.open_confirm;

    // Patch §8: after cutoff — no NEW tradeable PASS from B
    const passedBefore =
        Boolean(opts.previous?.open_gate_passed_before_cutoff) ||
        ((opts.previous?.open_confirm === 'pass' ||
            opts.previous?.open_confirm === 'early_pass') &&
            (opts.previous.phase === 'confirmed' ||
                opts.previous.phase === 'early'));

    let open_gate_passed_before_cutoff = passedBefore;
    let late_candidate = Boolean(opts.previous?.late_candidate);
    let open_gate_baseline = opts.previous?.open_gate_baseline ?? null;
    let open_gate_final_score =
        opts.previous?.open_gate_final_score ?? null;
    let current_open_metrics: OpenConfirmResult['current_open_metrics'];

    const liveMetrics = {
        gap_pct: Math.round(gap_pct * 100) / 100,
        rvol_same_time: opts.rvolSameTime,
        vwap: vwap_valid ? vwap : vwap,
        vwap_pos_pct:
            vwap_pos_pct != null
                ? Math.round(vwap_pos_pct * 100) / 100
                : null,
        vwap_source: opts.vwapInfo.source,
        vwap_valid,
        vwap_available,
        vwap_confidence,
        open_pos_pct:
            open_pos_pct != null
                ? Math.round(open_pos_pct * 100) / 100
                : null,
        high_pullback_pct:
            high_pullback_pct != null
                ? Math.round(high_pullback_pct * 100) / 100
                : null,
        momentum_score: mom.momentum_score ?? 0,
        spread_pct: liq.spread_pct,
    };

    if (phase === 'confirmed' && open_confirm === 'pass') {
        open_gate_passed_before_cutoff = true;
        if (open_gate_baseline == null) {
            open_gate_baseline = final_open_score;
        }
        open_gate_final_score = final_open_score;
    }

    if (phase === 'after') {
        // Freeze final score from baseline / prior freeze; keep live metrics updating
        open_gate_final_score =
            opts.previous?.open_gate_final_score ??
            opts.previous?.open_gate_baseline ??
            open_gate_final_score;
        if (open_gate_final_score != null) {
            final_open_score = open_gate_final_score;
        }
        current_open_metrics = {
            ...liveMetrics,
            live_final_open_score: Math.round(
                clamp(
                    raw_open_score +
                        regime.market_adjustment +
                        liq.liquidity_adjustment +
                        risk.risk_adjustment,
                    0,
                    100,
                ),
            ),
        };

        // Never mint new OPEN_PASS / tradeable after cutoff
        if (
            (open_confirm === 'pass' || open_confirm === 'early_pass') &&
            !open_gate_passed_before_cutoff
        ) {
            open_confirm = 'watch';
            late_candidate = true;
            risks.push('09:30後新轉強 — 交由 C，B 不給正式 PASS');
        } else if (
            (open_confirm === 'pass' || open_confirm === 'early_pass') &&
            open_gate_passed_before_cutoff
        ) {
            // research status may linger; tradeable forced false below
            reasons.push('cutoff 前已 PASS — 保留 open_gate_final_score');
            if (
                !cfg.cutoff.allow_new_tradeable_after_cutoff &&
                opts.previous?.open_confirm !== 'pass' &&
                opts.previous?.open_confirm !== 'early_pass'
            ) {
                // strengthen: do not re-enter pass after leaving it post-cutoff
                open_confirm = 'watch';
            }
        } else if (
            open_confirm === 'pass' ||
            open_confirm === 'early_pass'
        ) {
            open_confirm = 'watch';
            late_candidate = true;
        }
    } else if (
        open_confirm === 'pass' ||
        open_confirm === 'early_pass'
    ) {
        open_gate_final_score = final_open_score;
    }

    // signal_id lifecycle
    let signal_id = opts.previous?.signal_id ?? null;
    const wasPass =
        opts.previous?.open_confirm === 'pass' ||
        opts.previous?.open_confirm === 'early_pass';
    const isPass = open_confirm === 'pass' || open_confirm === 'early_pass';
    if (isPass && !wasPass) {
        signal_id = newSignalId(candidate.symbol, now);
    } else if (!isPass && wasPass) {
        // keep signal_id for outcome join until new pass
    }

    const generated_at = now.toISOString();
    const fresh_until = new Date(
        now.getTime() + cfg.fresh_ttl_sec * 1000,
    ).toISOString();

    // extend signal_valid_until while still PASS
    let signal_valid_until: string;
    if (isPass) {
        signal_valid_until = new Date(
            now.getTime() + cfg.signal_ttl_sec * 1000,
        ).toISOString();
    } else if (opts.previous?.signal_valid_until && wasPass) {
        signal_valid_until = opts.previous.signal_valid_until;
    } else {
        signal_valid_until = new Date(
            now.getTime() + cfg.signal_ttl_sec * 1000,
        ).toISOString();
    }

    const signal_expired =
        !isPass &&
        Boolean(opts.previous?.signal_valid_until) &&
        new Date(opts.previous!.signal_valid_until).getTime() < now.getTime();

    const evaluation_stale = false; // set by service if eval cadence missed

    const status_since =
        opts.previous && opts.previous.open_confirm === open_confirm
            ? opts.previous.status_since
            : generated_at;

    let first_pass_at = opts.previous?.first_pass_at ?? null;
    let last_pass_at = opts.previous?.last_pass_at ?? null;
    if (isPass) {
        if (!first_pass_at) first_pass_at = generated_at;
        last_pass_at = generated_at;
    }

    const tradeable_candidate =
        phase === 'confirmed' &&
        open_confirm === 'pass' &&
        health.health === 'healthy' &&
        !health.data_blocked &&
        !hard_reject &&
        !signal_expired &&
        hyst.confirmation_count >= cfg.min_confirm_evaluations &&
        open_gate_passed_before_cutoff;

    if (opts.previous?.open_confirm !== open_confirm) {
        if (
            opts.previous &&
            (opts.previous.open_confirm === 'pass' ||
                opts.previous.open_confirm === 'early_pass') &&
            (open_confirm === 'watch' || open_confirm === 'reject')
        ) {
            risks.push(
                `狀態降級 ${opts.previous.open_confirm} → ${open_confirm}`,
            );
        }
        if (
            opts.previous &&
            (opts.previous.open_confirm === 'reject' ||
                opts.previous.open_confirm === 'watch') &&
            isPass
        ) {
            reasons.push(
                `狀態升級 ${opts.previous.open_confirm} → ${open_confirm}`,
            );
        }
    }

    return {
        symbol: candidate.symbol,
        name: candidate.name,
        timestamp: generated_at,
        a_score: candidate.a_score,
        a_score_source: candidate.a_score_source,
        phase,
        tradeable: tradeable_candidate,
        tradeable_candidate,
        raw_open_score,
        market_adjustment: regime.market_adjustment,
        liquidity_adjustment: liq.liquidity_adjustment,
        risk_adjustment: risk.risk_adjustment,
        final_open_score,
        open_confirm,
        hard_reject,
        soft_reject,
        data_blocked: health.data_blocked,
        market_regime: regime.market_regime,
        market_score: regime.market_score,
        score_components: comps,
        metrics: liveMetrics,
        current_open_metrics,
        risk: {
            chase_risk: risk.chase_risk,
            invalid_price: risk.invalid_price,
            invalid_reason: risk.invalid_reason,
            risk_pct: risk.risk_pct,
            risk_distance_pct: risk.risk_distance_pct,
            risk_score: risk.risk_score,
            risk_adjustment: risk.risk_adjustment,
        },
        liquidity_score: liq.liquidity_score,
        reasons: [...new Set(reasons)].slice(0, 12),
        risks: [...new Set(risks)].slice(0, 12),
        data_health: health.health,
        signal_status: signal_expired
            ? 'expired'
            : isPass
              ? 'active'
              : 'active',
        evaluation_stale,
        signal_expired,
        confirmation_count: hyst.confirmation_count,
        pass_streak: hyst.pass_streak,
        watch_streak: hyst.watch_streak,
        reject_streak: hyst.reject_streak,
        status_since,
        first_pass_at,
        last_pass_at,
        signal_maturity: maturityFrom(
            open_confirm,
            hyst.pass_streak,
            opts.previous,
        ),
        open_gate_passed_before_cutoff,
        open_gate_baseline,
        open_gate_final_score,
        late_candidate,
        feature_availability,
        score_coverage_pct,
        score_confidence,
        evaluation_id: newEvalId(candidate.symbol, now),
        signal_id,
        generated_at,
        fresh_until,
        signal_valid_until,
        expires_at: signal_valid_until,
        ttl_seconds: cfg.signal_ttl_sec,
        previous_confirm: opts.previous?.open_confirm ?? null,
    };
}
