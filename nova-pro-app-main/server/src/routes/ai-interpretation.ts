// server/src/routes/ai-interpretation.ts
// Deterministic score endpoints + optional LLM narrative.
// NEVER mutates C/BP/Rank/Decision/Strategy.

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import type {
    RadarFilterSnapshot,
    RadarStockRowInput,
} from '../lib/ai-interpretation/types.ts';

export function registerAiInterpretationRoutes(
    app: FastifyInstance,
    ctx: AppContext,
): void {
    app.get('/api/v1/interpretation/health', async () => {
        const svc = ctx.aiInterpretation;
        if (!svc) {
            return { available: false };
        }
        return { available: true, ...svc.getHealth() };
    });

    /** Fast deterministic stock score — no LLM. */
    app.get<{ Params: { symbol: string } }>(
        '/api/v1/interpretation/stock/:symbol',
        async (req, reply) => {
            const svc = ctx.aiInterpretation;
            if (!svc) return reply.code(503).send({ error: 'unavailable' });
            const symbol = String(req.params.symbol ?? '').trim();
            const out = await svc.getStockScore(symbol);
            if (!out) {
                return reply.code(404).send({
                    error: 'not_found',
                    symbol,
                    hint: 'symbol not in current intraday rank batch',
                });
            }
            return out;
        },
    );

    /** LLM narrative bound to immutable snapshot. Score remains deterministic. */
    app.post<{
        Body: {
            symbol?: string;
            snapshot_id?: string;
            with_llm?: boolean;
        };
    }>('/api/v1/ai/stock-interpretation', async (req, reply) => {
        const svc = ctx.aiInterpretation;
        if (!svc) return reply.code(503).send({ error: 'unavailable' });
        const symbol = String(req.body?.symbol ?? '').trim();
        if (!symbol && !req.body?.snapshot_id) {
            return reply.code(400).send({ error: 'symbol_required' });
        }
        const result = await svc.interpretStock({
            symbol: symbol || 'UNKNOWN',
            snapshot_id: req.body?.snapshot_id,
            with_llm: req.body?.with_llm !== false,
        });
        if (!result) {
            return reply.code(404).send({ error: 'not_found', symbol });
        }
        return {
            ...result.interpretation,
            narrative: result.narrative.narrative,
            llm_available: result.narrative.llm_available,
            llm_error: result.narrative.llm_error
                ? 'AI 文字解讀暫時無法使用'
                : null,
            narrative_generated_at: result.narrative.generated_at,
            note: 'AI 輔助解讀，不影響正式分數',
        };
    });

    /** Fast deterministic radar score from filter + symbols/rows. */
    app.post<{
        Body: {
            filter?: RadarFilterSnapshot;
            symbols?: string[];
            rows?: RadarStockRowInput[];
            snapshot_id?: string;
        };
    }>('/api/v1/interpretation/radar', async (req, reply) => {
        const svc = ctx.aiInterpretation;
        if (!svc) return reply.code(503).send({ error: 'unavailable' });
        const filter = req.body?.filter ?? {};
        let snap = req.body?.snapshot_id
            ? svc.snapshots.getRadar(req.body.snapshot_id)
            : null;
        if (!snap) {
            const rows =
                req.body?.rows ??
                svc.buildRadarRowsFromSymbols(req.body?.symbols ?? []);
            snap = svc.snapshots.createRadar(filter, rows);
        }
        return svc.scoreRadar(
            snap.filter,
            snap.rows,
            snap.snapshot_id,
            snap.snapshot_at,
        );
    });

    app.post<{
        Body: {
            filter?: RadarFilterSnapshot;
            symbols?: string[];
            rows?: RadarStockRowInput[];
            snapshot_id?: string;
            with_llm?: boolean;
        };
    }>('/api/v1/ai/radar-interpretation', async (req, reply) => {
        const svc = ctx.aiInterpretation;
        if (!svc) return reply.code(503).send({ error: 'unavailable' });
        const result = await svc.interpretRadar({
            filter: req.body?.filter ?? {},
            symbols: req.body?.symbols,
            rows: req.body?.rows,
            snapshot_id: req.body?.snapshot_id,
            with_llm: req.body?.with_llm !== false,
        });
        return {
            ...result.interpretation,
            narrative: result.narrative.narrative,
            llm_available: result.narrative.llm_available,
            llm_error: result.narrative.llm_error
                ? 'AI 文字解讀暫時無法使用'
                : null,
            narrative_generated_at: result.narrative.generated_at,
            note: 'AI 輔助解讀，不影響正式分數與雷達排序',
        };
    });
}
