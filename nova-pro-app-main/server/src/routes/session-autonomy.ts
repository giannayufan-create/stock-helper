// server/src/routes/session-autonomy.ts — observe-only headless session health

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

export function registerSessionAutonomyRoutes(
    app: FastifyInstance,
    ctx: AppContext,
) {
    app.get('/api/v1/system/session-autonomy', async (_req, reply) => {
        const svc = ctx.sessionAutonomy;
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        return {
            ...svc.getHealth(),
            transitions: svc.getTransitions().slice(-20),
            overnight_latest: svc.getOvernightSnapshots().slice(-1)[0] ?? null,
        };
    });
}
