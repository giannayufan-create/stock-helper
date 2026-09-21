// GET /api/v1/data/limit-up-board — today's 漲停板 (read-only)

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { buildLimitUpBoard } from '../lib/limit-up-board/service.ts';

export function registerLimitUpBoardRoutes(
    app: FastifyInstance,
    ctx: AppContext,
) {
    app.get('/api/v1/data/limit-up-board', async (req) => {
        const q = req.query as Record<string, string | undefined>;
        const mode =
            q.mode === 'eod' || q.mode === 'live' || q.mode === 'auto'
                ? q.mode
                : 'auto';
        const min_pct = q.min_pct != null ? Number(q.min_pct) : undefined;
        const count = q.count != null ? Number(q.count) : undefined;
        return buildLimitUpBoard(ctx.market, {
            mode,
            date: q.date,
            min_pct: Number.isFinite(min_pct) ? min_pct : undefined,
            count: Number.isFinite(count) ? count : undefined,
        });
    });
}
