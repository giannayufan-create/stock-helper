// server/src/index.ts — entry point: pick providers from env/saved config
// and listen.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './load-env.ts';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import type { AppContext } from './context.ts';
import { FugleMarketDataProvider } from './providers/fugle/market.ts';
import { MarketManager } from './providers/manager.ts';
import { MockMarketDataProvider } from './providers/mock/market.ts';
import { ShioajiMarketDataProvider } from './providers/shioaji/market.ts';
import { MockTradingProvider } from './providers/mock/trading.ts';
import type { TradingProvider } from './providers/trading.ts';
import { RuntimeConfigStore } from './runtime-config.ts';
import { SseHub } from './sse/hub.ts';
import { SubscriptionRegistry } from './sse/subscriptions.ts';
import { WatchlistStore } from './watchlist-store.ts';
import { OpenGateV2Service } from './lib/open-gate-v2/service.ts';
import { OpenGateRuntimeCoordinator } from './lib/open-gate-v2/open-gate-runtime-coordinator.ts';
import { IntradayRankService } from './lib/intraday-rank/service.ts';
import { MarketIntelligenceService } from './lib/market-intelligence/index.ts';
import { BrokerIntelligenceService } from './lib/broker-intelligence/index.ts';
import { BuyPressureService } from './lib/buy-pressure/index.ts';
import { WebNotificationService } from './lib/web-notifications/index.ts';
import { MarketContextRuntime } from './lib/market-context/index.ts';
import { EventIntelligenceService } from './lib/event-intelligence/index.ts';
import { ContextResearchService } from './lib/context-research/index.ts';
import { createResearchRepositories } from './lib/research-persistence/index.ts';
import { MarketCalendarService } from './lib/market-calendar/index.ts';
import {
    LiveAcceptanceService,
    ReadinessTracker,
} from './lib/live-acceptance/index.ts';
import { DecisionSummaryService } from './lib/decision-summary/index.ts';
import { SessionAutonomyService } from './lib/session-autonomy/index.ts';
import { AiInterpretationService } from './lib/ai-interpretation/index.ts';
import { RadarQualityService } from './lib/radar-quality/index.ts';
import { MarketRuntime } from './lib/market-runtime/index.ts';
import { LiveOutcomeTracker } from './lib/signal-outcome/index.ts';
import { StrategySignalBridge } from './lib/strategy-signal/index.ts';

loadEnvFile();

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');

async function main(): Promise<void> {
    ReadinessTracker.markServerStarted();
    const config = loadConfig();
    console.log(
        `ai: gemini=${config.geminiApiKey ? 'on' : 'off'} analyzer=${config.analyzerUrl || 'off'}`,
    );
    const runtimeConfig = new RuntimeConfigStore(join(dataDir, 'config.json'), {
        marketProvider: config.marketProvider,
        fugleApiKey: config.fugleApiKey,
    });

    const manager = new MarketManager();
    const saved = runtimeConfig.get();
    let started = false;

    // Prefer SHIOAJI_ENABLED (new name) so Render need not change MARKET_PROVIDER
    if (
        config.shioajiEnabled ||
        config.marketProvider === 'shioaji' ||
        (saved.marketProvider === 'shioaji' && config.shioajiApiKey)
    ) {
        if (!config.shioajiApiKey || !config.shioajiSecretKey) {
            console.warn(
                'market: shioaji selected but SHIOAJI_API_KEY/SECRET missing',
            );
        } else {
            // Ensure bridge process can see the same keys (same container)
            process.env.SHIOAJI_API_KEY = config.shioajiApiKey;
            process.env.SHIOAJI_SECRET_KEY = config.shioajiSecretKey;
            process.env.SHIOAJI_BRIDGE_URL = config.shioajiBridgeUrl;
            const shioaji = new ShioajiMarketDataProvider();
            try {
                await shioaji.init();
                manager.start(shioaji, 'shioaji');
                started = true;
                runtimeConfig.set({ marketProvider: 'shioaji' });
                console.log('market: shioaji (永豐行情)');
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`shioaji init failed (${msg}) — falling back`);
                if (/fetch failed|ECONNREFUSED|AbortError/i.test(msg)) {
                    console.warn(
                        `shioaji bridge unreachable at ${config.shioajiBridgeUrl} — Render must run Docker (start-cloud.sh), not native Node`,
                    );
                }
            }
        }
    }

    const fugleKey = saved.fugleApiKey || config.fugleApiKey;
    if (!started && fugleKey) {
        const fugle = new FugleMarketDataProvider(fugleKey);
        try {
            await fugle.init();
            manager.start(fugle, 'fugle');
            started = true;
            runtimeConfig.set({ marketProvider: 'fugle', fugleApiKey: fugleKey });
            console.log('market: fugle (fallback)');
        } catch (err) {
            console.warn(
                `fugle init failed (${err instanceof Error ? err.message : err}) — falling back to mock`,
            );
        }
    }
    if (!started) {
        const mock = new MockMarketDataProvider();
        await mock.init();
        manager.start(mock, 'mock');
    }

    let trading: TradingProvider;
    switch (config.tradeProvider) {
        case 'fubon': {
            const { FubonTradingProvider } = await import(
                './providers/fubon/trading.ts'
            );
            trading = new FubonTradingProvider(config);
            break;
        }
        case 'nova': {
            const { NovaTradingProvider } = await import(
                './providers/nova/trading.ts'
            );
            trading = new NovaTradingProvider(config);
            break;
        }
        default:
            // paper trading priced off the live market feed (mock or fugle)
            trading = new MockTradingProvider(manager);
    }

    await trading.init();

    const marketRuntime = new MarketRuntime(manager);
    marketRuntime.start();
    ReadinessTracker.markMarketRuntimeReady();

    manager.setUpstreamDemand({
        acquire: (key) =>
            marketRuntime.acquireStocks([key.code], 'USER_MONITOR'),
        release: (key) =>
            marketRuntime.releaseStocks([key.code], 'USER_MONITOR'),
    });

    const researchRepos = createResearchRepositories();
    console.log(
        `research-persistence: configured=${researchRepos.configured_mode} effective_repository_mode=${researchRepos.mode}`,
    );
    if (
        researchRepos.mode === 'firestore' ||
        researchRepos.mode === 'dual'
    ) {
        ReadinessTracker.markFirebaseReady();
    }
    void researchRepos.hydrate().catch((err) => {
        console.warn(
            '[research-persistence] hydrate failed:',
            err instanceof Error ? err.message : String(err),
        );
    });

    const signalBridge = new StrategySignalBridge(researchRepos.signals);
    signalBridge.setContext({
        source_mode: 'live',
        data_resolution: 'tick',
        universe_source: 'live_scanner',
        learning_eligible: true,
    });

    // Research only: samples forward price path so signals get measured
    // win-rate instead of staying unverified. Never feeds back into B/C.
    const outcomeTracker = new LiveOutcomeTracker(
        { getState: (s) => marketRuntime.getState(s) },
        researchRepos.outcomes,
    );
    signalBridge.onSignalCreated((sig) => outcomeTracker.track(sig));
    outcomeTracker.start();
    console.log(
        `signal-outcome: live tracker on interval=${outcomeTracker.cfg.sample_interval_sec}s max_track=${outcomeTracker.cfg.max_track_minutes}min`,
    );

    const openGateV2 = new OpenGateV2Service(
        manager,
        marketRuntime,
        signalBridge,
        dataDir,
    );
    openGateV2.start();
    const openGateRuntime = new OpenGateRuntimeCoordinator(openGateV2);
    // Do NOT await onBoot before listen — ensureAPoolHeadless may run a
    // full screener / activatePool and block Render port detection (502).
    const intradayRank = new IntradayRankService(
        manager,
        marketRuntime,
        openGateV2,
        signalBridge,
    );
    intradayRank.start();

    const marketCalendar = new MarketCalendarService();
    marketCalendar.start();
    openGateV2.setMarketCalendar(marketCalendar);
    intradayRank.setMarketCalendar(marketCalendar);

    if (manager.name() === 'shioaji' || manager.name() === 'fugle') {
        ReadinessTracker.markShioajiConnected();
    }
    if (manager.contractCount() > 0) {
        ReadinessTracker.markContractsReady();
    }

    const marketIntelligence = new MarketIntelligenceService(
        intradayRank,
        openGateV2,
        config.geminiApiKey,
    );
    marketIntelligence.start();

    const brokerIntelligence = new BrokerIntelligenceService(intradayRank);
    console.log(
        `broker-intelligence: ${brokerIntelligence.getHealth().status} provider=${brokerIntelligence.getProvider().id}`,
    );

    const hub = new SseHub();

    const buyPressure = new BuyPressureService(intradayRank, marketRuntime);
    const webNotifications = new WebNotificationService(
        join(dataDir, 'web_notifications.json'),
        hub,
    );
    buyPressure.setNotificationSink(webNotifications);
    buyPressure.start();
    console.log(
        `buy-pressure: ${buyPressure.getHealth().status} interval=${buyPressure.cfg.evaluate_interval_sec}s`,
    );
    console.log(`web-notifications: enabled max=${webNotifications.cfg.max_stored}`);

    const marketContext = new MarketContextRuntime(
        marketRuntime,
        intradayRank,
        buyPressure,
    );
    marketContext.start();
    console.log(
        `market-context: ${marketContext.getHealth().status} interval=${marketContext.cfg.evaluate_interval_sec}s`,
    );

    const eventIntelligence = new EventIntelligenceService(
        marketContext,
        intradayRank,
        buyPressure,
        marketRuntime,
        join(dataDir, 'events.json'),
    );
    eventIntelligence.start();
    console.log(
        `event-intelligence: ${eventIntelligence.getHealth().status} interval=${eventIntelligence.cfg.evaluate_interval_sec}s`,
    );

    const contextResearch = new ContextResearchService(
        marketContext,
        eventIntelligence,
        researchRepos.signals,
        researchRepos.outcomes,
    );
    signalBridge.setContext({
        captureContext: ({ symbol, signalTime }) =>
            contextResearch.captureForSignal({
                symbol,
                signalTime,
                sourceMode: 'live',
            }),
    });
    console.log(
        `context-research: ${contextResearch.getHealth().version} (shadow/research only)`,
    );

    const decisionSummary = new DecisionSummaryService(
        intradayRank,
        buyPressure,
        marketContext,
        eventIntelligence,
    );
    decisionSummary.start();
    console.log(
        `decision-summary: ${decisionSummary.getHealth().status} interval=${decisionSummary.cfg.evaluate_interval_sec}s (support only)`,
    );

    const sessionAutonomy = new SessionAutonomyService({
        dataDir,
        marketContext,
        researchRepos,
        getNotificationCandidateCount: () =>
            webNotifications?.list({ limit: 200 }).length ?? 0,
        onPreopen: async () => {
            await openGateRuntime.onPreopen();
        },
        onCashLive: async () => {
            // OpenGate already cadence-evaluates; ensure pool still active after open
            if (openGateV2.getAPoolMeta().count === 0) {
                await openGateRuntime.onRestart();
            }
        },
    });
    sessionAutonomy.start(15_000);
    console.log(
        `session-autonomy: ${sessionAutonomy.getState()} (headless FSM, no UI_VIEW)`,
    );

    const aiInterpretation = new AiInterpretationService(
        intradayRank,
        buyPressure,
        decisionSummary,
        marketContext,
        eventIntelligence,
        config.geminiApiKey,
    );
    console.log(
        `ai-interpretation: ${aiInterpretation.getHealth().version} gemini=${aiInterpretation.getHealth().gemini ? 'on' : 'off'} (explanation only)`,
    );

    const radarQuality = new RadarQualityService(
        intradayRank,
        buyPressure,
        marketContext,
        decisionSummary,
    );
    radarQuality.start();
    console.log(
        `radar-quality: ${radarQuality.getHealth().status} interval=${radarQuality.cfg.evaluate_interval_sec}s (support only)`,
    );

    const ctx: AppContext = {
        config,
        market: manager,
        trading,
        hub,
        subs: new SubscriptionRegistry(marketRuntime),
        watchlists: new WatchlistStore(join(dataDir, 'watchlists.json')),
        runtimeConfig,
        marketRuntime,
        openGateV2,
        intradayRank,
        marketIntelligence,
        brokerIntelligence,
        buyPressure,
        webNotifications,
        marketContext,
        eventIntelligence,
        contextResearch,
        researchRepos,
        marketCalendar,
        liveAcceptance: null,
        decisionSummary,
        sessionAutonomy,
        aiInterpretation,
        radarQuality,
        outcomeTracker,
        startedAt: Date.now(),
    };
    const liveAcceptance = new LiveAcceptanceService(ctx, dataDir);
    ctx.liveAcceptance = liveAcceptance;
    liveAcceptance.start();
    webNotifications.setAcceptanceObserver((opts) => {
        liveAcceptance.noteNotification(opts);
    });

    const app = await buildApp(ctx);
    console.log(
        `binding HTTP on ${config.host}:${config.port} (PORT env=${process.env.PORT ?? 'unset'})`,
    );
    await app.listen({ port: config.port, host: config.host });
    console.log(
        `nova-pro-server listening on http://${config.host}:${config.port}` +
            ` (market=${manager.name()}, trade=${config.tradeProvider})`,
    );

    // After port is open — headless A-pool hydrate / screener (may take minutes)
    void openGateRuntime.onBoot().catch((err) => {
        console.warn(
            '[open-gate-runtime] boot ensure failed:',
            err instanceof Error ? err.message : String(err),
        );
    });
}

main().catch((err) => {
    console.error('fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
});
