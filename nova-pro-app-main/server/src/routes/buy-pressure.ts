// server/src/routes/buy-pressure.ts — read-only Buy Pressure Radar API

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import type { BuyPressureState } from '../lib/buy-pressure/types.ts';

function parseNum(v: unknown): number | undefined {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function parseBool(v: unknown): boolean | undefined {
    if (v == null || v === '') return undefined;
    if (v === 'true' || v === true) return true;
    if (v === 'false' || v === false) return false;
    return undefined;
}

export function registerBuyPressureRoutes(
    app: FastifyInstance,
    ctx: AppContext,
) {
    const bp = () => ctx.buyPressure;

    app.get('/api/v1/data/buy-pressure/health', async () => {
        const svc = bp();
        if (!svc) {
            return {
                enabled: false,
                status: 'UNAVAILABLE',
                buy_pressure_available: false,
            };
        }
        return { buy_pressure_available: true, ...svc.getHealth() };
    });

    app.get('/api/v1/data/buy-pressure', async (req, reply) => {
        const svc = bp();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const q = req.query as Record<string, string | undefined>;
        // Intentionally NO default max_price — ALL prices unless client filters.
        return svc.list({
            min_price: parseNum(q.min_price),
            max_price: parseNum(q.max_price),
            min_score: parseNum(q.min_score),
            state: (q.state as BuyPressureState | 'ALL' | 'OVERHEATED_STRONG' | undefined) ?? 'ALL',
            market: (q.market as 'ALL' | 'TSE' | 'OTC' | 'ESM' | undefined) ?? 'ALL',
            overheated: parseBool(q.overheated),
            sort: (q.sort as
                | 'strongest'
                | 'early'
                | 'rank_surge'
                | 'volume_surge'
                | 'ask_eating'
                | 'overheated_strong'
                | undefined) ?? 'strongest',
            limit: parseNum(q.limit),
        });
    });

    app.get<{ Params: { symbol: string } }>(
        '/api/v1/data/buy-pressure/:symbol',
        async (req, reply) => {
            const svc = bp();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const item = svc.getSymbol(req.params.symbol);
            if (!item) {
                return reply.code(404).send({ error: 'not_found' });
            }
            return item;
        },
    );
}
