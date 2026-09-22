// server/src/routes/radar-rescue.ts

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

export function registerRadarRescueRoutes(
    app: FastifyInstance,
    ctx: AppContext,
): void {
    const svc = () => ctx.radarRescue;

    app.get('/api/v1/data/radar-rescue/health', async () => {
        const s = svc();
        if (!s) return { enabled: false, status: 'DISABLED' };
        return s.getHealth();
    });

    app.get('/api/v1/data/radar-rescue', async (_req, reply) => {
        const s = svc();
        if (!s) return reply.code(503).send({ error: 'disabled' });
        const batch = s.getLastBatch() ?? (await s.evaluate());
        return batch ?? { error: 'warming_up' };
    });

    app.get('/api/v1/data/radar-rescue/focus', async (_req, reply) => {
        const s = svc();
        if (!s) return reply.code(503).send({ error: 'disabled' });
        const batch = s.getLastBatch();
        return batch?.focus ?? { early: [], confirmed: [] };
    });

    app.get<{ Params: { symbol: string } }>(
        '/api/v1/data/radar-rescue/:symbol',
        async (req, reply) => {
            const s = svc();
            if (!s) return reply.code(503).send({ error: 'disabled' });
            const item = s.getSymbol(req.params.symbol);
            if (!item) return reply.code(404).send({ error: 'not_found' });
            return item;
        },
    );

    app.get('/api/v1/data/radar-rescue/funnel', async (_req, reply) => {
        const s = svc();
        if (!s) return reply.code(503).send({ error: 'disabled' });
        return { items: s.getFunnel(), count: s.getFunnel().length };
    });

    app.get('/api/v1/data/radar-rescue/recall', async (_req, reply) => {
        const s = svc();
        if (!s) return reply.code(503).send({ error: 'disabled' });
        return s.getRecall() ?? { error: 'not_ready' };
    });

    app.post('/api/v1/data/radar-rescue/eod-truth/run', async (_req, reply) => {
        const s = svc();
        if (!s) return reply.code(503).send({ error: 'disabled' });
        const report = await s.runEodTruthAndRecall();
        return { ok: true, recall: report, truth_count: s.getEodTruth().length };
    });

    app.get('/api/v1/data/radar-rescue/eod-truth', async (_req, reply) => {
        const s = svc();
        if (!s) return reply.code(503).send({ error: 'disabled' });
        const items = s.getEodTruth();
        return { count: items.length, items };
    });
}
