// server/src/routes/market-intelligence.ts — read-only MI APIs (no strategy side-effects)

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import type { MarketIntelligenceService } from '../lib/market-intelligence/index.ts';

function overviewPayload(svc: MarketIntelligenceService) {
    const snap = svc.getSnapshot();
    if (!snap) {
        return {
            market_intelligence_available: true,
            ready: false,
            message: 'snapshot warming up',
            version: svc.cfg.version,
        };
    }
    return {
        market_intelligence_available: true,
        ready: true,
        generated_at: snap.generated_at,
        version: snap.version,
        theme_map_version: snap.theme_map_version,
        config_hash: snap.config_hash,
        market_context: snap.market_context,
        global_markets: snap.global_markets,
        top_sectors: snap.sectors
            .filter((s) => s.eligible_for_ranking)
            .slice(0, 8),
        top_themes: snap.themes
            .filter((t) => t.eligible_for_ranking)
            .slice(0, 8),
        top_news: snap.headlines.slice(0, 8),
        company_events: snap.company_events.slice(0, 10),
        ai_summary: snap.ai_summary,
        data_health: snap.data_health,
        material_info_available: snap.material_info_available,
        material_info_coverage: snap.material_info_coverage,
    };
}

export function registerMarketIntelligenceRoutes(
    app: FastifyInstance,
    ctx: AppContext,
) {
    const mi = () => ctx.marketIntelligence;

    app.get('/api/v1/market-intelligence/health', async () => {
        const svc = mi();
        if (!svc) {
            return {
                enabled: false,
                overall: 'UNAVAILABLE',
                market_intelligence_available: false,
            };
        }
        return {
            enabled: true,
            market_intelligence_available: true,
            source_mode: 'live',
            ...svc.getHealth(),
            version: svc.cfg.version,
            config_hash: svc.configHash,
        };
    });

    app.get('/api/v1/market-intelligence/overview', async (_req, reply) => {
        const svc = mi();
        if (!svc) {
            return reply.code(503).send({
                error: 'market intelligence disabled',
                market_intelligence_available: false,
            });
        }
        return overviewPayload(svc);
    });

    app.get('/api/v1/market-intelligence', async (_req, reply) => {
        const svc = mi();
        if (!svc) {
            return reply.code(503).send({
                error: 'market intelligence disabled',
                market_intelligence_available: false,
            });
        }
        return overviewPayload(svc);
    });

    app.get('/api/v1/market-intelligence/global', async (_req, reply) => {
        const svc = mi();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const snap = svc.getSnapshot();
        return {
            market_context: snap?.market_context ?? null,
            assets: snap?.global_markets ?? [],
            data_health: snap?.data_health.global_market ?? null,
            version: svc.cfg.version,
        };
    });

    app.get('/api/v1/market-intelligence/sectors', async (_req, reply) => {
        const svc = mi();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const sectors = svc.getSectors();
        return {
            count: sectors.length,
            items: sectors.map((s) => ({
                rank: s.rank ?? null,
                sector: s.sector,
                heat_score: s.heat_score,
                heat_delta_5m: s.heat_delta_5m,
                heat_delta_15m: s.heat_delta_15m,
                confidence: s.confidence,
                coverage_pct: s.coverage_pct,
                members: s.total_members,
                covered_members: s.covered_members,
                eligible_for_ranking: s.eligible_for_ranking,
                strong_count: s.strong_count,
                heating_count: s.heating_count,
                breakout_count: s.breakout_count,
                leaders: s.leaders,
                mapping_source: s.mapping_source,
                updated_at: s.updated_at,
            })),
            version: svc.cfg.version,
        };
    });

    app.get<{ Params: { sector: string } }>(
        '/api/v1/market-intelligence/sectors/:sector',
        async (req, reply) => {
            const svc = mi();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const row = svc.getSector(req.params.sector);
            if (!row) return reply.code(404).send({ error: 'sector not found' });
            return {
                ...row,
                constituents_note:
                    'covered = symbols present in current C rank batch',
            };
        },
    );

    app.get('/api/v1/market-intelligence/themes', async (_req, reply) => {
        const svc = mi();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const themes = svc.getThemes();
        return {
            count: themes.length,
            theme_map_version: svc.themeMapVersion,
            items: themes.map((t) => ({
                rank: t.rank ?? null,
                theme_id: t.theme_id,
                theme: t.theme,
                heat_score: t.heat_score,
                heat_delta_5m: t.heat_delta_5m,
                heat_delta_15m: t.heat_delta_15m,
                confidence: t.confidence,
                coverage_pct: t.coverage_pct,
                members: t.total_members,
                covered_members: t.covered_members,
                eligible_for_ranking: t.eligible_for_ranking,
                strong_count: t.strong_count,
                heating_count: t.heating_count,
                breakout_count: t.breakout_count,
                leaders: t.leaders,
                aliases: t.aliases,
                updated_at: t.updated_at,
            })),
            version: svc.cfg.version,
        };
    });

    app.get<{ Params: { theme: string } }>(
        '/api/v1/market-intelligence/themes/:theme',
        async (req, reply) => {
            const svc = mi();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const row = svc.getTheme(req.params.theme);
            if (!row) return reply.code(404).send({ error: 'theme not found' });
            return row;
        },
    );

    app.get('/api/v1/market-intelligence/news', async (req, reply) => {
        const svc = mi();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const limit = Math.min(
            50,
            Math.max(1, Number((req.query as { limit?: string }).limit ?? 20)),
        );
        return {
            items: svc.getNews(limit),
            data_health: svc.getHealth().news,
            note: 'Headlines only; cached. UI polling does not hit Google RSS.',
        };
    });

    app.get<{ Params: { symbol: string } }>(
        '/api/v1/market-intelligence/symbol/:symbol',
        async (req, reply) => {
            const svc = mi();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            return svc.getSymbolIntelligence(req.params.symbol);
        },
    );

    app.get('/api/v1/market-intelligence/brief', async (_req, reply) => {
        const svc = mi();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        return {
            ...svc.getBrief(),
            note: 'Cached AI brief; failure does not block other MI layers',
        };
    });
}
