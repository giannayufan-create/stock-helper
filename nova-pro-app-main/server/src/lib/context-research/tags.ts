// server/src/lib/context-research/tags.ts

import type { ContextSnapshot, ContextTag } from './types.ts';

export function deriveContextTags(snap: ContextSnapshot): ContextTag[] {
    const tags: ContextTag[] = [];
    const tw = snap.taiwan_regime ?? '';
    if (/RISK_ON/.test(tw)) tags.push('MARKET_RISK_ON');
    if (/RISK_OFF/.test(tw)) tags.push('MARKET_RISK_OFF');

    const st = snap.sector_rotation_state ?? '';
    if (st === 'ROTATING_IN') tags.push('SECTOR_ROTATING_IN');
    if (st === 'HOT') tags.push('SECTOR_HOT');
    if (st === 'ROTATING_OUT') tags.push('SECTOR_ROTATING_OUT');

    if (
        snap.sector_breadth != null &&
        snap.sector_breadth >= 0.55 &&
        snap.leader_concentration !== true
    ) {
        tags.push('SECTOR_BROAD_STRENGTH');
    }
    if (snap.leader_concentration === true) {
        tags.push('SECTOR_HIGH_CONCENTRATION');
    }

    if (
        (snap.sector_turnover_share_delta != null &&
            snap.sector_turnover_share_delta > 0.01) ||
        (snap.capital_rotation_score != null &&
            snap.capital_rotation_score >= 60)
    ) {
        tags.push('CAPITAL_ATTENTION_RISING');
    }

    const conf = snap.event_confirmation_state;
    if (
        conf === 'EVENT_MARKET_CONFIRMED' ||
        conf === 'EVENT_PARTIAL_CONFIRMED'
    ) {
        tags.push('EVENT_CONFIRMED');
    } else if (
        conf === 'EVENT_UNCONFIRMED' ||
        conf === 'EVENT_WATCH' ||
        conf === 'EVENT_REJECTED'
    ) {
        tags.push('EVENT_UNCONFIRMED');
    }
    if (
        snap.event_relevance_score != null &&
        snap.event_relevance_score >= 70
    ) {
        tags.push('EVENT_RELEVANT');
    }

    if (snap.company_exposure_confidence === 'HIGH') {
        tags.push('COMPANY_EXPOSURE_HIGH');
    } else if (
        snap.company_exposure_confidence === 'LOW' ||
        snap.company_exposure_confidence === 'MEDIUM'
    ) {
        if (snap.company_exposure_confidence === 'LOW') {
            tags.push('COMPANY_EXPOSURE_LOW');
        }
    }

    // Institutional EOD / proxy — research labels only; no fabricated realtime
    if (snap.institutional_eod_context.available) {
        // Without signed net we only tag availability via proxy notes — skip POS/NEG unless provided in feature map
        const note = snap.institutional_eod_context.note ?? '';
        if (/positive|買超|淨買/i.test(note)) {
            tags.push('INSTITUTIONAL_EOD_POSITIVE');
        } else if (/negative|賣超|淨賣/i.test(note)) {
            tags.push('INSTITUTIONAL_EOD_NEGATIVE');
        }
    }
    if (snap.institutional_risk_proxy.available === false) {
        // proxy never claims actual foreign identity
    }

    return [...new Set(tags)];
}
