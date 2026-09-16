// server/src/routes/market-context.ts — read-only Market Context APIs

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

export function registerMarketContextRoutes(
    app: FastifyInstance,
    ctx: AppContext,
) {
    const mc = () => ctx.marketContext;

    app.get('/api/v1/market-context/health', async () => {
        const svc = mc();
        if (!svc) {
            return {
                enabled: false,
                status: 'UNAVAILABLE',
                market_context_available: false,
            };
        }
        return { market_context_available: true, ...svc.getHealth() };
    });

    app.get('/api/v1/market-context/overview', async (_req, reply) => {
        const svc = mc();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const ov = svc.getOverview() ?? (await svc.evaluate());
        return ov;
    });

    app.get('/api/v1/market-context/regime', async (_req, reply) => {
        const svc = mc();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        if (!svc.getOverview()) await svc.evaluate();
        const r = svc.getRegime();
        if (!r) return reply.code(503).send({ error: 'not_ready' });
        return r;
    });

    app.get('/api/v1/market-context/breadth', async (_req, reply) => {
        const svc = mc();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        if (!svc.getOverview()) await svc.evaluate();
        const b = svc.getBreadth();
        if (!b) return reply.code(503).send({ error: 'not_ready' });
        return b;
    });

    app.get('/api/v1/market-context/sectors', async (_req, reply) => {
        const svc = mc();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        if (!svc.getOverview()) await svc.evaluate();
        return {
            as_of: svc.getOverview()?.as_of ?? null,
            count: svc.getSectors().length,
            items: svc.getSectors(),
            creates_upstream_subscription: false,
            mutates_strategy: false,
        };
    });

    app.get<{ Params: { sector: string } }>(
        '/api/v1/market-context/sectors/:sector',
        async (req, reply) => {
            const svc = mc();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            if (!svc.getOverview()) await svc.evaluate();
            const row = svc.getSector(decodeURIComponent(req.params.sector));
            if (!row) return reply.code(404).send({ error: 'not_found' });
            return row;
        },
    );

    app.get('/api/v1/market-context/gap-layers', async (_req, reply) => {
        const svc = mc();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        if (!svc.getOverview()) await svc.evaluate();
        const layers = svc.getGapLayers();
        if (!layers) return reply.code(503).send({ error: 'not_ready' });
        return layers;
    });
}
