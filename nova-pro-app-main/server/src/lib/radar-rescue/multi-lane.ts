// server/src/lib/radar-rescue/multi-lane.ts
// Multi-lane discovery — parallel to production discovery_score ranking.

import type { DiscoveryItem } from '../intraday-rank/types.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';
import type { BuyPressureItem } from '../buy-pressure/types.ts';
import type { RadarRescueConfig } from './config.ts';
import type { DiscoveryLane } from './types.ts';
import { computeTriggerScore } from './trigger-score.ts';

export interface LaneCandidate {
    symbol: string;
    name: string;
    lanes: DiscoveryLane[];
    discovery_score: number;
    trigger_score: number;
    production_discovery_rank: number | null;
}

export function buildMultiLaneCandidates(
    cfg: RadarRescueConfig,
    opts: {
        discovery: DiscoveryItem[];
        cItems: IntradayRankItem[];
        bpBySymbol: Map<string, BuyPressureItem>;
        sectorHotSymbols?: Set<string>;
        newsSymbols?: Set<string>;
    },
): { lanes: Map<DiscoveryLane, LaneCandidate[]>; merged: LaneCandidate[] } {
    const cBy = new Map(opts.cItems.map((i) => [i.symbol, i]));
    const discRank = new Map(
        opts.discovery.map((d, i) => [d.symbol, i + 1]),
    );

    const bySymbol = new Map<string, LaneCandidate>();
    const ensure = (d: DiscoveryItem): LaneCandidate => {
        let row = bySymbol.get(d.symbol);
        if (!row) {
            const c = cBy.get(d.symbol);
            const bp = opts.bpBySymbol.get(d.symbol);
            row = {
                symbol: d.symbol,
                name: d.name,
                lanes: [],
                discovery_score: d.discovery_score,
                trigger_score: computeTriggerScore(cfg, { c, bp, disc: d }),
                production_discovery_rank: discRank.get(d.symbol) ?? null,
            };
            bySymbol.set(d.symbol, row);
        }
        return row;
    };

    for (const d of opts.discovery) ensure(d);

    const lanes = new Map<DiscoveryLane, LaneCandidate[]>();
    const push = (lane: DiscoveryLane, row: LaneCandidate) => {
        if (!row.lanes.includes(lane)) row.lanes.push(lane);
        const list = lanes.get(lane) ?? [];
        list.push(row);
        lanes.set(lane, list);
    };

    const sortedByAmt = [...opts.discovery].sort(
        (a, b) => (b.total_amount ?? 0) - (a.total_amount ?? 0),
    );
    for (const d of sortedByAmt.slice(0, cfg.lane_quotas.LIQUIDITY_LANE * 2)) {
        push('LIQUIDITY_LANE', ensure(d));
    }

    const byTrigger = [...bySymbol.values()].sort(
        (a, b) => b.trigger_score - a.trigger_score,
    );
    for (const row of byTrigger.slice(0, cfg.lane_quotas.ACCELERATION_LANE * 2)) {
        push('ACCELERATION_LANE', row);
    }

    for (const d of opts.discovery) {
        const c = cBy.get(d.symbol);
        const vwap = c?.metrics?.vwap_pos_pct ?? null;
        const chg = d.change_pct ?? c?.change_pct ?? 0;
        if ((chg < 0 && (vwap ?? -1) >= 0) || (c?.metrics?.return_1m ?? 0) > 0 && chg < 1) {
            push('REVERSAL_LANE', ensure(d));
        }
        if (
            c?.metrics?.breakout_type === 'breakout' ||
            c?.metrics?.breakout_type === 'attempt' ||
            c?.metrics?.breakout_type === 'rebreak'
        ) {
            push('BREAKOUT_LANE', ensure(d));
        }
        if (d.candidate_sources.includes('A') && (d.a_score ?? 0) >= 55) {
            push('A_PRIOR_LANE', ensure(d));
        }
        if (
            d.candidate_sources.includes('B_PASS') ||
            d.candidate_sources.includes('B_WATCH')
        ) {
            push('B_OPEN_LANE', ensure(d));
        }
        if (opts.sectorHotSymbols?.has(d.symbol)) {
            push('SECTOR_LEADER_LANE', ensure(d));
        }
        if (opts.newsSymbols?.has(d.symbol)) {
            push('NEWS_EVENT_LANE', ensure(d));
        }
    }

    // Apply quotas per lane then merge unique
    const selected = new Map<string, LaneCandidate>();
    for (const [lane, list] of lanes) {
        const quota = cfg.lane_quotas[lane] ?? 10;
        const ranked = [...list].sort((a, b) => {
            if (lane === 'LIQUIDITY_LANE') {
                return b.discovery_score - a.discovery_score;
            }
            return b.trigger_score - a.trigger_score;
        });
        for (const row of ranked.slice(0, quota)) {
            const existing = selected.get(row.symbol);
            if (existing) {
                for (const L of row.lanes) {
                    if (!existing.lanes.includes(L)) existing.lanes.push(L);
                }
            } else {
                selected.set(row.symbol, { ...row, lanes: [...row.lanes] });
            }
        }
    }

    const merged = [...selected.values()].sort(
        (a, b) => b.trigger_score - a.trigger_score || b.discovery_score - a.discovery_score,
    );
    return { lanes, merged };
}
