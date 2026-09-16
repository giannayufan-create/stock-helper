// server/src/routes/context-research.ts — Context Lab research APIs (read-only)

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

export function registerContextResearchRoutes(
    app: FastifyInstance,
    ctx: AppContext,
) {
    const cr = () => ctx.contextResearch;

    app.get('/api/v1/research/context/health', async () => {
        const svc = cr();
        if (!svc) {
            return { enabled: false, context_research_available: false };
        }
        return { context_research_available: true, ...svc.getHealth() };
    });

    app.get('/api/v1/research/context/overview', async (req, reply) => {
        const svc = cr();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const q = req.query as Record<string, string | undefined>;
        return svc.overview(q);
    });

    app.get('/api/v1/research/context/market', async (req, reply) => {
        const svc = cr();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        return svc.market(req.query as Record<string, string | undefined>);
    });

    app.get('/api/v1/research/context/sectors', async (req, reply) => {
        const svc = cr();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        return svc.sectors(req.query as Record<string, string | undefined>);
    });

    app.get('/api/v1/research/context/events', async (req, reply) => {
        const svc = cr();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        return svc.events(req.query as Record<string, string | undefined>);
    });

    app.get('/api/v1/research/context/combinations', async (req, reply) => {
        const svc = cr();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        return svc.combinations(req.query as Record<string, string | undefined>);
    });

    app.get<{ Params: { signal_id: string } }>(
        '/api/v1/research/context/signals/:signal_id',
        async (req, reply) => {
            const svc = cr();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const detail = svc.signalDetail(req.params.signal_id);
            if (!detail) return reply.code(404).send({ error: 'not_found' });
            return detail;
        },
    );
}
