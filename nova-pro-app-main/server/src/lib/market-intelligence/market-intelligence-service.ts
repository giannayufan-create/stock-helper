// server/src/lib/market-intelligence/market-intelligence-service.ts
// Context layer only — NEVER mutates A/B/C/Heat/Rank/strategy scores.
// LIVE ONLY — do not feed into Historical Replay.

import type { IntradayRankService } from '../intraday-rank/service.ts';
import type { OpenGateV2Service } from '../open-gate-v2/service.ts';
import { scoreChips } from '../../ai/chips-signal.ts';
import { getChipRow } from '../tw-chips.ts';
import { buildIntelligenceBrief } from './ai/intelligence-summary.ts';
import { CompanyEventService } from './company-events/company-event-service.ts';
import {
    loadMarketIntelligenceConfig,
    miConfigHash,
    type MarketIntelligenceConfig,
} from './config.ts';
import { GlobalMarketService } from './global-market/global-market-service.ts';
import { trendArrow } from './heat-engine.ts';
import { NewsAggregator } from './news/news-aggregator.ts';
import { MarketIntelligenceRepository } from './repository/market-intelligence-repository.ts';
import { SectorHeatEngine } from './sector/sector-heat-engine.ts';
import { SectorMapper } from './sector/sector-mapper.ts';
import { ThemeHeatEngine } from './theme/theme-heat-engine.ts';
import { ThemeMapper } from './theme/theme-mapper.ts';
import type {
    AiBriefPayload,
    ChipsContext,
    LayerHealth,
    LayerHealthStatus,
    MarketIntelligenceHealth,
    MarketIntelligenceSnapshot,
    SectorHeatRow,
    SymbolIntelligence,
    ThemeHeatRow,
} from './types.ts';
import { MI_VERSION } from './types.ts';

export class MarketIntelligenceService {
    readonly cfg: MarketIntelligenceConfig;
    readonly configHash: string;
    readonly themeMapVersion: string;

    private global = new GlobalMarketService();
    private sectorMapper = new SectorMapper();
    private themeMapper = new ThemeMapper();
    private sectorHeat: SectorHeatEngine;
    private themeHeat: ThemeHeatEngine;
    private news: NewsAggregator;
    private events = new CompanyEventService();
    private repo = new MarketIntelligenceRepository();

    private snapshot: MarketIntelligenceSnapshot | null = null;
    private timers: NodeJS.Timeout[] = [];
    private lastPersistAt = 0;
    private lastAiAt = 0;
    private aiBrief: AiBriefPayload = {
        available: false,
        market_summary: null,
        risk_environment: null,
        hot_sectors: [],
        hot_themes: [],
        key_events: [],
        risks: [],
        generated_at: null,
        error: null,
        source: 'none',
    };

    private layerOk = {
        global: null as number | null,
        sector: null as number | null,
        theme: null as number | null,
        news: null as number | null,
        events: null as number | null,
        ai: null as number | null,
    };

    constructor(
        private intradayRank: IntradayRankService,
        private openGate: OpenGateV2Service,
        private geminiApiKey: string,
        cfg?: MarketIntelligenceConfig,
    ) {
        this.cfg = cfg ?? loadMarketIntelligenceConfig();
        this.configHash = miConfigHash(this.cfg);
        this.themeMapVersion = this.themeMapper.version;
        this.sectorHeat = new SectorHeatEngine(this.sectorMapper, this.cfg);
        this.themeHeat = new ThemeHeatEngine(this.themeMapper, this.cfg);
        this.news = new NewsAggregator(this.cfg);
    }

    start(): void {
        if (!this.cfg.enabled) {
            console.log('market-intelligence: disabled');
            return;
        }
        console.log(
            `market-intelligence: ${MI_VERSION} themes=${this.themeMapper.size()}`,
        );
        void this.tickHeat();
        void this.tickGlobal();
        void this.tickNewsAndEvents();
        void this.tickAi();

        this.timers.push(
            setInterval(
                () => void this.tickHeat(),
                this.cfg.refresh.sector_heat_sec * 1000,
            ),
        );
        this.timers.push(
            setInterval(
                () => void this.tickGlobal(),
                this.cfg.refresh.global_sec * 1000,
            ),
        );
        this.timers.push(
            setInterval(
                () => void this.tickNewsAndEvents(),
                this.cfg.refresh.news_sec * 1000,
            ),
        );
        this.timers.push(
            setInterval(
                () => void this.tickAi(),
                this.cfg.refresh.ai_brief_sec * 1000,
            ),
        );
    }

    stop(): void {
        for (const t of this.timers) clearInterval(t);
        this.timers = [];
    }

    /** Read-only cached snapshot for APIs. */
    getSnapshot(): MarketIntelligenceSnapshot | null {
        return this.snapshot;
    }

    getHealth(): MarketIntelligenceHealth {
        return this.buildHealth();
    }

    getSectors(): SectorHeatRow[] {
        return this.snapshot?.sectors ?? [];
    }

    getThemes(): ThemeHeatRow[] {
        return this.snapshot?.themes ?? [];
    }

    getSector(name: string): SectorHeatRow | null {
        const n = decodeURIComponent(name);
        return (
            this.getSectors().find(
                (s) => s.sector === n || s.id === n || s.name === n,
            ) ?? null
        );
    }

    getTheme(idOrName: string): ThemeHeatRow | null {
        const n = decodeURIComponent(idOrName);
        return (
            this.getThemes().find(
                (t) =>
                    t.theme_id === n ||
                    t.theme === n ||
                    t.name === n ||
                    t.aliases.includes(n),
            ) ?? null
        );
    }

    getBrief(): AiBriefPayload {
        return this.aiBrief;
    }

    getNews(limit = 20) {
        return this.news.getCachedHeadlines(limit);
    }

    async getSymbolIntelligence(symbol: string): Promise<SymbolIntelligence> {
        const code = symbol.trim();
        const snap = this.snapshot;
        const ranked = this.intradayRank.getSymbol(code);
        const sectorMem = this.sectorMapper.industryOf(code);
        const sectorRow = sectorMem
            ? this.getSector(sectorMem.industry)
            : null;
        const themes = this.themeMapper.themesOf(code).map((t) => {
            const row = this.getTheme(t.theme_id);
            return {
                theme_id: t.theme_id,
                name: t.name,
                heat: row?.heat_score ?? null,
                rank: row?.rank ?? null,
                confidence: row?.confidence ?? null,
            };
        });

        // Symbol news: may refresh if cache miss (detail page only — not overview poll)
        const news = await this.news.ensureSymbolNews(code, ranked?.name);

        let chips: ChipsContext = {
            available: false,
            freshness: 'T+1 / EOD',
            as_of: null,
            label: null,
            summary: null,
            foreign_net: null,
            trust_net: null,
            dealer_net: null,
            inst_net: null,
            margin_delta: null,
            note: '法人籌碼多為前一交易日公開資料，非盤中身份',
        };
        try {
            const row = await getChipRow(code);
            if (row) {
                const scored = scoreChips(row);
                chips = {
                    available: scored.available,
                    freshness: 'T+1 / EOD',
                    as_of: scored.asOf ?? null,
                    label: scored.label,
                    summary: scored.summary
                        ? `近期法人籌碼背景：${scored.summary}`
                        : null,
                    foreign_net: scored.foreignNet,
                    trust_net: scored.trustNet,
                    dealer_net: scored.dealerNet,
                    inst_net: scored.instNet,
                    margin_delta: scored.marginDelta,
                    note: '非盤中即時身份；僅供背景參考',
                };
            }
        } catch {
            // keep default
        }

        const open = this.openGate.getResult(code);

        return {
            symbol: code,
            name: ranked?.name ?? null,
            sector: sectorMem
                ? {
                      name: sectorMem.industry,
                      heat: sectorRow?.heat_score ?? null,
                      rank: sectorRow?.rank ?? null,
                      trend: trendArrow(sectorRow?.heat_delta_5m ?? null),
                      confidence: sectorRow?.confidence ?? null,
                  }
                : null,
            themes,
            market_context:
                snap?.market_context ?? {
                    risk_environment: 'UNKNOWN',
                    market_regime: null,
                    market_score: null,
                    semiconductor_context: '未知',
                    tech_context: '未知',
                    asia_context: '未知',
                    fx_context: '未知',
                    summary: '情報尚未就緒',
                },
            news,
            company_events: this.events.forSymbol(code),
            chips_context: chips,
            radar_context: ranked
                ? {
                      b_status:
                          ranked.open_gate_status ??
                          open?.signal_status ??
                          null,
                      b_score:
                          ranked.open_score ??
                          open?.final_open_score ??
                          null,
                      c_score: ranked.intraday_score,
                      stock_heat: ranked.heat_score,
                      rank: ranked.rank,
                      events: ranked.events ?? [],
                      state: ranked.state,
                  }
                : null,
            data_health: this.buildHealth(),
            generated_at: new Date().toISOString(),
            version: MI_VERSION,
        };
    }

    private async tickHeat(): Promise<void> {
        try {
            await this.sectorMapper.ensureLoaded();
            const batch = this.intradayRank.getLastBatch();
            const items = batch?.items ?? [];
            // Also include discovery/watch via getSymbol path — use batch only (no new subs)
            const sectors = this.sectorHeat.compute(items);
            const themes = this.themeHeat.compute(items);
            this.layerOk.sector = Date.now();
            this.layerOk.theme = Date.now();
            this.rebuildSnapshot({ sectors, themes });

            if (
                Date.now() - this.lastPersistAt >=
                this.cfg.refresh.persist_heat_sec * 1000
            ) {
                this.lastPersistAt = Date.now();
                for (const s of sectors.filter((x) => x.rank && x.rank <= 10)) {
                    this.repo.appendHeatSnapshot({
                        kind: 'sector',
                        ...s,
                        config_hash: this.configHash,
                        version: MI_VERSION,
                    });
                }
                for (const t of themes.filter((x) => x.rank && x.rank <= 10)) {
                    this.repo.appendHeatSnapshot({
                        kind: 'theme',
                        ...t,
                        config_hash: this.configHash,
                        version: MI_VERSION,
                    });
                }
            }
        } catch (err) {
            console.warn(
                'mi heat tick failed',
                err instanceof Error ? err.message : err,
            );
        }
    }

    private async tickGlobal(): Promise<void> {
        try {
            const { assets, context } = await this.global.refresh(true);
            const openBatch = this.openGate.getLastBatch();
            if (openBatch) {
                context.market_regime = openBatch.market_regime ?? null;
                context.market_score = openBatch.market_score ?? null;
            }
            this.layerOk.global = Date.now();
            this.rebuildSnapshot({
                global_markets: assets,
                market_context: context,
            });
            this.repo.appendGlobal({
                assets: assets.filter((a) => a.status === 'HEALTHY').length,
                risk: context.risk_environment,
                version: MI_VERSION,
            });
        } catch (err) {
            console.warn(
                'mi global tick failed',
                err instanceof Error ? err.message : err,
            );
        }
    }

    private async tickNewsAndEvents(): Promise<void> {
        try {
            const topSectors = (this.snapshot?.sectors ?? [])
                .filter((s) => s.eligible_for_ranking)
                .slice(0, 5)
                .map((s) => s.sector);
            const topThemes = (this.snapshot?.themes ?? [])
                .filter((t) => t.eligible_for_ranking)
                .slice(0, 5)
                .map((t) => ({
                    id: t.theme_id,
                    name: t.theme,
                    aliases: t.aliases,
                }));
            await this.news.refreshBackground({
                sectors: topSectors,
                themes: topThemes.length
                    ? topThemes
                    : this.themeMapper.all().slice(0, 5).map((t) => ({
                          id: t.theme_id,
                          name: t.name,
                          aliases: t.aliases,
                      })),
            });
            if (!this.news.getLastError()) this.layerOk.news = Date.now();
            await this.events.refresh();
            if (!this.events.getLastError()) this.layerOk.events = Date.now();
            this.rebuildSnapshot({
                headlines: this.news.getCachedHeadlines(
                    this.cfg.news.max_headlines_overview,
                ),
                company_events: this.events.getCached().slice(0, 40),
            });
        } catch (err) {
            console.warn(
                'mi news/events tick failed',
                err instanceof Error ? err.message : err,
            );
        }
    }

    private async tickAi(): Promise<void> {
        if (!this.cfg.ai_brief.enabled) return;
        if (!this.snapshot) return;
        if (
            Date.now() - this.lastAiAt <
            this.cfg.refresh.ai_brief_sec * 1000 * 0.9
        ) {
            return;
        }
        try {
            const brief = await buildIntelligenceBrief({
                apiKey: this.geminiApiKey,
                snapshot: this.snapshot,
            });
            this.aiBrief = brief;
            this.lastAiAt = Date.now();
            if (brief.available) {
                this.layerOk.ai = Date.now();
                this.repo.appendDailyBrief({
                    ...brief,
                    version: MI_VERSION,
                    config_hash: this.configHash,
                });
            }
            this.rebuildSnapshot({ ai_summary: brief });
        } catch (err) {
            this.aiBrief = {
                ...this.aiBrief,
                available: false,
                error: err instanceof Error ? err.message : String(err),
                source: 'none',
            };
            this.rebuildSnapshot({ ai_summary: this.aiBrief });
        }
    }

    private rebuildSnapshot(
        patch: Partial<MarketIntelligenceSnapshot>,
    ): void {
        const base: MarketIntelligenceSnapshot = this.snapshot ?? {
            generated_at: new Date().toISOString(),
            source_mode: 'live',
            market_context: {
                risk_environment: 'UNKNOWN',
                market_regime: null,
                market_score: null,
                semiconductor_context: '未知',
                tech_context: '未知',
                asia_context: '未知',
                fx_context: '未知',
                summary: '初始化中',
            },
            global_markets: [],
            sectors: [],
            themes: [],
            headlines: [],
            company_events: [],
            ai_summary: this.aiBrief,
            data_health: this.buildHealth(),
            version: MI_VERSION,
            theme_map_version: this.themeMapVersion,
            config_hash: this.configHash,
            material_info_available: false,
            material_info_coverage: 'PARTIAL',
        };
        this.snapshot = {
            ...base,
            ...patch,
            generated_at: new Date().toISOString(),
            source_mode: 'live',
            version: MI_VERSION,
            theme_map_version: this.themeMapVersion,
            config_hash: this.configHash,
            material_info_available: this.events.material_info_available,
            material_info_coverage: this.events.material_info_coverage,
            data_health: this.buildHealth(),
            ai_summary: patch.ai_summary ?? this.aiBrief,
        };
    }

    private layer(
        last: number | null,
        source: string,
        error: string | null,
        staleAfterSec: number,
    ): LayerHealth {
        if (error && !last) {
            return {
                status: 'ERROR',
                last_success_at: null,
                age_sec: null,
                source,
                error,
            };
        }
        if (!last) {
            return {
                status: 'UNAVAILABLE',
                last_success_at: null,
                age_sec: null,
                source,
                error,
            };
        }
        const age = Math.round((Date.now() - last) / 1000);
        let status: LayerHealthStatus = 'HEALTHY';
        if (age > staleAfterSec * 2) status = 'UNAVAILABLE';
        else if (age > staleAfterSec) status = 'STALE';
        else if (error) status = 'DEGRADED';
        return {
            status,
            last_success_at: new Date(last).toISOString(),
            age_sec: age,
            source,
            error,
        };
    }

    private buildHealth(): MarketIntelligenceHealth {
        const global_market = this.layer(
            this.layerOk.global,
            'yahoo',
            this.global.getLastError(),
            this.cfg.refresh.global_sec * 3,
        );
        const sector = this.layer(
            this.layerOk.sector,
            'intraday_rank+openapi',
            null,
            this.cfg.refresh.sector_heat_sec * 4,
        );
        const theme = this.layer(
            this.layerOk.theme,
            'theme_map+intraday_rank',
            null,
            this.cfg.refresh.theme_heat_sec * 4,
        );
        const news = this.layer(
            this.layerOk.news,
            'google_news_rss',
            this.news.getLastError(),
            this.cfg.refresh.news_sec * 2,
        );
        const company_events = this.layer(
            this.layerOk.events,
            'twse_announcement+openapi',
            this.events.getLastError(),
            this.cfg.refresh.company_events_sec * 2,
        );
        const ai_summary = this.layer(
            this.layerOk.ai,
            'gemini',
            this.aiBrief.error,
            this.cfg.refresh.ai_brief_sec * 2,
        );
        const statuses = [
            global_market.status,
            sector.status,
            theme.status,
            news.status,
            company_events.status,
        ];
        let overall: LayerHealthStatus = 'HEALTHY';
        if (statuses.every((s) => s === 'UNAVAILABLE' || s === 'ERROR')) {
            overall = 'UNAVAILABLE';
        } else if (statuses.some((s) => s === 'STALE' || s === 'DEGRADED')) {
            overall = 'DEGRADED';
        } else if (statuses.some((s) => s === 'UNAVAILABLE')) {
            overall = 'DEGRADED';
        }
        return {
            global_market,
            sector,
            theme,
            news,
            company_events,
            ai_summary,
            overall,
        };
    }
}
