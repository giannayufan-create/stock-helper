// server/src/lib/decision-summary/service.ts
// Decision Support orchestrator — reads C/BP/MC/EI; NEVER mutates them.

import type { BuyPressureService } from '../buy-pressure/index.ts';
import type { BuyPressureItem } from '../buy-pressure/types.ts';
import type { EventIntelligenceService } from '../event-intelligence/index.ts';
import type { IntradayRankService } from '../intraday-rank/service.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';
import type { MarketContextRuntime } from '../market-context/index.ts';
import type { SectorRotationRow } from '../market-context/types.ts';
import { SectorMapper } from '../market-intelligence/sector/sector-mapper.ts';
import {
    loadDecisionSummaryConfig,
    type DecisionSummaryConfig,
} from './config.ts';
import { evaluateDecisionSummary } from './engine.ts';
import {
    DS_VERSION,
    type DecisionSummary,
    type DecisionSummaryBatch,
    type DecisionSummaryInput,
} from './types.ts';

export class DecisionSummaryService {
    readonly cfg: DecisionSummaryConfig;
    private timer: ReturnType<typeof setInterval> | null = null;
    private last: DecisionSummaryBatch | null = null;
    private bySymbol = new Map<string, DecisionSummary>();
    private streak = new Map<string, number>();
    private startedAt = Date.now();
    private mapper = new SectorMapper();

    constructor(
        private intradayRank: IntradayRankService,
        private buyPressure: BuyPressureService | null,
        private marketContext: MarketContextRuntime | null,
        private eventIntelligence: EventIntelligenceService | null,
        cfg?: DecisionSummaryConfig,
    ) {
        this.cfg = cfg ?? loadDecisionSummaryConfig();
    }

    start(): void {
        if (!this.cfg.enabled) return;
        if (this.timer) return;
        void this.mapper.ensureLoaded().catch(() => undefined);
        void this.evaluate();
        this.timer = setInterval(() => {
            void this.evaluate();
        }, Math.max(2, this.cfg.evaluate_interval_sec) * 1000);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    getHealth() {
        return {
            enabled: this.cfg.enabled,
            status: this.cfg.enabled ? 'OK' : 'DISABLED',
            version: DS_VERSION,
            count: this.bySymbol.size,
            as_of: this.last?.as_of ?? null,
            uptime_ms: Date.now() - this.startedAt,
            mutates_strategy: false as const,
        };
    }

    getLastBatch(): DecisionSummaryBatch | null {
        return this.last;
    }

    getSymbol(symbol: string): DecisionSummary | null {
        return this.bySymbol.get(symbol) ?? null;
    }

    list(limit = 80): DecisionSummaryBatch {
        if (this.last) {
            return {
                ...this.last,
                items: this.last.items.slice(0, limit),
                count: Math.min(this.last.items.length, limit),
            };
        }
        const items = [...this.bySymbol.values()].slice(0, limit);
        return {
            as_of: new Date().toISOString(),
            version: DS_VERSION,
            count: items.length,
            items,
            evaluate_interval_sec: this.cfg.evaluate_interval_sec,
            mutates_strategy: false,
            note: 'Decision Support Layer — does not mutate C/BP/strategy.',
        };
    }

    async evaluate(): Promise<DecisionSummaryBatch> {
        const nowIso = new Date().toISOString();
        await this.mapper.ensureLoaded().catch(() => undefined);

        const batch = this.intradayRank.getLastBatch();
        const overview = this.marketContext?.getOverview() ?? null;
        const regime = overview?.taiwan_regime?.state ?? null;
        const breadthAdv = overview?.breadth?.advance_pct ?? null;
        const inst = overview?.institutional_eod ?? null;
        const proxy = overview?.institutional_risk_proxy ?? null;

        const eventBySymbol = this.buildEventMap();
        const items: DecisionSummary[] = [];
        const seen = new Set<string>();

        for (const c of batch?.items ?? []) {
            seen.add(c.symbol);
            const bp = this.buyPressure?.getSymbol(c.symbol) ?? null;
            const industry = this.mapper.industryOf(c.symbol)?.industry ?? null;
            const sectorRow: SectorRotationRow | null = industry
                ? this.marketContext?.getSector(industry) ?? null
                : null;

            const input = this.buildInput(c, bp, {
                regime,
                breadthAdv,
                marketAvailable: Boolean(overview),
                sectorRow,
                eventStatus: eventBySymbol.get(c.symbol) ?? null,
                institutionalLevel: inst?.realtime_level ?? null,
                institutionalProxy: Boolean(proxy?.proxy),
            });

            const prior = this.streak.get(c.symbol) ?? 0;
            const summary = evaluateDecisionSummary(
                input,
                this.cfg,
                prior,
                nowIso,
            );
            this.streak.set(c.symbol, summary.confirm_streak);
            this.bySymbol.set(c.symbol, summary);
            items.push(summary);
        }

        for (const sym of [...this.bySymbol.keys()]) {
            if (!seen.has(sym)) {
                this.bySymbol.delete(sym);
                this.streak.delete(sym);
            }
        }

        const out: DecisionSummaryBatch = {
            as_of: nowIso,
            version: DS_VERSION,
            count: items.length,
            items,
            evaluate_interval_sec: this.cfg.evaluate_interval_sec,
            mutates_strategy: false,
            note: 'Decision Support Layer — does not mutate C/BP/strategy.',
        };
        this.last = out;
        return out;
    }

    evaluateInput(
        input: DecisionSummaryInput,
        priorStreak = 0,
    ): DecisionSummary {
        return evaluateDecisionSummary(input, this.cfg, priorStreak);
    }

    private buildEventMap(): Map<string, string> {
        const map = new Map<string, string>();
        const ei = this.eventIntelligence;
        if (!ei) return map;
        for (const ev of ei.getActive()) {
            const conf = ei.getConfirmation(ev.event_id);
            const status = conf?.status ?? null;
            if (!status) continue;
            for (const company of ev.companies ?? []) {
                const sym = String(company).trim();
                if (!/^\d{4}[A-Z]?$/.test(sym)) continue;
                const prev = map.get(sym);
                if (status === 'EVENT_MARKET_CONFIRMED' || !prev) {
                    map.set(sym, status);
                }
            }
        }
        return map;
    }

    private buildInput(
        c: IntradayRankItem,
        bp: BuyPressureItem | null,
        ctx: {
            regime: string | null;
            breadthAdv: number | null;
            marketAvailable: boolean;
            sectorRow: SectorRotationRow | null;
            eventStatus: string | null;
            institutionalLevel: string | null;
            institutionalProxy: boolean;
        },
    ): DecisionSummaryInput {
        const hasCa = Boolean(c.corporate_action?.has_action_today);
        return {
            symbol: c.symbol,
            name: c.name,
            c_score: c.intraday_score,
            c_state: c.state,
            rank: c.rank,
            rank_prev: c.rank_prev,
            rank_change: c.rank_change,
            rank_velocity: c.rank_velocity,
            bp_score: bp?.buy_pressure_score ?? null,
            bp_states: bp?.states ?? [],
            last_price: c.last_price,
            vwap: c.metrics.vwap,
            vwap_pos_pct:
                bp?.distance_from_vwap_pct ?? c.metrics.vwap_pos_pct ?? null,
            rvol: bp?.rvol ?? null,
            volume_acceleration:
                bp?.volume_acceleration ??
                c.metrics.volume_acceleration ??
                null,
            trade_aggression:
                bp?.trade_aggression ??
                c.metrics.trade_aggression_score ??
                null,
            breakout_type:
                bp?.breakout_type ?? c.metrics.breakout_type ?? null,
            chase_risk: bp?.chase_risk ?? c.risk.chase_risk ?? null,
            heat_score: c.heat_score,
            data_health: bp?.data_health ?? c.data_health,
            data_blocked: c.data_blocked,
            data_stale:
                Boolean(bp?.data_stale) ||
                c.data_health === 'stale' ||
                c.data_health === 'disconnected',
            score_coverage_pct: c.score_coverage_pct ?? null,
            bp_coverage_pct: bp?.score_coverage_pct ?? null,
            has_ca_today: hasCa,
            adjusted_change_pct:
                c.adjusted_change_pct ?? (hasCa ? c.change_pct : null),
            raw_change_pct: c.raw_change_pct ?? null,
            taiwan_regime: ctx.regime,
            market_breadth_advance_pct: ctx.breadthAdv,
            market_context_available: ctx.marketAvailable,
            sector_state: ctx.sectorRow?.state ?? null,
            sector_breadth: ctx.sectorRow?.breadth ?? null,
            sector_rs: ctx.sectorRow?.sector_relative_strength ?? null,
            sector_coverage_pct: ctx.sectorRow?.coverage_pct ?? null,
            event_status: ctx.eventStatus,
            institutional_realtime_level: ctx.institutionalLevel,
            institutional_is_proxy: ctx.institutionalProxy,
        };
    }
}
