// server/src/lib/market-context/sector-rotation.ts
// Capital rotation = attention / turnover share movement — NOT net inflow.

import type { TwDayQuote } from '../tw-market-day.ts';
import type { MarketContextConfig } from './config.ts';
import {
    buildMeta,
    confidenceFromCoverage,
    dayQuoteRealtimeLevel,
} from './freshness.ts';
import type {
    SectorRotationRow,
    SectorRotationState,
} from './types.ts';

export interface SectorMemberQuote {
    symbol: string;
    name: string;
    sector: string;
    change_pct: number;
    turnover: number;
}

export interface SectorConfirmCounts {
    /** Confirmation only — never used as turnover denominator. */
    c_strong_count: number;
    bp_strong_count: number;
}

interface SectorHist {
    share: number;
    turnover: number;
    rank: number | null;
    t: number;
}

function changePct(q: TwDayQuote): number {
    const prior = q.close - q.change;
    return prior > 0 ? (q.change / prior) * 100 : 0;
}

export function buildSectorMembers(
    quotes: TwDayQuote[],
    industryOf: (symbol: string) => string | null,
): SectorMemberQuote[] {
    const out: SectorMemberQuote[] = [];
    for (const q of quotes) {
        const sector = industryOf(q.code);
        if (!sector) continue;
        out.push({
            symbol: q.code,
            name: q.name || q.code,
            sector,
            change_pct: changePct(q),
            turnover: Math.max(0, q.amount),
        });
    }
    return out;
}

function resolveState(
    row: {
        covered: number;
        share: number;
        share_delta: number | null;
        rs: number | null;
        breadth: number | null;
        rank_change: number | null;
        high_concentration: boolean;
    },
    cfg: MarketContextConfig,
): SectorRotationState {
    if (row.covered < cfg.min_sector_members_for_state) {
        return 'INSUFFICIENT_COVERAGE';
    }
    const r = cfg.rotation;
    const breadth = row.breadth ?? 0;
    const rs = row.rs ?? 0;
    const delta = row.share_delta ?? 0;
    const rankImprove = (row.rank_change ?? 0) > 0; // prev - now > 0 when rank number falls

    // Concentrated bounce ≠ broad rotating-in
    if (
        row.high_concentration &&
        breadth < r.rotating_in_min_breadth &&
        delta > r.rotating_in_min_share_delta
    ) {
        return 'STABLE';
    }

    if (
        delta >= r.rotating_in_min_share_delta &&
        breadth >= r.rotating_in_min_breadth &&
        rs >= r.rotating_in_min_rs &&
        (rankImprove || delta >= r.rotating_in_min_share_delta * 1.5)
    ) {
        return 'ROTATING_IN';
    }
    if (
        delta <= r.rotating_out_max_share_delta &&
        (rs < 0 || (row.rank_change ?? 0) < 0)
    ) {
        return 'ROTATING_OUT';
    }
    if (
        row.share >= r.hot_min_share &&
        breadth >= r.hot_min_breadth &&
        rs > 0 &&
        !row.high_concentration
    ) {
        return 'HOT';
    }
    if (row.share <= r.cold_max_share && rs <= 0 && breadth < 0.4) {
        return 'COLD';
    }
    return 'STABLE';
}

export class SectorRotationEngine {
    private hist = new Map<string, SectorHist[]>();

    evaluate(
        members: SectorMemberQuote[],
        marketAvgChangePct: number,
        confirms: Map<string, SectorConfirmCounts>,
        cfg: MarketContextConfig,
        fetchedAt = new Date().toISOString(),
    ): SectorRotationRow[] {
        const bySector = new Map<string, SectorMemberQuote[]>();
        for (const m of members) {
            const list = bySector.get(m.sector) ?? [];
            list.push(m);
            bySector.set(m.sector, list);
        }

        const marketTurnover = members.reduce((a, m) => a + m.turnover, 0);
        const now = Date.now();
        const sessionLevel = dayQuoteRealtimeLevel(
            // approximate — caller sets via meta
            null,
        );

        type Draft = {
            sector: string;
            turnover: number;
            share: number;
            rs: number | null;
            breadth: number | null;
            covered: number;
            members: SectorMemberQuote[];
            top1: number;
            top3: number;
            c_strong: number;
            bp_strong: number;
        };

        const drafts: Draft[] = [];
        for (const [sector, list] of bySector) {
            const turnover = list.reduce((a, m) => a + m.turnover, 0);
            if (turnover <= 0 && list.length === 0) continue;
            const share = marketTurnover > 0 ? turnover / marketTurnover : 0;
            const sorted = [...list].sort((a, b) => b.turnover - a.turnover);
            const top1 = turnover > 0 ? (sorted[0]?.turnover ?? 0) / turnover : 0;
            const top3 =
                turnover > 0
                    ? sorted.slice(0, 3).reduce((a, m) => a + m.turnover, 0) /
                      turnover
                    : 0;
            const up = list.filter((m) => m.change_pct > 0).length;
            const breadth = list.length ? up / list.length : null;
            const avgChg =
                list.length > 0
                    ? list.reduce((a, m) => a + m.change_pct, 0) / list.length
                    : null;
            const rs =
                avgChg != null ? avgChg - marketAvgChangePct : null;
            const conf = confirms.get(sector) ?? {
                c_strong_count: 0,
                bp_strong_count: 0,
            };
            drafts.push({
                sector,
                turnover,
                share,
                rs,
                breadth,
                covered: list.length,
                members: sorted,
                top1,
                top3,
                c_strong: conf.c_strong_count,
                bp_strong: conf.bp_strong_count,
            });
        }

        // Rank by capital_rotation_score precursor: share + delta later
        drafts.sort((a, b) => b.share - a.share || b.turnover - a.turnover);

        const rows: SectorRotationRow[] = [];
        for (let i = 0; i < drafts.length; i++) {
            const d = drafts[i]!;
            const rank = i + 1;
            const prevHist = this.hist.get(d.sector) ?? [];
            const prev = prevHist[prevHist.length - 1];
            const share_delta =
                prev != null ? d.share - prev.share : null;
            const turnover_accel =
                prev != null && prev.turnover > 0
                    ? (d.turnover - prev.turnover) / prev.turnover
                    : null;
            const rank_prev = prev?.rank ?? null;
            const rank_change =
                rank_prev != null ? rank_prev - rank : null; // positive = improved
            const rank_velocity = rank_change; // single-step for Phase 1

            const high_concentration =
                d.top1 >= cfg.high_concentration_top1 &&
                ((d.breadth ?? 1) <= cfg.high_concentration_max_breadth ||
                    d.top1 >= 0.7);

            // Attention / capital rotation score (0..100) — NOT net inflow
            let capital_rotation_score = 40;
            capital_rotation_score += Math.min(25, d.share * 100);
            if (share_delta != null) capital_rotation_score += share_delta * 400;
            if (turnover_accel != null)
                capital_rotation_score += Math.max(-10, Math.min(10, turnover_accel * 40));
            if (d.rs != null) capital_rotation_score += Math.max(-10, Math.min(10, d.rs * 2));
            if (d.breadth != null) capital_rotation_score += (d.breadth - 0.5) * 20;
            // BP/C confirmation only — small weight, not denominator
            capital_rotation_score += Math.min(6, d.c_strong * 1.5);
            capital_rotation_score += Math.min(4, d.bp_strong * 1.2);
            if (high_concentration) capital_rotation_score -= 12;
            capital_rotation_score = Math.max(
                0,
                Math.min(100, capital_rotation_score),
            );

            const state = resolveState(
                {
                    covered: d.covered,
                    share: d.share,
                    share_delta,
                    rs: d.rs,
                    breadth: d.breadth,
                    rank_change,
                    high_concentration,
                },
                cfg,
            );

            const tags: string[] = [];
            if (high_concentration) tags.push('HIGH_CONCENTRATION');
            if (state === 'ROTATING_IN' && !high_concentration) {
                tags.push('BROAD_SECTOR_ATTENTION');
            }
            if (high_concentration) {
                // Explicitly forbid broad strength messaging
                tags.push('NOT_BROAD_SECTOR_STRENGTH');
            }

            const coverage_pct = Math.min(
                100,
                (d.covered / Math.max(1, cfg.min_sector_members_for_state)) * 100,
            );

            const row: SectorRotationRow = {
                sector: d.sector,
                sector_rank: rank,
                sector_rank_prev: rank_prev,
                sector_rank_change: rank_change,
                sector_rank_velocity: rank_velocity,
                sector_turnover: d.turnover,
                turnover_share: Math.round(d.share * 10000) / 10000,
                turnover_share_prev: prev?.share ?? null,
                turnover_share_delta:
                    share_delta != null
                        ? Math.round(share_delta * 10000) / 10000
                        : null,
                sector_turnover_acceleration: turnover_accel,
                sector_relative_strength:
                    d.rs != null ? Math.round(d.rs * 100) / 100 : null,
                breadth: d.breadth != null ? Math.round(d.breadth * 1000) / 1000 : null,
                c_strong_count: d.c_strong,
                bp_strong_count: d.bp_strong,
                member_count: d.covered,
                covered_members: d.covered,
                coverage_pct: Math.round(coverage_pct * 10) / 10,
                top1_turnover_share: Math.round(d.top1 * 1000) / 1000,
                top3_turnover_share: Math.round(d.top3 * 1000) / 1000,
                high_concentration,
                capital_rotation_score:
                    Math.round(capital_rotation_score * 10) / 10,
                attention_flow_score:
                    Math.round(capital_rotation_score * 10) / 10,
                state,
                tags,
                leaders: d.members.slice(0, 5).map((m) => ({
                    symbol: m.symbol,
                    name: m.name,
                    turnover: m.turnover,
                    change_pct: Math.round(m.change_pct * 100) / 100,
                })),
                meta: buildMeta({
                    source: 'TW_DAY_QUOTES+SECTOR_MAP',
                    source_type: 'sector_rotation',
                    fetched_at: fetchedAt,
                    available: d.covered > 0,
                    coverage_pct,
                    confidence: confidenceFromCoverage(
                        Math.min(100, (d.covered / 10) * 100),
                    ),
                    realtime_level: sessionLevel === 'UNKNOWN' ? 'DELAYED' : sessionLevel,
                }),
            };
            rows.push(row);

            const nextHist = [
                ...prevHist,
                { share: d.share, turnover: d.turnover, rank, t: now },
            ].slice(-12);
            this.hist.set(d.sector, nextHist);
        }

        // Re-rank by capital_rotation_score for output ordering preference
        rows.sort(
            (a, b) =>
                (b.capital_rotation_score ?? 0) -
                    (a.capital_rotation_score ?? 0) ||
                b.turnover_share - a.turnover_share,
        );
        // Keep sector_rank as share-based rank already assigned; OK

        return rows;
    }

    /** Test hook: seed previous share/rank for delta tests. */
    __seedHist(
        sector: string,
        point: { share: number; turnover: number; rank: number },
    ): void {
        this.hist.set(sector, [{ ...point, t: Date.now() - 60_000 }]);
    }
}
