// server/src/routes/today.ts — single merged decision board (read-only)

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { buildTodayDecision } from '../lib/today-decision/index.ts';

function parseNum(v: unknown): number | undefined {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

export function registerTodayRoutes(app: FastifyInstance, ctx: AppContext) {
    app.get('/api/v1/today/decision', async (req) => {
        const q = req.query as Record<string, string | undefined>;
        const limit = Math.min(30, Math.max(1, parseNum(q.limit) ?? 12));
        return buildTodayDecision(ctx, { limit });
    });
}
