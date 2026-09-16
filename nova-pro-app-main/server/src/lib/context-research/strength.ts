// server/src/lib/context-research/strength.ts
// Research-only score — NEVER enters production strategy score.

import type { ContextResearchConfig } from './config.ts';
import { DEFAULT_CR_CONFIG } from './config.ts';
import type { ContextSnapshot } from './types.ts';

function clamp01(n: number): number {
    return Math.max(0, Math.min(1, n));
}

export function computeContextStrength(
    snap: ContextSnapshot,
    cfg: ContextResearchConfig = DEFAULT_CR_CONFIG,
): number | null {
    const w = cfg.strength_weights;
    let wSum = 0;
    let score = 0;

    const use = (key: keyof typeof w, available: boolean, contrib: number | null) => {
        if (!available || contrib == null || !Number.isFinite(contrib)) return;
        wSum += w[key];
        score += w[key] * clamp01(contrib);
    };

    // Sector rotation: rank improve / state
    let sectorRot: number | null = null;
    if (snap.feature_availability.sector_rotation) {
        if (snap.sector_rotation_state === 'ROTATING_IN') sectorRot = 0.9;
        else if (snap.sector_rotation_state === 'HOT') sectorRot = 0.75;
        else if (snap.sector_rotation_state === 'STABLE') sectorRot = 0.5;
        else if (snap.sector_rotation_state === 'ROTATING_OUT') sectorRot = 0.25;
        else if (snap.sector_rotation_state === 'COLD') sectorRot = 0.15;
        else if (snap.sector_rank_change != null) {
            sectorRot = clamp01(0.5 + snap.sector_rank_change / 20);
        }
    }
    use('sector_rotation', !!snap.feature_availability.sector_rotation, sectorRot);

    const cap =
        snap.capital_rotation_score != null
            ? snap.capital_rotation_score / 100
            : null;
    use(
        'capital_rotation',
        !!snap.feature_availability.capital_rotation,
        cap,
    );

    let regime: number | null = null;
    if (snap.feature_availability.taiwan_regime && snap.taiwan_regime) {
        if (/RISK_ON_BROAD/.test(snap.taiwan_regime)) regime = 0.9;
        else if (/RISK_ON_NARROW/.test(snap.taiwan_regime)) regime = 0.7;
        else if (/NEUTRAL/.test(snap.taiwan_regime)) regime = 0.5;
        else if (/RISK_OFF_NARROW/.test(snap.taiwan_regime)) regime = 0.3;
        else if (/RISK_OFF_BROAD/.test(snap.taiwan_regime)) regime = 0.15;
        else regime = 0.4;
    }
    use('taiwan_regime', !!snap.feature_availability.taiwan_regime, regime);

    use(
        'sector_breadth',
        !!snap.feature_availability.sector_breadth,
        snap.sector_breadth,
    );

    const rs =
        snap.sector_relative_strength != null
            ? clamp01((snap.sector_relative_strength + 2) / 6)
            : null;
    use('sector_rs', !!snap.feature_availability.sector_rs, rs);

    let ev: number | null = null;
    if (snap.feature_availability.event_confirmation) {
        if (snap.event_confirmation_state === 'EVENT_MARKET_CONFIRMED') {
            ev = 0.9;
        } else if (snap.event_confirmation_state === 'EVENT_PARTIAL_CONFIRMED') {
            ev = 0.65;
        } else if (snap.event_confirmation_state === 'EVENT_WATCH') {
            ev = 0.45;
        } else if (snap.event_confirmation_state === 'EVENT_REJECTED') {
            ev = 0.2;
        } else if (snap.event_market_confirmation_score != null) {
            ev = snap.event_market_confirmation_score / 100;
        } else {
            ev = 0.35;
        }
    }
    use(
        'event_confirmation',
        !!snap.feature_availability.event_confirmation,
        ev,
    );

    // Institutional — PREVIOUS_DAY only; low weight; missing ≠ 0
    const instAvail = snap.institutional_eod_context.available;
    use('institutional', instAvail, instAvail ? 0.5 : null);

    if (wSum <= 0) return null;
    return Math.round((score / wSum) * 1000) / 10;
}
