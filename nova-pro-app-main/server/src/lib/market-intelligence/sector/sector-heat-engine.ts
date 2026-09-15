// server/src/lib/market-intelligence/sector/sector-heat-engine.ts

import type { IntradayRankItem } from '../../intraday-rank/types.ts';
import type { MarketIntelligenceConfig } from '../config.ts';
import { computeGroupHeat } from '../heat-engine.ts';
import type { HeatMemberSnapshot, SectorHeatRow } from '../types.ts';
import type { SectorMapper } from './sector-mapper.ts';

function toMember(item: IntradayRankItem): HeatMemberSnapshot {
    return {
        symbol: item.symbol,
        name: item.name,
        c_score: item.intraday_score,
        stock_heat_score: item.heat_score,
        state: item.state,
        rank: item.rank,
        rank_velocity: item.rank_velocity,
        change_pct: item.change_pct,
        events: item.events ?? [],
        rvol: null,
        volume_acceleration: item.metrics?.volume_acceleration ?? null,
        vwap_pos_pct: item.metrics?.vwap_pos_pct ?? null,
    };
}

export class SectorHeatEngine {
    private history = new Map<string, Array<{ at: number; heat: number }>>();

    constructor(
        private mapper: SectorMapper,
        private cfg: MarketIntelligenceConfig,
    ) {}

    compute(ranked: IntradayRankItem[]): SectorHeatRow[] {
        const byIndustry = new Map<string, IntradayRankItem[]>();
        for (const item of ranked) {
            const m = this.mapper.industryOf(item.symbol);
            if (!m) continue;
            const list = byIndustry.get(m.industry) ?? [];
            list.push(item);
            byIndustry.set(m.industry, list);
        }

        const now = Date.now();
        const keepMs = this.cfg.snapshot_history_minutes * 60_000;
        const rows: SectorHeatRow[] = [];

        for (const [industry, items] of byIndustry) {
            const allSymbols = this.mapper.symbolsOf(industry);
            const covered = items.map(toMember);
            const src = this.mapper.industryOf(items[0]!.symbol)?.source ?? 'UNKNOWN';
            const hist = this.history.get(industry) ?? [];
            const result = computeGroupHeat({
                id: industry,
                name: industry,
                totalMembers: Math.max(allSymbols.length, covered.length),
                covered,
                weights: this.cfg.sector_heat,
                cfg: this.cfg,
                history: hist,
                nowMs: now,
                source: src,
            });

            if (result.heat_score != null) {
                hist.push({ at: now, heat: result.heat_score });
                this.history.set(
                    industry,
                    hist.filter((h) => now - h.at <= keepMs),
                );
            }

            rows.push({
                ...result,
                sector: industry,
                mapping_source: src,
            });
        }

        const rankedRows = rows
            .filter((r) => r.eligible_for_ranking && r.heat_score != null)
            .sort((a, b) => (b.heat_score ?? 0) - (a.heat_score ?? 0))
            .map((r, i) => ({ ...r, rank: i + 1 }));

        const ineligible = rows
            .filter((r) => !r.eligible_for_ranking || r.heat_score == null)
            .map((r) => ({ ...r, rank: undefined }));

        return [...rankedRows, ...ineligible];
    }

    /** Test helper: inject historical heat point. */
    pushHistory(industry: string, at: number, heat: number): void {
        const hist = this.history.get(industry) ?? [];
        hist.push({ at, heat });
        this.history.set(industry, hist);
    }
}
