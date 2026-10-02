// server/src/routes/strategy-validation.ts — read-only strategy validation summary.

import { dateTimeFormat } from '../lib/intl-cache.ts';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { StrategyValidationService } from '../lib/strategy-validation/service.ts';

function taipeiYmd(offsetDays = 0): string {
    const d = new Date(Date.now() + offsetDays * 86_400_000);
    return dateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

let singleton: StrategyValidationService | null = null;

function svc(ctx: AppContext): StrategyValidationService {
    if (ctx.strategyValidation) return ctx.strategyValidation;
    if (!singleton) singleton = new StrategyValidationService();
    return singleton;
}

export function registerStrategyValidationRoutes(
    app: FastifyInstance,
    ctx: AppContext,
): void {
    app.get('/api/v1/research/strategy-validation/summary', async (req) => {
        const q = req.query as Record<string, string | undefined>;
        const to = q.to ?? taipeiYmd();
        const from = q.from ?? taipeiYmd(-30);
        const demo = q.demo === '1' || q.demo === 'true';
        return svc(ctx).getSummary({ from, to, demo });
    });
}
