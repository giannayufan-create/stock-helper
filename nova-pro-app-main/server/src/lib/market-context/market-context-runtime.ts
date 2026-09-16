// server/src/lib/market-context/market-context-runtime.ts
// Context only — NEVER mutates A/B/C / Heat / Rank / Buy Pressure.
// NEVER creates Shioaji Tick/BidAsk upstream subscriptions.

import type { BuyPressureService } from '../buy-pressure/buy-pressure-service.ts';
import type { IntradayRankService } from '../intraday-rank/service.ts';
import { GlobalMarketService } from '../market-intelligence/global-market/global-market-service.ts';
import type { MarketRuntime } from '../market-runtime/index.ts';
import { SectorMapper } from '../market-intelligence/sector/sector-mapper.ts';
import { fetchTwMarketDayAll, type TwDayQuote } from '../tw-market-day.ts';
import { computeMarketBreadth } from './breadth-engine.ts';
import { DEFAULT_MC_CONFIG, type MarketContextConfig } from './config.ts';
import { buildMeta, dayQuoteRealtimeLevel } from './freshness.ts';
import {
    SectorRotationEngine,
    buildSectorMembers,
    type SectorConfirmCounts,
} from './sector-rotation.ts';
import { computeTaiwanRegime } from './taiwan-regime.ts';
import type {
    BroadUniverseReport,
    GlobalRegime,
    InstitutionalEodBlock,
    InstitutionalRiskProxy,
    MarketContextHealth,
    MarketContextOverview,
    SectorRotationRow,
    TaiwanRegime,
} from './types.ts';
import { MC_VERSION } from './types.ts';
import { buildGapLayersSnapshot } from './gap-layers/index.ts';
import type { GapLayersSnapshot } from './gap-layers/types.ts';
import { EvalTimingRegistry } from '../live-acceptance/eval-timing.ts';
import { ReadinessTracker } from '../live-acceptance/readiness.ts';

function changePctOf(q: TwDayQuote): number {
    const prior = q.close - q.change;
    return prior > 0 ? (q.change / prior) * 100 : 0;
}

export class MarketContextRuntime {
    readonly cfg: MarketContextConfig;
    private timer: ReturnType<typeof setInterval> | null = null;
    private mapper = new SectorMapper();
    private sectors = new SectorRotationEngine();
    private lastOverview: MarketContextOverview | null = null;
    private lastEvaluateAt: string | null = null;
    private marketTurnoverHistory: number[] = [];
    private sectorsLastFull: SectorRotationRow[] = [];
    private lastQuotes: TwDayQuote[] = [];
    private globalMarket = new GlobalMarketService();
    private lastGapLayers: GapLayersSnapshot | null = null;

    constructor(
        private runtime: MarketRuntime,
        private intradayRank: IntradayRankService,
        private buyPressure: BuyPressureService | null,
        cfg?: MarketContextConfig,
    ) {
        this.cfg = cfg ?? { ...DEFAULT_MC_CONFIG };
    }

    start(): void {
        if (!this.cfg.enabled || this.timer) return;
        void this.evaluate();
        this.timer = setInterval(
            () => void this.evaluate(),
            Math.max(15, this.cfg.evaluate_interval_sec) * 1000,
        );
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    getHealth(): MarketContextHealth {
        const ov = this.lastOverview;
        return {
            enabled: this.cfg.enabled,
            status: !this.cfg.enabled
                ? 'UNAVAILABLE'
                : ov
                  ? ov.breadth.coverage_pct >= 50
                      ? 'HEALTHY'
                      : 'PARTIAL'
                  : 'PARTIAL',
            version: MC_VERSION,
            last_evaluate_at: this.lastEvaluateAt,
            broad_universe_size: ov?.broad_universe.broad_universe_size ?? 0,
            coverage_pct: ov?.broad_universe.coverage_pct ?? 0,
            creates_upstream_subscription: false,
            mutates_strategy: false,
            note: 'Broad market from TWSE/TPEx day quotes — no Tick/BidAsk subscribe; does not mutate A/B/C/BP.',
        };
    }

    getOverview(): MarketContextOverview | null {
        return this.lastOverview;
    }

    getRegime(): {
        global_regime: GlobalRegime;
        taiwan_regime: TaiwanRegime;
    } | null {
        if (!this.lastOverview) return null;
        return {
            global_regime: this.lastOverview.global_regime,
            taiwan_regime: this.lastOverview.taiwan_regime,
        };
    }

    getBreadth() {
        return this.lastOverview?.breadth ?? null;
    }

    getSectors(): SectorRotationRow[] {
        return this.sectorsLastFull;
    }

    getGapLayers(): GapLayersSnapshot | null {
        return this.lastGapLayers ?? this.lastOverview?.gap_layers ?? null;
    }

    /** Headless overnight / Asia assets — reuse private GlobalMarket cache. */
    getGlobalAssets() {
        return this.globalMarket.getCached()?.assets ?? [];
    }

    async refreshGlobalAssets() {
        return this.globalMarket.refresh(true);
    }

    getSector(name: string): SectorRotationRow | null {
        const key = name.trim();
        return (
            this.sectorsLastFull.find(
                (s) => s.sector === key || s.sector.includes(key),
            ) ?? null
        );
    }

    async evaluate(): Promise<MarketContextOverview> {
        const t0 = performance.now();
        try {
            return await this.evaluateInner();
        } finally {
            EvalTimingRegistry.note('Context', performance.now() - t0);
            ReadinessTracker.markContextReady();
        }
    }

    private async evaluateInner(): Promise<MarketContextOverview> {
        const fetchedAt = new Date().toISOString();
        const warnings: string[] = [];

        await this.mapper.ensureLoaded().catch(() => {
            warnings.push('sector_mapper_failed');
        });

        await this.globalMarket.refresh().catch(() => {
            warnings.push('global_regime_refresh_failed');
        });

        let quotes: TwDayQuote[] = [];
        try {
            quotes = await fetchTwMarketDayAll({
                maxAgeMs: this.cfg.broad_day_quote_max_age_ms,
            });
        } catch {
            warnings.push('broad_day_quotes_failed');
            quotes = this.lastQuotes;
        }
        if (quotes.length) this.lastQuotes = quotes;

        const industryOf = (symbol: string) =>
            this.mapper.industryOf(symbol)?.industry ?? null;

        const breadth = computeMarketBreadth(quotes, this.cfg, fetchedAt);
        // Hard rule: never claim active BP pool as market breadth
        if (breadth.uses_active_watch_pool !== false) {
            throw new Error('breadth must not use active watch pool');
        }

        const totalTurnover = quotes.reduce((a, q) => a + Math.max(0, q.amount), 0);
        this.marketTurnoverHistory = [
            ...this.marketTurnoverHistory,
            totalTurnover,
        ].slice(-8);

        const taiex = this.indexChangePct(['IX0001', '001'], '^TWII');
        const tpex = this.indexChangePct(['IX0043', '002'], '^TPEX');

        const members = buildSectorMembers(quotes, industryOf);
        const marketAvg =
            quotes.length > 0
                ? quotes.reduce((a, q) => a + changePctOf(q), 0) / quotes.length
                : 0;

        const confirms = this.buildConfirmCounts(industryOf);
        const sectorRows = this.sectors.evaluate(
            members,
            marketAvg,
            confirms,
            this.cfg,
            fetchedAt,
        );
        this.sectorsLastFull = sectorRows;

        const risingSectors = sectorRows.filter(
            (s) => (s.breadth ?? 0) >= 0.5 && s.state !== 'INSUFFICIENT_COVERAGE',
        ).length;
        const sectorBreadthPct =
            sectorRows.length > 0
                ? (risingSectors / sectorRows.length) * 100
                : null;

        const taiwan_regime = computeTaiwanRegime({
            quotes,
            industryOf,
            breadth,
            taiexChangePct: taiex,
            tpexChangePct: tpex,
            marketTurnoverHistory: this.marketTurnoverHistory,
            sectorBreadthPct,
            cfg: this.cfg,
            fetchedAt,
        });

        const global_regime = this.buildGlobalRegime(fetchedAt);
        const broad_universe = this.broadReport(quotes, fetchedAt);
        const institutional_eod = this.institutionalEod(fetchedAt);
        const institutional_risk_proxy = this.institutionalProxy(fetchedAt);

        const globalAssets =
            this.globalMarket.getCached()?.assets ?? [];
        let gap_layers: GapLayersSnapshot | null = null;
        try {
            gap_layers = await buildGapLayersSnapshot({
                runtime: this.runtime,
                quotes,
                breadthAdvancePct: breadth.advance_pct,
                taiwanRegime: taiwan_regime.state,
                globalAssets,
                fetchedAt,
            });
            this.lastGapLayers = gap_layers;
        } catch (e) {
            warnings.push(
                `gap_layers_failed:${e instanceof Error ? e.message : 'error'}`,
            );
        }

        const overview: MarketContextOverview = {
            as_of: fetchedAt,
            version: MC_VERSION,
            global_regime,
            taiwan_regime,
            breadth,
            broad_universe,
            top_rotating: sectorRows
                .filter((s) => s.state !== 'INSUFFICIENT_COVERAGE')
                .slice(0, 12),
            institutional_eod,
            institutional_risk_proxy,
            gap_layers,
            creates_upstream_subscription: false,
            mutates_strategy: false,
            warnings,
        };
        this.lastOverview = overview;
        this.lastEvaluateAt = fetchedAt;
        return overview;
    }

    private broadReport(
        quotes: TwDayQuote[],
        fetchedAt: string,
    ): BroadUniverseReport {
        const size = quotes.length;
        const coverage =
            this.cfg.expected_universe_size > 0
                ? Math.min(100, (size / this.cfg.expected_universe_size) * 100)
                : 0;
        const sessionDate = quotes[0]?.date ?? null;
        const level = dayQuoteRealtimeLevel(sessionDate);
        return {
            broad_universe_size: size,
            expected_universe_size: this.cfg.expected_universe_size,
            coverage_pct: Math.round(coverage * 10) / 10,
            source: 'TWSE STOCK_DAY_ALL + TPEx daily close quotes',
            update_frequency: `evaluate ${this.cfg.evaluate_interval_sec}s; day-quote cache ≤${Math.round(this.cfg.broad_day_quote_max_age_ms / 60000)}m`,
            realtime_level: level,
            meta: buildMeta({
                source: 'TWSE_STOCK_DAY_ALL+TPEX_DAILY',
                source_type: 'broad_universe',
                observed_at: sessionDate ? `${sessionDate}T05:00:00.000Z` : null,
                published_at: sessionDate,
                fetched_at: fetchedAt,
                available: size > 0,
                coverage_pct: coverage,
                realtime_level: level,
            }),
        };
    }

    private buildConfirmCounts(
        industryOf: (s: string) => string | null,
    ): Map<string, SectorConfirmCounts> {
        const map = new Map<string, SectorConfirmCounts>();
        const bump = (sector: string, kind: 'c' | 'bp') => {
            const cur = map.get(sector) ?? {
                c_strong_count: 0,
                bp_strong_count: 0,
            };
            if (kind === 'c') cur.c_strong_count++;
            else cur.bp_strong_count++;
            map.set(sector, cur);
        };

        const cBatch = this.intradayRank.getLastBatch();
        for (const row of cBatch?.items ?? []) {
            if (row.state !== 'STRONG') continue;
            const ind = industryOf(row.symbol);
            if (ind) bump(ind, 'c');
        }

        const bpBatch = this.buyPressure?.getLastBatch();
        for (const row of bpBatch?.items ?? []) {
            const hot =
                row.states.includes('BUY_SURGE') ||
                row.states.includes('ASK_EATING') ||
                row.states.includes('VOLUME_BREAKOUT') ||
                row.primary_state === 'BUY_SURGE';
            if (!hot) continue;
            const ind = industryOf(row.symbol);
            if (ind) bump(ind, 'bp');
        }
        return map;
    }

    private indexChangePct(
        symbols: string[],
        _yahooHint: string,
    ): number | null {
        for (const s of symbols) {
            const st = this.runtime.getState(s);
            if (st && st.prev_close > 0 && st.last_price > 0) {
                return ((st.last_price - st.prev_close) / st.prev_close) * 100;
            }
        }
        const cached = this.globalMarket.getCached();
        if (cached) {
            const id = symbols.includes('IX0001') || symbols.includes('001')
                ? 'taiex'
                : 'tpex';
            const hit = cached.assets.find((a) => a.id === id);
            if (hit?.change_pct != null) return hit.change_pct;
        }
        return null;
    }

    private buildGlobalRegime(fetchedAt: string): GlobalRegime {
        const cached = this.globalMarket.getCached();
        if (cached?.context) {
            const re = cached.context.risk_environment;
            return {
                state:
                    re === 'RISK_ON' || re === 'RISK_OFF' || re === 'NEUTRAL'
                        ? re
                        : 'UNKNOWN',
                summary: cached.context.summary,
                meta: buildMeta({
                    source: 'YAHOO_GLOBAL_MI',
                    source_type: 'global_regime',
                    fetched_at: fetchedAt,
                    observed_at: new Date(cached.at).toISOString(),
                    available: true,
                    realtime_level: 'DELAYED',
                    confidence: 'MEDIUM',
                }),
            };
        }
        return {
            state: 'UNKNOWN',
            summary: null,
            meta: buildMeta({
                source: 'YAHOO_GLOBAL_MI',
                source_type: 'global_regime',
                fetched_at: fetchedAt,
                available: false,
                realtime_level: 'UNKNOWN',
                confidence: 'NONE',
            }),
        };
    }

    private institutionalEod(fetchedAt: string): InstitutionalEodBlock {
        return {
            label: 'INSTITUTIONAL_EOD',
            available: true,
            as_of: null,
            note: '三大法人為 T+1 / Previous Day，見既有 /api/v1/data/chips。非盤中即時外資身份。',
            realtime_level: 'PREVIOUS_DAY',
            meta: buildMeta({
                source: 'TWSE_T86+TPEX_INST',
                source_type: 'institutional_eod',
                fetched_at: fetchedAt,
                available: true,
                realtime_level: 'PREVIOUS_DAY',
                confidence: 'HIGH',
            }),
        };
    }

    private institutionalProxy(fetchedAt: string): InstitutionalRiskProxy {
        return {
            label: 'INSTITUTIONAL_RISK_PROXY',
            available: false,
            proxy: true,
            not_actual_foreign_identity: true,
            note: 'Phase 1 未啟用盤中外資 Proxy。禁止顯示「外資正在買進/撤退」。',
            meta: buildMeta({
                source: 'NONE',
                source_type: 'institutional_risk_proxy',
                fetched_at: fetchedAt,
                available: false,
                realtime_level: 'UNKNOWN',
                confidence: 'NONE',
            }),
        };
    }

    /** Test hooks */
    __getSectorEngine(): SectorRotationEngine {
        return this.sectors;
    }

    __setQuotesForTest(quotes: TwDayQuote[]): void {
        this.lastQuotes = quotes;
    }
}
