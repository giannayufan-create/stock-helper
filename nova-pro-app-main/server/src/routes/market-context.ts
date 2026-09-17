// server/src/routes/market-context.ts — read-only Market Context APIs

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { buildMeta } from '../lib/market-context/freshness.ts';
import type { MarketContextOverview } from '../lib/market-context/types.ts';

function warmingOverview(): MarketContextOverview {
    const fetched = new Date().toISOString();
    const meta = buildMeta({
        source: 'warming',
        source_type: 'warming',
        fetched_at: fetched,
        available: false,
        coverage_pct: 0,
        confidence: 'NONE',
        realtime_level: 'UNKNOWN',
    });
    return {
        as_of: fetched,
        version: 'warming',
        global_regime: { state: 'UNKNOWN', summary: '市場脈絡載入中', meta },
        taiwan_regime: {
            state: 'UNKNOWN',
            taiex_change_pct: null,
            tpex_change_pct: null,
            taiex_direction: 'UNKNOWN',
            tpex_direction: 'UNKNOWN',
            market_breadth_advance_pct: null,
            advance_decline_ratio: null,
            turnover_acceleration: 'UNKNOWN',
            large_vs_small_rs: null,
            electronics_strength: null,
            financial_strength: null,
            sector_breadth_pct: null,
            score: null,
            reasons: ['warming'],
            meta,
        },
        breadth: {
            advancers: 0,
            decliners: 0,
            unchanged: 0,
            advance_decline_ratio: null,
            advance_pct: null,
            decline_pct: null,
            coverage_pct: 0,
            confidence: 'NONE',
            universe_size: 0,
            uses_active_watch_pool: false,
            meta,
        },
        broad_universe: {
            broad_universe_size: 0,
            expected_universe_size: 0,
            coverage_pct: 0,
            source: 'warming',
            update_frequency: 'unknown',
            realtime_level: 'UNKNOWN',
            meta,
        },
        top_rotating: [],
        institutional_eod: {
            label: 'INSTITUTIONAL_EOD',
            available: false,
            as_of: null,
            note: 'warming',
            realtime_level: 'PREVIOUS_DAY',
            meta,
        },
        institutional_risk_proxy: {
            label: 'INSTITUTIONAL_RISK_PROXY',
            available: false,
            proxy: true,
            not_actual_foreign_identity: true,
            note: 'warming',
            meta,
        },
        creates_upstream_subscription: false,
        mutates_strategy: false,
        warnings: ['warming'],
    };
}

export function registerMarketContextRoutes(
    app: FastifyInstance,
    ctx: AppContext,
) {
    const mc = () => ctx.marketContext;

    app.get('/api/v1/market-context/health', async () => {
        const svc = mc();
        if (!svc) {
            return {
                enabled: false,
                status: 'UNAVAILABLE',
                market_context_available: false,
            };
        }
        return { market_context_available: true, ...svc.getHealth() };
    });

    app.get('/api/v1/market-context/overview', async (_req, reply) => {
        const svc = mc();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const cached = svc.getOverview();
        if (cached) return cached;
        void svc.evaluate();
        return warmingOverview();
    });

    app.get('/api/v1/market-context/regime', async (_req, reply) => {
        const svc = mc();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const r = svc.getRegime();
        if (r) return r;
        void svc.evaluate();
        return reply.code(503).send({ error: 'warming' });
    });

    app.get('/api/v1/market-context/breadth', async (_req, reply) => {
        const svc = mc();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const b = svc.getBreadth();
        if (b) return b;
        void svc.evaluate();
        return reply.code(503).send({ error: 'warming' });
    });

    app.get('/api/v1/market-context/sectors', async (_req, reply) => {
        const svc = mc();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        if (!svc.getOverview()) void svc.evaluate();
        return {
            as_of: svc.getOverview()?.as_of ?? null,
            count: svc.getSectors().length,
            items: svc.getSectors(),
            creates_upstream_subscription: false,
            mutates_strategy: false,
        };
    });

    app.get<{ Params: { sector: string } }>(
        '/api/v1/market-context/sectors/:sector',
        async (req, reply) => {
            const svc = mc();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const row = svc.getSector(decodeURIComponent(req.params.sector));
            if (row) return row;
            void svc.evaluate();
            return reply.code(404).send({ error: 'not_found' });
        },
    );

    app.get('/api/v1/market-context/gap-layers', async (_req, reply) => {
        const svc = mc();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const layers = svc.getGapLayers();
        if (layers) return layers;
        void svc.evaluate();
        return reply.code(503).send({ error: 'warming' });
    });
}
