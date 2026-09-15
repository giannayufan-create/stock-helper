// server/src/lib/market-intelligence/theme/theme-heat-engine.ts

import type { IntradayRankItem } from '../../intraday-rank/types.ts';
import type { MarketIntelligenceConfig } from '../config.ts';
import { computeGroupHeat } from '../heat-engine.ts';
import type { HeatMemberSnapshot, ThemeHeatRow } from '../types.ts';
import type { ThemeMapper } from './theme-mapper.ts';

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

export class ThemeHeatEngine {
    private history = new Map<string, Array<{ at: number; heat: number }>>();

    constructor(
        private mapper: ThemeMapper,
        private cfg: MarketIntelligenceConfig,
    ) {}

    compute(ranked: IntradayRankItem[]): ThemeHeatRow[] {
        const bySym = new Map(ranked.map((r) => [r.symbol, r]));
        const now = Date.now();
        const keepMs = this.cfg.snapshot_history_minutes * 60_000;
        const rows: ThemeHeatRow[] = [];

        for (const theme of this.mapper.all()) {
            const covered: HeatMemberSnapshot[] = [];
            for (const sym of theme.symbols) {
                const item = bySym.get(sym);
                if (item) covered.push(toMember(item));
            }
            const hist = this.history.get(theme.theme_id) ?? [];
            const result = computeGroupHeat({
                id: theme.theme_id,
                name: theme.name,
                totalMembers: theme.symbols.length,
                covered,
                weights: this.cfg.theme_heat,
                cfg: this.cfg,
                history: hist,
                nowMs: now,
                source: theme.source,
            });
            if (result.heat_score != null) {
                hist.push({ at: now, heat: result.heat_score });
                this.history.set(
                    theme.theme_id,
                    hist.filter((h) => now - h.at <= keepMs),
                );
            }
            rows.push({
                ...result,
                theme_id: theme.theme_id,
                theme: theme.name,
                aliases: theme.aliases,
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

    pushHistory(themeId: string, at: number, heat: number): void {
        const hist = this.history.get(themeId) ?? [];
        hist.push({ at, heat });
        this.history.set(themeId, hist);
    }
}
