// server/src/routes/radar-quality.ts — read-only Radar Quality API

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

function parseNum(v: unknown): number | undefined {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

export function registerRadarQualityRoutes(
    app: FastifyInstance,
    ctx: AppContext,
) {
    const rq = () => ctx.radarQuality;

    app.get('/api/v1/data/radar-quality/health', async () => {
        const svc = rq();
        if (!svc) {
            return {
                enabled: false,
                status: 'UNAVAILABLE',
                mutates_strategy: false,
            };
        }
        return svc.getHealth();
    });

    app.get('/api/v1/data/radar-quality', async (req, reply) => {
        const svc = rq();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const q = req.query as Record<string, string | undefined>;
        const limit = parseNum(q.limit) ?? 80;
        if (q.momentum) {
            const states = String(q.momentum)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            return svc.listByMomentum(states, limit);
        }
        return svc.list(limit);
    });

    app.get('/api/v1/data/radar-quality/focus', async (_req, reply) => {
        const svc = rq();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const batch = svc.getLastBatch();
        return {
            as_of: batch?.as_of ?? new Date().toISOString(),
            focus_top3: svc.getFocusTop3(),
            counts: batch?.counts ?? null,
            mutates_strategy: false,
            note: 'Stable Focus Top3 — presentation only',
            intraday_foreign_identity: 'NOT_AVAILABLE',
        };
    });

    app.get<{ Params: { symbol: string } }>(
        '/api/v1/data/radar-quality/:symbol',
        async (req, reply) => {
            const svc = rq();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const item = svc.getSymbol(req.params.symbol);
            if (!item) return reply.code(404).send({ error: 'not_found' });
            return item;
        },
    );
}
