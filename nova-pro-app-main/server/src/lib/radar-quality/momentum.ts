// server/src/lib/radar-quality/momentum.ts
// ACTIVE / PULLBACK / WATCH / INACTIVE / INVALID + hysteresis.

import type { RadarQualityConfig } from './config.ts';
import type {
    RadarEligibility,
    RadarMomentumState,
    RadarQualityInput,
} from './types.ts';

export interface MomentumEval {
    eligibility: RadarEligibility;
    raw_state: RadarMomentumState;
    state: RadarMomentumState;
    reason: string;
    active_confirmations: string[];
    missing_confirmations: string[];
    enter_hits: number;
    exit_hits: number;
}

function n(v: number | null | undefined): number | null {
    return v != null && Number.isFinite(v) ? v : null;
}

export function collectActiveConfirmations(
    input: RadarQualityInput,
    cfg: RadarQualityConfig,
): { hits: string[]; missing: string[] } {
    const hits: string[] = [];
    const missing: string[] = [];

    const mom = n(input.short_momentum);
    if (mom != null && mom > 0) hits.push('momentum positive');
    else missing.push('momentum positive');

    const accel = n(input.momentum_acceleration);
    if (accel != null && accel > cfg.active_momentum_accel_min) {
        hits.push('momentum acceleration positive');
    } else missing.push('momentum acceleration positive');

    const bp = n(input.bp_score);
    if (bp != null && bp >= cfg.active_bp_strong_min) hits.push('BP strong');
    else missing.push('BP strong');

    if (input.bp_trend_up) hits.push('BP rising');
    else missing.push('BP rising');

    const bpHit = input.bp_states.some((s) =>
        cfg.active_bp_states.includes(s.toUpperCase()),
    );
    if (bpHit) {
        const tag = input.bp_states.find((s) =>
            cfg.active_bp_states.includes(s.toUpperCase()),
        );
        hits.push(tag ?? 'BP state');
    } else missing.push('BUY_SURGE / ASK_EATING / VOLUME_BREAKOUT');

    const vol = n(input.volume_acceleration);
    if (vol != null && vol > cfg.active_volume_accel_min) {
        hits.push('Volume Acceleration positive');
    } else missing.push('Volume Acceleration positive');

    const rv = n(input.rank_velocity);
    if (rv != null && rv >= cfg.active_rank_velocity_min) {
        hits.push('Rank Velocity positive');
    } else missing.push('Rank Velocity positive');

    if (input.vwap_reclaim) hits.push('VWAP reclaim');
    else missing.push('VWAP reclaim');

    const vwap = n(input.vwap_pos_pct);
    if (vwap != null && vwap >= cfg.active_vwap_above_min_pct) {
        hits.push('Above VWAP');
    } else missing.push('Above VWAP');

    const br = (input.breakout_type ?? '').toUpperCase();
    const ev = input.events.map((e) => e.toUpperCase());
    if (br.includes('BREAKOUT') || ev.includes('BREAKOUT') || ev.includes('REBREAK')) {
        hits.push('BREAKOUT');
    } else missing.push('BREAKOUT');

    const sec = (input.sector_state ?? '').toUpperCase();
    if (cfg.active_sector_states.some((s) => sec.includes(s))) {
        hits.push(`Sector ${sec || 'ROTATING_IN'}`);
    } else missing.push('Sector ROTATING_IN / HOT');

    const rvol = n(input.rvol);
    if (rvol != null && rvol >= cfg.active_rvol_min) hits.push('RVOL strong');
    else missing.push('RVOL strong');

    return { hits, missing };
}

function isDataBlocked(input: RadarQualityInput, cfg: RadarQualityConfig): boolean {
    if (input.data_blocked) return true;
    if (cfg.block_stale_from_active && (input.data_stale || input.data_health === 'stale' || input.data_health === 'disconnected')) {
        return true;
    }
    const cov = n(input.score_coverage_pct);
    if (cov != null && cov < cfg.coverage_not_ready_below) return true;
    return false;
}

function isNegativeNoMomentum(
    input: RadarQualityInput,
    cfg: RadarQualityConfig,
): boolean {
    const chg = n(input.change_pct);
    if (chg == null || chg >= 0) return false;
    const mom = n(input.short_momentum) ?? 0;
    const accel = n(input.momentum_acceleration) ?? 0;
    const bp = n(input.bp_score) ?? 0;
    const vol = n(input.volume_acceleration) ?? 0;
    const rv = n(input.rank_velocity) ?? 0;
    return (
        mom <= cfg.momentum_weak_max &&
        accel <= cfg.momentum_weak_max &&
        bp <= cfg.bp_weak_max &&
        vol <= cfg.volume_accel_weak_max &&
        rv <= cfg.rank_velocity_weak_max
    );
}

function isPullbackCandidate(input: RadarQualityInput, cfg: RadarQualityConfig): boolean {
    const ev = input.events.map((e) => e.toUpperCase());
    const pull =
        ev.includes('PULLBACK_READY') ||
        (input.pullback_state ?? '').toUpperCase().includes('READY') ||
        (input.breakout_type ?? '').toUpperCase().includes('PULLBACK');
    if (!pull) return false;
    const cOk =
        input.c_state != null &&
        cfg.active_c_state_strong.includes(input.c_state.toUpperCase());
    const bp = n(input.bp_score);
    const bpOk = bp == null || bp > cfg.bp_weak_max;
    const sec = (input.sector_state ?? '').toUpperCase();
    const notOut = !sec.includes('ROTATING_OUT');
    return (cOk || (n(input.c_score) ?? 0) >= 70) && bpOk && notOut;
}

function isInvalid(input: RadarQualityInput): boolean {
    if ((input.c_state ?? '').toUpperCase() === 'INVALID') return true;
    if (input.events.map((e) => e.toUpperCase()).includes('INVALID')) return true;
    if ((input.decision_status ?? '').toUpperCase() === 'NOT_READY' && input.data_blocked) {
        return true;
    }
    return false;
}

/** Raw state before hysteresis. */
export function evaluateRawMomentum(
    input: RadarQualityInput,
    cfg: RadarQualityConfig,
): Omit<MomentumEval, 'state' | 'enter_hits' | 'exit_hits'> {
    if (isInvalid(input)) {
        return {
            eligibility: 'BLOCKED',
            raw_state: 'INVALID',
            reason: '核心結構已失效',
            active_confirmations: [],
            missing_confirmations: ['structure valid'],
        };
    }

    if (isDataBlocked(input, cfg)) {
        return {
            eligibility: 'WATCH_ONLY',
            raw_state: 'WATCH',
            reason: '資料品質不足，暫不標示 ACTIVE',
            active_confirmations: [],
            missing_confirmations: ['data healthy'],
        };
    }

    const { hits, missing } = collectActiveConfirmations(input, cfg);

    if (isNegativeNoMomentum(input, cfg)) {
        return {
            eligibility: 'ELIGIBLE',
            raw_state: 'INACTIVE',
            reason:
                '目前價格偏弱，且尚無買盤、量能與排名動能確認。',
            active_confirmations: hits,
            missing_confirmations: missing,
        };
    }

    if (hits.length >= cfg.active_min_confirmations) {
        return {
            eligibility: 'ELIGIBLE',
            raw_state: 'ACTIVE',
            reason: `即時動能確認 ${hits.length} 項`,
            active_confirmations: hits,
            missing_confirmations: missing.slice(0, 4),
        };
    }

    if (isPullbackCandidate(input, cfg)) {
        return {
            eligibility: 'ELIGIBLE',
            raw_state: 'PULLBACK',
            reason: '強勢回踩，等待重新確認。',
            active_confirmations: hits,
            missing_confirmations: missing.slice(0, 4),
        };
    }

    if (hits.length >= 1 || (n(input.c_score) ?? 0) >= 70) {
        return {
            eligibility: 'ELIGIBLE',
            raw_state: 'WATCH',
            reason: '有部分條件，但目前還沒形成足夠動能',
            active_confirmations: hits,
            missing_confirmations: missing.slice(0, 4),
        };
    }

    return {
        eligibility: 'WATCH_ONLY',
        raw_state: 'INACTIVE',
        reason: '目前沒有有效動能',
        active_confirmations: hits,
        missing_confirmations: missing.slice(0, 4),
    };
}

export interface HysteresisState {
    displayed: RadarMomentumState;
    enter_hits: number;
    exit_hits: number;
}

export function applyHysteresis(
    raw: RadarMomentumState,
    prior: HysteresisState | undefined,
    cfg: RadarQualityConfig,
): HysteresisState {
    const prev: HysteresisState = prior ?? {
        displayed: 'WATCH',
        enter_hits: 0,
        exit_hits: 0,
    };

    if (raw === 'INVALID') {
        return { displayed: 'INVALID', enter_hits: 0, exit_hits: 0 };
    }

    if (prev.displayed === 'ACTIVE') {
        if (raw === 'ACTIVE') {
            return { displayed: 'ACTIVE', enter_hits: 0, exit_hits: 0 };
        }
        // decay path ACTIVE → WATCH → INACTIVE
        const exitHits = prev.exit_hits + 1;
        if (exitHits >= cfg.active_exit_confirmations) {
            const next =
                raw === 'PULLBACK'
                    ? 'PULLBACK'
                    : raw === 'WATCH'
                      ? 'WATCH'
                      : 'INACTIVE';
            return { displayed: next, enter_hits: 0, exit_hits: 0 };
        }
        return {
            displayed: 'ACTIVE',
            enter_hits: 0,
            exit_hits: exitHits,
        };
    }

    if (raw === 'ACTIVE') {
        const enterHits = prev.enter_hits + 1;
        if (enterHits >= cfg.active_enter_confirmations) {
            return { displayed: 'ACTIVE', enter_hits: 0, exit_hits: 0 };
        }
        return {
            displayed: prev.displayed === 'PULLBACK' ? 'PULLBACK' : 'WATCH',
            enter_hits: enterHits,
            exit_hits: 0,
        };
    }

    if (raw === 'PULLBACK') {
        return { displayed: 'PULLBACK', enter_hits: 0, exit_hits: 0 };
    }

    return { displayed: raw, enter_hits: 0, exit_hits: 0 };
}

export function evaluateMomentum(
    input: RadarQualityInput,
    cfg: RadarQualityConfig,
    prior: HysteresisState | undefined,
): MomentumEval {
    const base = evaluateRawMomentum(input, cfg);
    const hyst = applyHysteresis(base.raw_state, prior, cfg);
    return {
        ...base,
        state: hyst.displayed,
        enter_hits: hyst.enter_hits,
        exit_hits: hyst.exit_hits,
    };
}
