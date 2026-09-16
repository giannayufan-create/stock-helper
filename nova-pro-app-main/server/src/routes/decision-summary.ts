// server/src/routes/decision-summary.ts — read-only Decision Support API

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

function parseNum(v: unknown): number | undefined {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

export function registerDecisionSummaryRoutes(
    app: FastifyInstance,
    ctx: AppContext,
) {
    const ds = () => ctx.decisionSummary;

    app.get('/api/v1/data/decision-summary/health', async () => {
        const svc = ds();
        if (!svc) {
            return {
                enabled: false,
                status: 'UNAVAILABLE',
                mutates_strategy: false,
            };
        }
        return svc.getHealth();
    });

    app.get('/api/v1/data/decision-summary', async (req, reply) => {
        const svc = ds();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const q = req.query as Record<string, string | undefined>;
        return svc.list(parseNum(q.limit) ?? 80);
    });

    app.get<{ Params: { symbol: string } }>(
        '/api/v1/data/decision-summary/:symbol',
        async (req, reply) => {
            const svc = ds();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const item = svc.getSymbol(req.params.symbol);
            if (!item) return reply.code(404).send({ error: 'not_found' });
            return item;
        },
    );
}
