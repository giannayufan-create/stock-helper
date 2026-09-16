// server/src/routes/events.ts — Event Intelligence read-only APIs

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

function parseNum(v: unknown): number | undefined {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext) {
    const ei = () => ctx.eventIntelligence;

    app.get('/api/v1/events/health', async () => {
        const svc = ei();
        if (!svc) {
            return { enabled: false, event_intelligence_available: false };
        }
        return { event_intelligence_available: true, ...svc.getHealth() };
    });

    app.get('/api/v1/events', async (req, reply) => {
        const svc = ei();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const q = req.query as Record<string, string | undefined>;
        const items = svc.list({
            event_type: q.event_type,
            sector: q.sector,
            symbol: q.symbol,
            confidence: q.confidence,
            status: q.status,
            since: q.since,
            limit: parseNum(q.limit),
        });
        return {
            count: items.length,
            items,
            creates_upstream_subscription: false,
            mutates_strategy: false,
        };
    });

    app.get('/api/v1/events/active', async (_req, reply) => {
        const svc = ei();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        return { items: svc.getActive(), count: svc.getActive().length };
    });

    app.get('/api/v1/market-context/event-summary', async (_req, reply) => {
        const svc = ei();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        return svc.getEventSummary();
    });

    app.get<{ Params: { event_id: string } }>(
        '/api/v1/events/:event_id',
        async (req, reply) => {
            const svc = ei();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const ev = svc.getEvent(req.params.event_id);
            if (!ev) return reply.code(404).send({ error: 'not_found' });
            return {
                event: ev,
                confirmation: svc.getConfirmation(ev.event_id),
                impact: svc.getImpact(ev.event_id),
            };
        },
    );

    app.get<{ Params: { event_id: string } }>(
        '/api/v1/events/:event_id/impact',
        async (req, reply) => {
            const svc = ei();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const impact = svc.getImpact(req.params.event_id);
            if (!impact) return reply.code(404).send({ error: 'not_found' });
            return impact;
        },
    );

    app.get<{ Params: { event_id: string } }>(
        '/api/v1/events/:event_id/confirmation',
        async (req, reply) => {
            const svc = ei();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const conf = svc.getConfirmation(req.params.event_id);
            if (!conf) return reply.code(404).send({ error: 'not_found' });
            return conf;
        },
    );

    app.get<{ Params: { symbol: string } }>(
        '/api/v1/companies/:symbol/exposures',
        async (req, reply) => {
            const svc = ei();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const q = req.query as { event_type?: string };
            const profile = svc.getExposure(
                req.params.symbol,
                q.event_type as never,
            );
            return {
                ...profile,
                revenue_exposure_available: false,
                note: 'revenue_exposure_available=false — 產品關鍵字≠營收占比',
            };
        },
    );
}
