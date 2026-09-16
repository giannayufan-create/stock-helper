// server/src/lib/event-intelligence/event-intelligence-service.ts
// Context only — NEVER mutates A/B/C / Heat / Rank / Buy Pressure.
// NEVER creates Shioaji upstream subscriptions.
// AI must NOT decide confirmation (deterministic only).

import type { BuyPressureService } from '../buy-pressure/buy-pressure-service.ts';
import type { IntradayRankService } from '../intraday-rank/service.ts';
import type { MarketContextRuntime } from '../market-context/market-context-runtime.ts';
import { GlobalMarketService } from '../market-intelligence/global-market/global-market-service.ts';
import type { MarketRuntime } from '../market-runtime/index.ts';
import { SectorMapper } from '../market-intelligence/sector/sector-mapper.ts';
import { clusterEvents } from './cluster.ts';
import { confirmEvent } from './confirmation.ts';
import { DEFAULT_EI_CONFIG, type EventIntelligenceConfig } from './config.ts';
import { CompanyExposureMap } from './exposure-map.ts';
import { isToastableFresh } from './freshness.ts';
import { buildImpactGraph } from './impact-graph.ts';
import {
    ingestGdeltEvents,
    ingestGoogleNewsEvents,
    ingestSyntheticForTest,
} from './ingest.ts';
import { EventRepository } from './repository.ts';
import type {
    CompanyConfirmationResult,
    CompanyExposureProfile,
    EventImpactGraph,
    EventSummaryBlock,
    EventType,
    MarketConfirmationResult,
    MarketEvent,
} from './types.ts';
import { EI_VERSION } from './types.ts';

export class EventIntelligenceService {
    readonly cfg: EventIntelligenceConfig;
    private timer: ReturnType<typeof setInterval> | null = null;
    private events: MarketEvent[] = [];
    private confirmations = new Map<string, MarketConfirmationResult>();
    private impacts = new Map<string, EventImpactGraph>();
    private repo: EventRepository;
    private exposure = new CompanyExposureMap();
    private mapper = new SectorMapper();
    private globalMarket = new GlobalMarketService();
    private lastEvaluateAt: string | null = null;
    private lastError: string | null = null;
    private lastOilChangePct: number | null = null;

    constructor(
        private marketContext: MarketContextRuntime | null,
        private intradayRank: IntradayRankService,
        private buyPressure: BuyPressureService | null,
        _runtime: MarketRuntime | null,
        storePath: string,
        cfg?: EventIntelligenceConfig,
    ) {
        this.cfg = cfg ?? { ...DEFAULT_EI_CONFIG };
        this.repo = new EventRepository(storePath);
        this.events = this.repo.load();
        void this.mapper.ensureLoaded().then(() => {
            this.exposure.setIndustryResolver(
                (s) => this.mapper.industryOf(s)?.industry ?? null,
            );
        });
    }

    start(): void {
        if (!this.cfg.enabled || this.timer) return;
        void this.evaluate();
        this.timer = setInterval(
            () => void this.evaluate(),
            Math.max(30, this.cfg.evaluate_interval_sec) * 1000,
        );
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    getHealth() {
        return {
            enabled: this.cfg.enabled,
            status: this.lastError
                ? 'DEGRADED'
                : this.events.length
                  ? 'HEALTHY'
                  : 'PARTIAL',
            version: EI_VERSION,
            last_evaluate_at: this.lastEvaluateAt,
            event_count: this.events.length,
            material_info_available: false,
            creates_upstream_subscription: false as const,
            mutates_strategy: false as const,
            note: 'Event intelligence is context-only; confirmation is deterministic; no A/B/C/BP mutation.',
            last_error: this.lastError,
        };
    }

    list(query: {
        event_type?: string;
        sector?: string;
        symbol?: string;
        confidence?: string;
        status?: string;
        since?: string;
        limit?: number;
    } = {}): MarketEvent[] {
        let items = [...this.events];
        if (query.event_type) {
            items = items.filter((e) => e.event_type === query.event_type);
        }
        if (query.confidence) {
            items = items.filter((e) => e.confidence === query.confidence);
        }
        if (query.status) {
            const conf = this.confirmations.get.bind(this.confirmations);
            if (query.status.startsWith('EVENT_')) {
                items = items.filter((e) => conf(e.event_id)?.status === query.status);
            } else {
                items = items.filter((e) => e.status === query.status);
            }
        }
        if (query.since) {
            const t = Date.parse(query.since);
            items = items.filter(
                (e) => Date.parse(e.published_at ?? e.fetched_at) >= t,
            );
        }
        if (query.sector) {
            items = items.filter((e) => {
                const g = this.impacts.get(e.event_id);
                return g?.sector_hypotheses.some((h) =>
                    h.sector_or_theme.includes(query.sector!),
                );
            });
        }
        if (query.symbol) {
            items = items.filter((e) => e.companies.includes(query.symbol!));
        }
        items.sort((a, b) => {
            const ta = Date.parse(a.latest_update_at) || 0;
            const tb = Date.parse(b.latest_update_at) || 0;
            return tb - ta;
        });
        const limit = Math.max(1, Math.min(100, query.limit ?? 30));
        return items.slice(0, limit);
    }

    getEvent(id: string): MarketEvent | null {
        return this.events.find((e) => e.event_id === id || e.cluster_id === id) ?? null;
    }

    getImpact(id: string): EventImpactGraph | null {
        const ev = this.getEvent(id);
        if (!ev) return null;
        return this.impacts.get(ev.event_id) ?? buildImpactGraph(ev);
    }

    getConfirmation(id: string): MarketConfirmationResult | null {
        const ev = this.getEvent(id);
        if (!ev) return null;
        return this.confirmations.get(ev.event_id) ?? null;
    }

    getActive(): MarketEvent[] {
        return this.list({ limit: 20 }).filter(
            (e) => e.status === 'ACTIVE' || e.status === 'WATCH',
        );
    }

    getExposure(symbol: string, eventType?: EventType): CompanyExposureProfile {
        const type = eventType ?? 'OTHER';
        return this.exposure.profile(symbol, type);
    }

    getCompanyConfirmation(
        symbol: string,
        eventId: string,
    ): CompanyConfirmationResult | null {
        const ev = this.getEvent(eventId);
        if (!ev) return null;
        const exp = this.exposure.profile(symbol, ev.event_type);
        const mc = this.confirmations.get(ev.event_id);
        const bp = this.buyPressure?.getSymbol(symbol);
        const c = this.intradayRank.getSymbol(symbol);
        const reasons: string[] = [];
        let status: CompanyConfirmationResult['status'] = 'COMPANY_UNCONFIRMED';

        if (exp.overall_confidence === 'LOW') {
            reasons.push('曝險證據不足或僅產業標籤');
            status = 'COMPANY_UNCONFIRMED';
        } else if (
            exp.overall_confidence === 'HIGH' &&
            mc?.status === 'EVENT_MARKET_CONFIRMED' &&
            ((bp?.buy_pressure_score ?? 0) >= 70 || (c?.intraday_score ?? 0) >= 70)
        ) {
            status = 'COMPANY_CONFIRMED';
            reasons.push('曝險證據充分且市場已確認反應');
            if (bp) reasons.push(`BP ${Math.round(bp.buy_pressure_score)}`);
            if (c) reasons.push(`C score ${Math.round(c.intraday_score)}`);
        } else {
            status = 'COMPANY_WATCH';
            reasons.push('曝險存在，等待／觀察市場反應');
        }

        return {
            symbol,
            event_id: ev.event_id,
            status,
            exposure_confidence: exp.overall_confidence,
            reasons,
        };
    }

    getEventSummary(): EventSummaryBlock {
        const active = this.getActive();
        let confirmed = 0;
        let watch = 0;
        for (const e of active) {
            const s = this.confirmations.get(e.event_id)?.status;
            if (s === 'EVENT_MARKET_CONFIRMED') confirmed++;
            if (s === 'EVENT_WATCH' || s === 'EVENT_PARTIAL_CONFIRMED') watch++;
        }
        return {
            active_count: active.length,
            confirmed_count: confirmed,
            watch_count: watch,
            top_events: active.slice(0, 8),
            creates_upstream_subscription: false,
            mutates_strategy: false,
        };
    }

    async evaluate(): Promise<void> {
        try {
            this.lastError = null;
            await this.mapper.ensureLoaded().catch(() => undefined);
            this.exposure.setIndustryResolver(
                (s) => this.mapper.industryOf(s)?.industry ?? null,
            );

            const [news, gdelt] = await Promise.all([
                ingestGoogleNewsEvents(this.cfg),
                ingestGdeltEvents(this.cfg),
            ]);
            const mergedRaw = [...this.events, ...news, ...gdelt];
            const clustered = clusterEvents(mergedRaw, this.cfg);

            // Dedupe by event_id keeping richest sources_count
            const byId = new Map<string, MarketEvent>();
            for (const e of clustered) {
                const prev = byId.get(e.event_id);
                if (!prev || e.sources_count > prev.sources_count) byId.set(e.event_id, e);
            }
            let events = [...byId.values()]
                .sort(
                    (a, b) =>
                        Date.parse(b.latest_update_at) -
                        Date.parse(a.latest_update_at),
                )
                .slice(0, this.cfg.max_stored_events);

            // Refresh confirmation from Market Context (read-only)
            if (!this.marketContext?.getOverview()) {
                await this.marketContext?.evaluate().catch(() => undefined);
            }
            const sectors = this.marketContext?.getSectors() ?? [];

            // Commodity context (Yahoo WTI) — boosts channel confidence only
            try {
                const gm = await this.globalMarket.refresh();
                const wti = gm.assets.find((a) => a.id === 'wti');
                this.lastOilChangePct =
                    wti?.change_pct != null && Number.isFinite(wti.change_pct)
                        ? wti.change_pct
                        : null;
            } catch {
                this.lastOilChangePct = null;
            }

            this.impacts.clear();
            this.confirmations.clear();
            for (const ev of events) {
                const graph = buildImpactGraph(ev, {
                    oil_change_pct: this.lastOilChangePct,
                });
                this.impacts.set(ev.event_id, graph);
                const conf = confirmEvent({
                    event: ev,
                    graph,
                    sectors,
                    cfg: this.cfg,
                });
                this.confirmations.set(ev.event_id, conf);

                // Notification candidate — not every headline
                const toastOk = isToastableFresh(ev.freshness);
                const highPri = ev.priority === 'HIGH' || ev.priority === 'CRITICAL';
                const confirmed =
                    conf.status === 'EVENT_MARKET_CONFIRMED' ||
                    conf.status === 'EVENT_PARTIAL_CONFIRMED';
                ev.notification_candidate =
                    toastOk &&
                    highPri &&
                    ev.confidence !== 'LOW' &&
                    (ev.event_relevance >= 75 || confirmed) &&
                    ev.taiwan_relevance >= 40;
            }

            this.events = events;
            this.repo.save(events);
            this.lastEvaluateAt = new Date().toISOString();
        } catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
        }
    }

    /** Test helpers */
    __reset(): void {
        this.events = [];
        this.confirmations.clear();
        this.impacts.clear();
    }

    __inject(ev: MarketEvent): void {
        this.events.push(ev);
        const g = buildImpactGraph(ev);
        this.impacts.set(ev.event_id, g);
    }

    __confirmWithSectors(
        ev: MarketEvent,
        sectors: Parameters<typeof confirmEvent>[0]['sectors'],
    ): MarketConfirmationResult {
        const g = buildImpactGraph(ev);
        const conf = confirmEvent({ event: ev, graph: g, sectors, cfg: this.cfg });
        this.confirmations.set(ev.event_id, conf);
        this.impacts.set(ev.event_id, g);
        return conf;
    }

    __synthetic = ingestSyntheticForTest;
    __exposure = () => this.exposure;
    __cluster = clusterEvents;
}
