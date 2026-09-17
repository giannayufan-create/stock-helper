// server/src/lib/radar-quality/focus.ts
// Stable Focus Top3 — sticky leader, presentation-only ranking.

import type { RadarQualityConfig } from './config.ts';
import type {
    FocusSlot,
    RadarMomentumState,
    RadarQualityItem,
} from './types.ts';

export interface FocusLeaderState {
    symbol: string;
    sinceMs: number;
    challenger: string | null;
    challengerHits: number;
}

function focusEligible(state: RadarMomentumState): boolean {
    return state === 'ACTIVE' || state === 'PULLBACK';
}

/** Presentation-only score for ordering Focus candidates. */
export function computeFocusScore(item: {
    momentum_state: RadarMomentumState;
    active_confirmations: string[];
    bp_score?: number | null;
    c_score?: number | null;
    rank_velocity?: number | null;
    volume_acceleration?: number | null;
    vwap_pos_pct?: number | null;
    institutional_continuation?: string;
    decision_status?: string | null;
    ai_score?: number | null;
    chase_risk?: string | null;
    data_confidence?: string;
}): number {
    if (!focusEligible(item.momentum_state)) return -1;
    let s = item.momentum_state === 'ACTIVE' ? 40 : 25;
    s += Math.min(20, item.active_confirmations.length * 3);
    s += Math.min(15, (item.bp_score ?? 0) / 10);
    s += Math.min(10, (item.c_score ?? 0) / 15);
    s += Math.min(10, Math.max(0, item.rank_velocity ?? 0));
    s += Math.min(8, Math.max(0, (item.volume_acceleration ?? 0) * 4));
    if ((item.vwap_pos_pct ?? -99) >= 0) s += 5;
    if (item.institutional_continuation === 'CONFIRMED_CONTINUATION') s += 8;
    else if (item.institutional_continuation === 'PARTIAL_CONTINUATION') s += 4;
    if (item.decision_status === 'CONFIRMED_STRENGTH') s += 5;
    if ((item.ai_score ?? 0) >= 70) s += 4;
    const chase = (item.chase_risk ?? '').toUpperCase();
    if (chase === 'HIGH' || chase === 'EXTREME') s -= 8;
    if (item.data_confidence === 'LOW') s -= 10;
    return Math.round(s * 10) / 10;
}

export function selectFocusTop3(
    items: RadarQualityItem[],
    cfg: RadarQualityConfig,
    leader: FocusLeaderState | null,
    nowMs: number,
): { slots: FocusSlot[]; leader: FocusLeaderState | null } {
    const candidates = items
        .filter((i) => focusEligible(i.momentum_state) && i.focus_score >= 0)
        .sort((a, b) => b.focus_score - a.focus_score);

    if (!candidates.length) {
        return { slots: [], leader: null };
    }

    let nextLeader = leader;
    const top = candidates[0]!;

    // Immediate invalidate leader
    const leaderItem = leader
        ? items.find((i) => i.symbol === leader.symbol)
        : null;
    if (leader && leaderItem) {
        const stale =
            leaderItem.momentum_state === 'INVALID' ||
            leaderItem.momentum_state === 'INACTIVE' ||
            leaderItem.momentum_state === 'WATCH' ||
            leaderItem.decision_status === 'NOT_READY' ||
            leaderItem.data_confidence === 'LOW';
        if (stale || !focusEligible(leaderItem.momentum_state)) {
            nextLeader = {
                symbol: top.symbol,
                sinceMs: nowMs,
                challenger: null,
                challengerHits: 0,
            };
        } else {
            const holdOk =
                nowMs - leader.sinceMs >=
                cfg.focus_leader_min_hold_seconds * 1000;
            const margin = top.focus_score - leaderItem.focus_score;
            if (
                top.symbol !== leader.symbol &&
                holdOk &&
                margin >= cfg.focus_switch_margin
            ) {
                const hits =
                    leader.challenger === top.symbol
                        ? leader.challengerHits + 1
                        : 1;
                if (hits >= cfg.focus_switch_confirmations) {
                    nextLeader = {
                        symbol: top.symbol,
                        sinceMs: nowMs,
                        challenger: null,
                        challengerHits: 0,
                    };
                } else {
                    nextLeader = {
                        ...leader,
                        challenger: top.symbol,
                        challengerHits: hits,
                    };
                }
            } else if (top.symbol === leader.symbol) {
                nextLeader = {
                    ...leader,
                    challenger: null,
                    challengerHits: 0,
                };
            } else {
                nextLeader = {
                    ...leader,
                    challenger: null,
                    challengerHits: 0,
                };
            }
        }
    } else {
        nextLeader = {
            symbol: top.symbol,
            sinceMs: nowMs,
            challenger: null,
            challengerHits: 0,
        };
    }

    // Build ordered list with sticky #1
    const ordered: RadarQualityItem[] = [];
    const leaderSym = nextLeader?.symbol;
    const leadItem = leaderSym
        ? candidates.find((c) => c.symbol === leaderSym) ??
          items.find((i) => i.symbol === leaderSym)
        : null;
    if (leadItem && focusEligible(leadItem.momentum_state)) {
        ordered.push(leadItem);
    }
    for (const c of candidates) {
        if (ordered.some((o) => o.symbol === c.symbol)) continue;
        ordered.push(c);
        if (ordered.length >= cfg.focus_top_n) break;
    }

    const slots: FocusSlot[] = ordered.slice(0, cfg.focus_top_n).map((it, i) => ({
        focus_rank: (i + 1) as 1 | 2 | 3,
        symbol: it.symbol,
        name: it.name,
        momentum_state: it.momentum_state,
        focus_score: it.focus_score,
        raw_rank: it.raw_rank,
        reasons: it.focus_reasons.slice(0, 4),
        held_since:
            i === 0 && nextLeader
                ? new Date(nextLeader.sinceMs).toISOString()
                : it.updated_at,
    }));

    return { slots, leader: nextLeader };
}
