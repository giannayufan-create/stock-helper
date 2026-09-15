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
import { IntradayRankService } from './lib/intraday-rank/service.ts';
import { MarketIntelligenceService } from './lib/market-intelligence/index.ts';
import { MarketRuntime } from './lib/market-runtime/index.ts';
import { StrategySignalBridge } from './lib/strategy-signal/index.ts';

loadEnvFile();

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');

async function main(): Promise<void> {
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

    manager.setUpstreamDemand({
        acquire: (key) =>
            marketRuntime.acquireStocks([key.code], 'USER_MONITOR'),
        release: (key) =>
            marketRuntime.releaseStocks([key.code], 'USER_MONITOR'),
    });

    const signalBridge = new StrategySignalBridge();
    signalBridge.setContext({
        source_mode: 'live',
        data_resolution: 'tick',
        universe_source: 'live_scanner',
        learning_eligible: true,
    });

    const openGateV2 = new OpenGateV2Service(
        manager,
        marketRuntime,
        signalBridge,
    );
    openGateV2.start();
    const intradayRank = new IntradayRankService(
        manager,
        marketRuntime,
        openGateV2,
        signalBridge,
    );
    intradayRank.start();

    const marketIntelligence = new MarketIntelligenceService(
        intradayRank,
        openGateV2,
        config.geminiApiKey,
    );
    marketIntelligence.start();

    const ctx: AppContext = {
        config,
        market: manager,
        trading,
        hub: new SseHub(),
        subs: new SubscriptionRegistry(marketRuntime),
        watchlists: new WatchlistStore(join(dataDir, 'watchlists.json')),
        runtimeConfig,
        marketRuntime,
        openGateV2,
        intradayRank,
        marketIntelligence,
        startedAt: Date.now(),
    };

    const app = await buildApp(ctx);
    await app.listen({ port: config.port, host: config.host });
    console.log(
        `nova-pro-server listening on http://${config.host}:${config.port}` +
            ` (market=${manager.name()}, trade=${config.tradeProvider})`,
    );
}

main().catch((err) => {
    console.error('fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
});
