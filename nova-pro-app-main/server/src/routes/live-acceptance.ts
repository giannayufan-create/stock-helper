// server/src/routes/live-acceptance.ts — observe-only Full Live Acceptance APIs

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

export function registerLiveAcceptanceRoutes(
    app: FastifyInstance,
    ctx: AppContext,
) {
    const la = () => ctx.liveAcceptance;

    app.get('/api/v1/live-acceptance/status', async () => {
        const svc = la();
        if (!svc) {
            return {
                enabled: false,
                instrumentation_ready: false,
                mutates_strategy: false,
                creates_upstream_subscription: false,
            };
        }
        return { enabled: true, ...svc.getStatus() };
    });

    app.post('/api/v1/live-acceptance/sample', async (_req, reply) => {
        const svc = la();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const runtime = await svc.sampleRuntime();
        const coverage = await svc.sampleCoverage();
        return {
            runtime,
            coverage,
            mutates_strategy: false,
            creates_upstream_subscription: false,
        };
    });

    app.get('/api/v1/live-acceptance/report', async (_req, reply) => {
        const svc = la();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const commit =
            process.env.RENDER_GIT_COMMIT ??
            process.env.GIT_COMMIT ??
            null;
        return svc.buildAcceptanceReport(commit);
    });
}
