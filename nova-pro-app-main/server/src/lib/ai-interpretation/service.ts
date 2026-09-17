// server/src/lib/ai-interpretation/service.ts
// Orchestrates snapshots + deterministic scores + optional LLM narrative.

import type { BuyPressureService } from '../buy-pressure/index.ts';
import type { DecisionSummaryService } from '../decision-summary/index.ts';
import type { EventIntelligenceService } from '../event-intelligence/index.ts';
import type { IntradayRankService } from '../intraday-rank/service.ts';
import type { MarketContextRuntime } from '../market-context/index.ts';
import { SectorMapper } from '../market-intelligence/sector/sector-mapper.ts';
import { resolveTradingSession } from '../session-autonomy/session-clock.ts';
import {
    loadAiInterpretationConfig,
    type AiInterpretationConfig,
} from './config.ts';
import {
    explainRadarWithGemini,
    explainStockWithGemini,
    fallbackRadarNarrative,
    fallbackStockNarrative,
} from './llm-explain.ts';
import { scoreRadarInterpretation } from './radar-scorer.ts';
import { InterpretationSnapshotStore } from './snapshot-store.ts';
import { scoreStockInterpretation } from './stock-scorer.ts';
import type {
    RadarAIInterpretation,
    RadarAIInterpretationNarrative,
    RadarFilterSnapshot,
    RadarStockRowInput,
    StockAIInterpretation,
    StockAIInterpretationNarrative,
    StockInterpretationInput,
} from './types.ts';

export class AiInterpretationService {
    readonly cfg: AiInterpretationConfig;
    readonly snapshots = new InterpretationSnapshotStore();
    private mapper = new SectorMapper();

    constructor(
        private intradayRank: IntradayRankService,
        private buyPressure: BuyPressureService | null,
        private decisionSummary: DecisionSummaryService | null,
        private marketContext: MarketContextRuntime | null,
        private eventIntelligence: EventIntelligenceService | null,
        private geminiApiKey: string,
        cfg?: AiInterpretationConfig,
    ) {
        this.cfg = cfg ?? loadAiInterpretationConfig();
    }

    getHealth() {
        return {
            version: this.cfg.version,
            gemini: Boolean(this.geminiApiKey),
            mutates_strategy: false as const,
            research_persistence: 'NOT_ENABLED' as const,
            llm_assigns_score: false as const,
        };
    }

    async buildStockInput(symbol: string): Promise<StockInterpretationInput | null> {
        await this.mapper.ensureLoaded().catch(() => undefined);
        const batch = this.intradayRank.getLastBatch();
        const fromBatch = batch?.items.find((i) => i.symbol === symbol) ?? null;
        const fromSvc =
            typeof this.intradayRank.getSymbol === 'function'
                ? this.intradayRank.getSymbol(symbol)
                : null;
        const c = fromBatch ?? fromSvc ?? null;
        const bp = this.buyPressure?.getSymbol(symbol) ?? null;
        // Allow BP-only / minimal input so AI works outside top Raw Rank batch.
        if (!c && !bp) {
            return this.buildMinimalStockInput(symbol);
        }
        const ds = this.decisionSummary?.getSymbol(symbol) ?? null;
        const industry = this.mapper.industryOf(symbol)?.industry ?? null;
        const sectorRow = industry
            ? this.marketContext?.getSector(industry) ?? null
            : null;
        const overview = this.marketContext?.getOverview() ?? null;
        const session = resolveTradingSession(Date.now());
        const cashClosed =
            session === 'NIGHT_LIVE' ||
            session === 'WEEKEND' ||
            session === 'CLOSE_AUCTION';

        let event_state: string | null = null;
        if (this.eventIntelligence) {
            for (const ev of this.eventIntelligence.getActive()) {
                const hit = (ev.companies ?? []).some(
                    (company) => String(company).trim() === symbol,
                );
                if (!hit) continue;
                const conf = this.eventIntelligence.getConfirmation(
                    ev.event_id,
                );
                event_state = conf?.status ?? ev.event_type ?? null;
                break;
            }
        }

        const hasCa = Boolean(c?.corporate_action?.has_action_today);
        const metrics = c?.metrics as
            | {
                  vwap?: number | null;
                  vwap_pos_pct?: number | null;
                  rvol_same_time?: number | null;
                  volume_acceleration?: number | null;
                  trade_aggression_score?: number | null;
              }
            | undefined;

        return {
            symbol,
            name: c?.name ?? bp?.name ?? symbol,
            price: c?.last_price ?? bp?.last_price ?? null,
            change_pct: hasCa
                ? (c?.adjusted_change_pct ?? c?.change_pct ?? bp?.change_pct)
                : (c?.change_pct ?? bp?.change_pct ?? null),
            adjusted_change_pct: c?.adjusted_change_pct ?? null,
            raw_change_pct: c?.raw_change_pct ?? null,
            has_ca_today: hasCa,
            c_score: c?.intraday_score ?? bp?.c_score ?? null,
            c_state: c?.state ?? null,
            bp_score: bp?.buy_pressure_score ?? null,
            bp_states: bp?.states ?? [],
            rank: c?.rank ?? bp?.rank ?? null,
            rank_prev: c?.rank_prev ?? bp?.rank_prev ?? null,
            rank_change: c?.rank_change ?? null,
            rank_velocity: c?.rank_velocity ?? bp?.rank_velocity ?? null,
            vwap: metrics?.vwap ?? null,
            vwap_pos_pct:
                bp?.distance_from_vwap_pct ?? metrics?.vwap_pos_pct ?? null,
            rvol: bp?.rvol ?? metrics?.rvol_same_time ?? null,
            volume_acceleration:
                bp?.volume_acceleration ??
                metrics?.volume_acceleration ??
                null,
            trade_aggression:
                bp?.trade_aggression ??
                metrics?.trade_aggression_score ??
                null,
            heat_score: c?.heat_score ?? bp?.heat_score ?? null,
            chase_risk: bp?.chase_risk ?? c?.risk?.chase_risk ?? null,
            decision_status: ds?.status ?? null,
            context_alignment: ds?.context_alignment ?? null,
            sector: industry,
            sector_state: sectorRow?.state ?? null,
            sector_rank: sectorRow?.sector_rank ?? null,
            sector_rank_velocity: sectorRow?.sector_rank_velocity ?? null,
            sector_breadth: sectorRow?.breadth ?? null,
            sector_rs: sectorRow?.sector_relative_strength ?? null,
            leader_concentration: sectorRow?.high_concentration ?? null,
            sector_coverage_pct: sectorRow?.coverage_pct ?? null,
            taiwan_regime: overview?.taiwan_regime?.state ?? null,
            market_breadth: overview?.breadth?.advance_pct ?? null,
            overnight_bias: null,
            preopen_confirmation: null,
            event_state,
            event_confirmation: event_state,
            institutional_realtime_level:
                overview?.institutional_eod?.realtime_level ?? null,
            institutional_is_proxy: Boolean(
                overview?.institutional_risk_proxy?.proxy,
            ),
            data_health: bp?.data_health ?? c?.data_health ?? 'partial',
            data_stale:
                Boolean(bp?.data_stale) ||
                c?.data_health === 'stale' ||
                c?.data_health === 'disconnected',
            data_blocked: Boolean(c?.data_blocked),
            feature_coverage_pct:
                c?.score_coverage_pct ?? (bp ? 45 : 25),
            context_coverage_pct: ds?.data_coverage_pct ?? null,
            freshness: c?.data_health ?? bp?.data_health ?? 'partial',
            cash_session_closed: cashClosed,
            last_updated_at: batch?.as_of ?? bp?.updated_at ?? null,
        };
    }

    /** Last-resort input when symbol is outside C/BP pools. */
    private buildMinimalStockInput(symbol: string): StockInterpretationInput {
        const overview = this.marketContext?.getOverview() ?? null;
        const session = resolveTradingSession(Date.now());
        const cashClosed =
            session === 'NIGHT_LIVE' ||
            session === 'WEEKEND' ||
            session === 'CLOSE_AUCTION';
        return {
            symbol,
            name: symbol,
            price: null,
            change_pct: null,
            adjusted_change_pct: null,
            raw_change_pct: null,
            has_ca_today: false,
            c_score: null,
            c_state: null,
            bp_score: null,
            bp_states: [],
            rank: null,
            rank_prev: null,
            rank_change: null,
            rank_velocity: null,
            vwap: null,
            vwap_pos_pct: null,
            rvol: null,
            volume_acceleration: null,
            trade_aggression: null,
            heat_score: null,
            chase_risk: null,
            decision_status: 'NOT_READY',
            context_alignment: 'INSUFFICIENT_DATA',
            sector: null,
            sector_state: null,
            sector_rank: null,
            sector_rank_velocity: null,
            sector_breadth: null,
            sector_rs: null,
            leader_concentration: null,
            sector_coverage_pct: null,
            taiwan_regime: overview?.taiwan_regime?.state ?? null,
            market_breadth: overview?.breadth?.advance_pct ?? null,
            overnight_bias: null,
            preopen_confirmation: null,
            event_state: null,
            event_confirmation: null,
            institutional_realtime_level:
                overview?.institutional_eod?.realtime_level ?? null,
            institutional_is_proxy: Boolean(
                overview?.institutional_risk_proxy?.proxy,
            ),
            data_health: 'partial',
            data_stale: false,
            data_blocked: false,
            feature_coverage_pct: 15,
            context_coverage_pct: null,
            freshness: 'partial',
            cash_session_closed: cashClosed,
            last_updated_at: null,
        };
    }

    scoreStockFromInput(
        input: StockInterpretationInput,
        snapshot_id?: string,
        snapshot_at?: string,
    ): StockAIInterpretation {
        return scoreStockInterpretation(input, this.cfg, {
            snapshot_id,
            snapshot_at,
        });
    }

    async getStockScore(symbol: string): Promise<StockAIInterpretation | null> {
        const input = await this.buildStockInput(symbol);
        if (!input) return null;
        const snap = this.snapshots.createStock(input);
        return this.scoreStockFromInput(
            snap.input,
            snap.snapshot_id,
            snap.snapshot_at,
        );
    }

    async interpretStock(opts: {
        symbol: string;
        snapshot_id?: string;
        with_llm?: boolean;
    }): Promise<{
        interpretation: StockAIInterpretation;
        narrative: StockAIInterpretationNarrative;
    } | null> {
        let snap = opts.snapshot_id
            ? this.snapshots.getStock(opts.snapshot_id)
            : null;
        if (!snap) {
            const input = await this.buildStockInput(opts.symbol);
            if (!input) return null;
            snap = this.snapshots.createStock(input);
        }
        const interpretation = this.scoreStockFromInput(
            snap.input,
            snap.snapshot_id,
            snap.snapshot_at,
        );

        const withLlm = opts.with_llm !== false;
        let narrative: StockAIInterpretationNarrative = {
            snapshot_id: snap.snapshot_id,
            narrative: fallbackStockNarrative(interpretation),
            sections: null,
            llm_available: false,
            llm_error: null,
            generated_at: new Date().toISOString(),
        };

        if (withLlm && this.geminiApiKey) {
            try {
                const text = await explainStockWithGemini({
                    apiKey: this.geminiApiKey,
                    interpretation,
                });
                narrative = {
                    snapshot_id: snap.snapshot_id,
                    narrative: text,
                    sections: null,
                    llm_available: true,
                    llm_error: null,
                    generated_at: new Date().toISOString(),
                };
            } catch (e) {
                narrative.llm_error =
                    e instanceof Error ? e.message : String(e);
                narrative.llm_available = false;
                // keep fallback narrative; score still valid
            }
        } else if (withLlm && !this.geminiApiKey) {
            narrative.llm_error = 'AI 文字解讀暫時無法使用';
        }

        return { interpretation, narrative };
    }

    buildRadarRowsFromSymbols(symbols: string[]): RadarStockRowInput[] {
        const rows: RadarStockRowInput[] = [];
        const batch = this.intradayRank.getLastBatch();
        const overview = this.marketContext?.getOverview() ?? null;
        for (const symbol of symbols) {
            const c = batch?.items.find((i) => i.symbol === symbol);
            if (!c) continue;
            const bp = this.buyPressure?.getSymbol(symbol) ?? null;
            const ds = this.decisionSummary?.getSymbol(symbol) ?? null;
            const industry = this.mapper.industryOf(symbol)?.industry ?? null;
            const sectorRow = industry
                ? this.marketContext?.getSector(industry) ?? null
                : null;
            rows.push({
                symbol,
                name: c.name,
                c_score: c.intraday_score,
                c_state: c.state,
                bp_score: bp?.buy_pressure_score ?? null,
                bp_states: bp?.states ?? [],
                rank: c.rank,
                rank_change: c.rank_change,
                rank_velocity: c.rank_velocity,
                vwap_pos_pct:
                    bp?.distance_from_vwap_pct ??
                    c.metrics.vwap_pos_pct ??
                    null,
                rvol: bp?.rvol ?? null,
                volume_acceleration:
                    bp?.volume_acceleration ??
                    c.metrics.volume_acceleration ??
                    null,
                trade_aggression:
                    bp?.trade_aggression ??
                    c.metrics.trade_aggression_score ??
                    null,
                decision_status: ds?.status ?? null,
                context_alignment: ds?.context_alignment ?? null,
                confidence: ds?.confidence ?? null,
                sector: industry,
                sector_state: sectorRow?.state ?? null,
                sector_rank: sectorRow?.sector_rank ?? null,
                sector_breadth: sectorRow?.breadth ?? null,
                taiwan_regime: overview?.taiwan_regime?.state ?? null,
                chase_risk: bp?.chase_risk ?? c.risk.chase_risk ?? null,
                has_ca_today: Boolean(c.corporate_action?.has_action_today),
                data_health: bp?.data_health ?? c.data_health,
                data_stale:
                    Boolean(bp?.data_stale) ||
                    c.data_health === 'stale' ||
                    c.data_health === 'disconnected',
                feature_coverage_pct: c.score_coverage_pct ?? null,
            });
        }
        return rows;
    }

    scoreRadar(
        filter: RadarFilterSnapshot,
        rows: RadarStockRowInput[],
        snapshot_id?: string,
        snapshot_at?: string,
    ): RadarAIInterpretation {
        return scoreRadarInterpretation(rows, filter, this.cfg, {
            snapshot_id,
            snapshot_at,
        });
    }

    async interpretRadar(opts: {
        filter: RadarFilterSnapshot;
        symbols?: string[];
        rows?: RadarStockRowInput[];
        snapshot_id?: string;
        with_llm?: boolean;
    }): Promise<{
        interpretation: RadarAIInterpretation;
        narrative: RadarAIInterpretationNarrative;
    }> {
        await this.mapper.ensureLoaded().catch(() => undefined);
        let snap = opts.snapshot_id
            ? this.snapshots.getRadar(opts.snapshot_id)
            : null;
        if (!snap) {
            const rows =
                opts.rows ??
                this.buildRadarRowsFromSymbols(opts.symbols ?? []);
            snap = this.snapshots.createRadar(opts.filter, rows);
        }
        const interpretation = this.scoreRadar(
            snap.filter,
            snap.rows,
            snap.snapshot_id,
            snap.snapshot_at,
        );

        const withLlm = opts.with_llm !== false;
        let narrative: RadarAIInterpretationNarrative = {
            snapshot_id: snap.snapshot_id,
            narrative: fallbackRadarNarrative(interpretation),
            llm_available: false,
            llm_error: null,
            generated_at: new Date().toISOString(),
        };

        if (withLlm && this.geminiApiKey) {
            try {
                const text = await explainRadarWithGemini({
                    apiKey: this.geminiApiKey,
                    interpretation,
                });
                narrative = {
                    snapshot_id: snap.snapshot_id,
                    narrative: text,
                    llm_available: true,
                    llm_error: null,
                    generated_at: new Date().toISOString(),
                };
            } catch (e) {
                narrative.llm_error =
                    e instanceof Error ? e.message : String(e);
            }
        } else if (withLlm && !this.geminiApiKey) {
            narrative.llm_error = 'AI 文字解讀暫時無法使用';
        }

        return { interpretation, narrative };
    }
}
