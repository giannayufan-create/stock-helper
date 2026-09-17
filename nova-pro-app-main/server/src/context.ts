// server/src/context.ts — shared wiring passed to every route module.

import type { Config } from './config.ts';
import type { IntradayRankService } from './lib/intraday-rank/service.ts';
import type { MarketIntelligenceService } from './lib/market-intelligence/index.ts';
import type { BrokerIntelligenceService } from './lib/broker-intelligence/index.ts';
import type { BuyPressureService } from './lib/buy-pressure/index.ts';
import type { WebNotificationService } from './lib/web-notifications/index.ts';
import type { MarketContextRuntime } from './lib/market-context/index.ts';
import type { EventIntelligenceService } from './lib/event-intelligence/index.ts';
import type { ResearchRepositories } from './lib/research-persistence/index.ts';
import type { ContextResearchService } from './lib/context-research/index.ts';
import type { MarketRuntime } from './lib/market-runtime/index.ts';
import type { MarketCalendarService } from './lib/market-calendar/index.ts';
import type { LiveAcceptanceService } from './lib/live-acceptance/index.ts';
import type { DecisionSummaryService } from './lib/decision-summary/index.ts';
import type { SessionAutonomyService } from './lib/session-autonomy/index.ts';
import type { AiInterpretationService } from './lib/ai-interpretation/index.ts';
import type { RadarQualityService } from './lib/radar-quality/index.ts';
import type { OpenGateV2Service } from './lib/open-gate-v2/service.ts';
import type { MarketManager } from './providers/manager.ts';
import type { TradingProvider } from './providers/trading.ts';
import type { RuntimeConfigStore } from './runtime-config.ts';
import type { SseHub } from './sse/hub.ts';
import type { SubscriptionRegistry } from './sse/subscriptions.ts';
import type { WatchlistStore } from './watchlist-store.ts';

export interface AppContext {
    config: Config;
    market: MarketManager;
    trading: TradingProvider;
    hub: SseHub;
    /**
     * Downstream UI SSE client registry — acquires/releases UI_VIEW via
     * marketRuntime. NEVER owns Shioaji upstream directly.
     */
    subs: SubscriptionRegistry;
    watchlists: WatchlistStore;
    runtimeConfig: RuntimeConfigStore;
    /** Upstream market ownership (engine + SubscriptionManager). */
    marketRuntime: MarketRuntime;
    openGateV2: OpenGateV2Service;
    intradayRank: IntradayRankService;
    /** Context layer only — never mutates A/B/C scores. */
    marketIntelligence: MarketIntelligenceService | null;
    /** Broker/branch context — never mutates A/B/C; no fabricated branches. */
    brokerIntelligence: BrokerIntelligenceService | null;
    /** Buy pressure context — never mutates A/B/C; no new upstream subs. */
    buyPressure: BuyPressureService | null;
    /** Web notifications — consumes BP events only. */
    webNotifications: WebNotificationService | null;
    /** Market context — broad universe / regime / sector rotation; no strategy mutation. */
    marketContext: MarketContextRuntime | null;
    /** Event intelligence — detection / impact hypothesis / confirmation; no strategy mutation. */
    eventIntelligence: EventIntelligenceService | null;
    /** Context research — snapshot attribution / shadow cohorts; no strategy mutation. */
    contextResearch: ContextResearchService | null;
    /** Research persistence (signals/outcomes) — jsonl | firestore | dual. */
    researchRepos: ResearchRepositories | null;
    /** Market calendar — expiry / corporate actions / gap reference; no strategy mutation. */
    marketCalendar: MarketCalendarService | null;
    /** Full Live Acceptance sampler — observe only. */
    liveAcceptance: LiveAcceptanceService | null;
    /** Decision Summary — Decision Support Layer; never mutates C/BP/strategy. */
    decisionSummary: DecisionSummaryService | null;
    /** Headless session FSM + overnight snapshots — never requires UI. */
    sessionAutonomy: SessionAutonomyService | null;
    /** AI Interpretation — explanation layer only; never mutates scores/rank. */
    aiInterpretation: AiInterpretationService | null;
    /** Radar Quality — eligibility / momentum / focus / institutional continuation; support only. */
    radarQuality: RadarQualityService | null;
    startedAt: number;
}

export const SERVER_VERSION = '0.1.0';
