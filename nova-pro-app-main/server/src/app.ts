// server/src/app.ts — Fastify app assembly: routes + provider→SSE wiring.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppContext } from './context.ts';
import { registerConfigRoutes } from './routes/config.ts';
import { registerDataRoutes } from './routes/data.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerOrderRoutes } from './routes/orders.ts';
import { registerPortfolioRoutes } from './routes/portfolio.ts';
import { registerStreamRoutes } from './routes/stream.ts';
import { registerWatchlistRoutes } from './routes/watchlist.ts';
import { registerAiRoutes } from './routes/ai.ts';
import { registerMarketIntelligenceRoutes } from './routes/market-intelligence.ts';
import { registerBrokerIntelligenceRoutes } from './routes/broker-intelligence.ts';
import { registerBuyPressureRoutes } from './routes/buy-pressure.ts';
import { registerNotificationRoutes } from './routes/notifications.ts';
import { registerMarketContextRoutes } from './routes/market-context.ts';
import { registerEventRoutes } from './routes/events.ts';
import { registerContextResearchRoutes } from './routes/context-research.ts';
import { registerCalendarRoutes } from './routes/calendar.ts';
import { registerLiveAcceptanceRoutes } from './routes/live-acceptance.ts';
import { registerDecisionSummaryRoutes } from './routes/decision-summary.ts';
import { registerSessionAutonomyRoutes } from './routes/session-autonomy.ts';
import { registerAiInterpretationRoutes } from './routes/ai-interpretation.ts';
import { registerRadarQualityRoutes } from './routes/radar-quality.ts';
import { registerTodayRoutes } from './routes/today.ts';
import { registerOutcomeRoutes } from './routes/outcomes.ts';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
    const app = Fastify({ logger: { level: 'warn' } });

    // CORS for web dev without the vite proxy (and Tauri webviews later)
    app.addHook('onSend', async (_req, reply) => {
        reply.header('Access-Control-Allow-Origin', '*');
        reply.header('Access-Control-Allow-Headers', 'Content-Type');
        reply.header(
            'Access-Control-Allow-Methods',
            'GET, POST, PUT, OPTIONS',
        );
    });
    app.options('/*', async (_req, reply) => reply.code(204).send());

    registerHealthRoutes(app, ctx);
    registerConfigRoutes(app, ctx);
    registerDataRoutes(app, ctx);
    registerStreamRoutes(app, ctx);
    registerOrderRoutes(app, ctx);
    registerPortfolioRoutes(app, ctx);
    registerWatchlistRoutes(app, ctx);
    registerAiRoutes(app, ctx);
    registerMarketIntelligenceRoutes(app, ctx);
    registerBrokerIntelligenceRoutes(app, ctx);
    registerBuyPressureRoutes(app, ctx);
    registerNotificationRoutes(app, ctx);
    registerMarketContextRoutes(app, ctx);
    registerEventRoutes(app, ctx);
    registerContextResearchRoutes(app, ctx);
    registerCalendarRoutes(app, ctx);
    registerLiveAcceptanceRoutes(app, ctx);
    registerDecisionSummaryRoutes(app, ctx);
    registerSessionAutonomyRoutes(app, ctx);
    registerAiInterpretationRoutes(app, ctx);
    registerRadarQualityRoutes(app, ctx);
    registerTodayRoutes(app, ctx);
    registerOutcomeRoutes(app, ctx);

    // provider events → SSE fan-out
    ctx.market.onTick((channel, tick) => ctx.hub.broadcast(channel, tick));
    ctx.market.onBidAsk((channel, bidask) =>
        ctx.hub.broadcast(channel, bidask),
    );
    ctx.trading.onOrderEvent((ev) => ctx.hub.broadcast('order_event', ev));

    // Production (Render): serve Vite build from ../dist next to server/
    const here = dirname(fileURLToPath(import.meta.url));
    const webRoot = join(here, '..', '..', 'dist');
    if (existsSync(join(webRoot, 'index.html'))) {
        await app.register(fastifyStatic, {
            root: webRoot,
            wildcard: false,
        });
        app.setNotFoundHandler((req, reply) => {
            if (req.method === 'GET' && !req.url.startsWith('/api')) {
                return reply.sendFile('index.html');
            }
            return reply.code(404).send({ error: 'not found' });
        });
        console.log(`serving web UI from ${webRoot}`);
    }

    return app;
}
