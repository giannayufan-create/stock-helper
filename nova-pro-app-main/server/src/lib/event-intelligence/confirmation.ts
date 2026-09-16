// server/src/lib/event-intelligence/confirmation.ts
// Deterministic market confirmation — NEVER AI; NEVER mutates strategy scores.

import type { SectorRotationRow } from '../market-context/types.ts';
import type { EventIntelligenceConfig } from './config.ts';
import type {
    ConfirmationStatus,
    EventImpactGraph,
    MarketConfirmationResult,
    MarketEvent,
} from './types.ts';

function clamp01(n: number): number {
    return Math.max(0, Math.min(1, n));
}

function pickFocusSector(
    graph: EventImpactGraph,
    sectors: SectorRotationRow[],
): SectorRotationRow | null {
    const ranked = [...graph.sector_hypotheses].sort(
        (a, b) => b.relevance - a.relevance,
    );
    for (const h of ranked) {
        const hit = sectors.find(
            (s) =>
                s.sector.includes(h.sector_or_theme) ||
                h.sector_or_theme.includes(s.sector) ||
                (h.sector_or_theme === '航運' && /航運|海運|貨櫃/.test(s.sector)) ||
                (h.sector_or_theme === '半導體' && /半導體|電子/.test(s.sector)) ||
                (h.sector_or_theme === '軍工' && /航太|軍|防衛/.test(s.sector)),
        );
        if (hit) return hit;
    }
    return null;
}

export function confirmEvent(input: {
    event: MarketEvent;
    graph: EventImpactGraph;
    sectors: SectorRotationRow[];
    cfg: EventIntelligenceConfig;
    nowIso?: string;
}): MarketConfirmationResult {
    const { event, graph, sectors, cfg } = input;
    const nowIso = input.nowIso ?? new Date().toISOString();
    const focus = pickFocusSector(graph, sectors);

    const avail: Record<string, boolean> = {
        sector_rotation: focus?.sector_rank_change != null,
        capital_rotation: focus?.capital_rotation_score != null,
        sector_breadth: focus?.breadth != null,
        sector_rs: focus?.sector_relative_strength != null,
        c_confirmation: focus != null,
        bp_confirmation: focus != null,
    };

    const weights = cfg.confirmation_weights;
    let wSum = 0;
    let score = 0;
    const use = (key: keyof typeof weights, contrib: number | null) => {
        if (!avail[key] || contrib == null || !Number.isFinite(contrib)) return;
        const w = weights[key];
        wSum += w;
        score += w * contrib;
    };

    // Normalize features to 0..1
    const rankImprove =
        focus?.sector_rank_change != null
            ? clamp01(focus.sector_rank_change / 10)
            : null;
    const cap =
        focus?.capital_rotation_score != null
            ? clamp01(focus.capital_rotation_score / 100)
            : null;
    const breadth = focus?.breadth != null ? clamp01(focus.breadth) : null;
    const rs =
        focus?.sector_relative_strength != null
            ? clamp01((focus.sector_relative_strength + 2) / 6)
            : null;
    const cConf = focus != null ? clamp01(focus.c_strong_count / 5) : null;
    const bpConf = focus != null ? clamp01(focus.bp_strong_count / 4) : null;

    use('sector_rotation', rankImprove);
    use('capital_rotation', cap);
    use('sector_breadth', breadth);
    use('sector_rs', rs);
    use('c_confirmation', cConf);
    use('bp_confirmation', bpConf);

    const raw = wSum > 0 ? (score / wSum) * 100 : 0;
    const market_confirmation_score = Math.round(raw * 10) / 10;

    const reasons: string[] = [];
    if (focus) {
        reasons.push(`焦點產業 ${focus.sector}`);
        if (focus.sector_rank != null && focus.sector_rank_prev != null) {
            reasons.push(
                `Rank #${focus.sector_rank_prev} → #${focus.sector_rank}`,
            );
        }
        if (focus.turnover_share_delta != null) {
            reasons.push(
                `成交額占比 Δ ${(focus.turnover_share_delta * 100).toFixed(1)}pt`,
            );
        }
        if (focus.breadth != null) {
            reasons.push(`Breadth ${(focus.breadth * 100).toFixed(0)}%`);
        }
        reasons.push(`C STRONG ${focus.c_strong_count}`);
        reasons.push(`BP strong ${focus.bp_strong_count}`);
    } else {
        reasons.push('無對應產業輪動資料');
    }

    let status: ConfirmationStatus = 'EVENT_UNCONFIRMED';
    if (event.freshness === 'ARCHIVED' || event.freshness === 'STALE') {
        status = 'EVENT_STALE';
    } else if (
        market_confirmation_score >= cfg.confirmation.confirmed_min_score &&
        focus &&
        (focus.breadth ?? 0) >= cfg.confirmation.min_breadth_for_confirmed &&
        (focus.turnover_share_delta ?? 0) >=
            cfg.confirmation.min_share_delta_for_confirmed &&
        (focus.sector_rank_change ?? 0) > 0
    ) {
        status = 'EVENT_MARKET_CONFIRMED';
    } else if (market_confirmation_score >= cfg.confirmation.partial_min_score) {
        status = 'EVENT_PARTIAL_CONFIRMED';
    } else if (market_confirmation_score >= cfg.confirmation.watch_min_score) {
        status = 'EVENT_WATCH';
    } else if (market_confirmation_score <= cfg.confirmation.reject_max_score) {
        // Weak + deteriorating → rejected
        if (
            focus &&
            ((focus.sector_rank_change ?? 0) < 0 || (focus.breadth ?? 1) < 0.35)
        ) {
            status = 'EVENT_REJECTED';
        } else {
            status = 'EVENT_UNCONFIRMED';
        }
    }

    const weights_used: Record<string, number> = {};
    for (const k of Object.keys(weights) as Array<keyof typeof weights>) {
        if (avail[k]) weights_used[k] = weights[k];
    }

    return {
        event_id: event.event_id,
        status,
        market_confirmation_score,
        event_relevance: event.event_relevance,
        feature_availability: avail,
        weights_used,
        sector_focus: focus?.sector ?? null,
        sector_rank: focus?.sector_rank ?? null,
        sector_rank_prev: focus?.sector_rank_prev ?? null,
        turnover_share: focus?.turnover_share ?? null,
        turnover_share_prev: focus?.turnover_share_prev ?? null,
        breadth: focus?.breadth ?? null,
        c_strong_count: focus?.c_strong_count ?? 0,
        bp_strong_count: focus?.bp_strong_count ?? 0,
        reasons: reasons.slice(0, 8),
        evaluated_at: nowIso,
    };
}
