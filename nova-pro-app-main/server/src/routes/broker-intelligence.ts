// server/src/routes/broker-intelligence.ts — read-only; no strategy side-effects

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

export function registerBrokerIntelligenceRoutes(
    app: FastifyInstance,
    ctx: AppContext,
) {
    const bi = () => ctx.brokerIntelligence;

    app.get('/api/v1/broker-intelligence/health', async () => {
        const svc = bi();
        if (!svc) {
            return {
                enabled: false,
                status: 'UNAVAILABLE',
                broker_intelligence_available: false,
            };
        }
        return {
            enabled: true,
            broker_intelligence_available: true,
            ...svc.getHealth(),
            capability_audit: svc.getCapabilityAudit(),
        };
    });

    // Rankings before :symbol routes
    app.get(
        '/api/v1/broker-intelligence/ranking/concentration',
        async (req, reply) => {
            const svc = bi();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const limit = Number((req.query as { limit?: string }).limit ?? 30);
            return svc.rankingConcentration(Number.isFinite(limit) ? limit : 30);
        },
    );

    app.get(
        '/api/v1/broker-intelligence/ranking/persistent-buy',
        async (req, reply) => {
            const svc = bi();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const limit = Number((req.query as { limit?: string }).limit ?? 30);
            return svc.rankingPersistentBuy(Number.isFinite(limit) ? limit : 30);
        },
    );

    app.get(
        '/api/v1/broker-intelligence/ranking/alignment',
        async (req, reply) => {
            const svc = bi();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const limit = Number((req.query as { limit?: string }).limit ?? 30);
            return svc.rankingAlignment(Number.isFinite(limit) ? limit : 30);
        },
    );

    app.get<{ Params: { symbol: string } }>(
        '/api/v1/broker-intelligence/:symbol/summary',
        async (req, reply) => {
            const svc = bi();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            return svc.getSummary(req.params.symbol);
        },
    );

    app.get<{ Params: { symbol: string } }>(
        '/api/v1/broker-intelligence/:symbol/branches',
        async (req, reply) => {
            const svc = bi();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            return svc.getBranches(req.params.symbol);
        },
    );

    app.get<{
        Params: { symbol: string };
        Querystring: { days?: string };
    }>('/api/v1/broker-intelligence/:symbol/history', async (req, reply) => {
        const svc = bi();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const days = Number(req.query.days ?? 5);
        return svc.getHistory(
            req.params.symbol,
            Number.isFinite(days) ? days : 5,
        );
    });
}
