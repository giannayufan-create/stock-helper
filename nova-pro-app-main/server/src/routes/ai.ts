// server/src/routes/ai.ts — analyze + Gemini coach (+ optional Python proxy)

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { geminiCoach } from '../ai/gemini.ts';
import { measureMarketHeat } from '../ai/market-heat.ts';
import { fetchFilteredNews } from '../ai/news-filter.ts';
import {
    finalizeScore,
    scoreBars,
    type AiBar,
    type AnalyzeCore,
} from '../ai/score.ts';

interface AnalyzeBody {
    code?: string;
    name?: string;
    bars?: AiBar[];
    stop_pct?: number;
    take_pct?: number;
    with_coach?: boolean;
}

async function enrichContext(
    code: string,
    name: string | undefined,
    bars: AiBar[],
    core: AnalyzeCore,
    stopPct: number,
    takePct: number,
) {
    const lastClose = bars.length ? bars[bars.length - 1]!.close : undefined;
    const firstClose = bars.length ? bars[0]!.close : undefined;
    const changePct =
        lastClose && firstClose
            ? ((lastClose - firstClose) / firstClose) * 100
            : undefined;
    const heat = measureMarketHeat(bars, { changePct });
    const news = await fetchFilteredNews(code, name);

    // If already strongly extended on heat + bullish tech, damp chase
    let chasePenalty = 0;
    if (heat.score >= 75 && core.score >= 40) {
        chasePenalty = -6;
    }

    const adj = news.scoreAdj + heat.scoreAdj + chasePenalty;
    const extras: string[] = [];
    if (news.scoreAdj) extras.push(`新聞${news.bias}`);
    extras.push(`${heat.session}${heat.label}`);
    if (chasePenalty) extras.push('熱度偏高防追價');

    const scored = finalizeScore(
        core,
        adj,
        extras,
        stopPct,
        takePct,
        lastClose,
    );
    return {
        scored,
        news: {
            bias: news.bias,
            summary: news.summary,
            score_adj: news.scoreAdj,
            headlines: news.items.map((i) => ({
                title: i.title,
                source: i.source,
                sentiment: i.sentiment,
            })),
        },
        heat: {
            session: heat.session,
            label: heat.label,
            score: heat.score,
            score_adj: heat.scoreAdj,
            buy_vol_ratio: +heat.buyVolRatio.toFixed(3),
            notes: heat.notes,
        },
        context_adj: adj,
    };
}

export function registerAiRoutes(app: FastifyInstance, ctx: AppContext) {
    app.get('/api/v1/ai/status', async () => ({
        python: Boolean(ctx.config.analyzerUrl),
        analyzer_url: ctx.config.analyzerUrl || null,
        gemini: Boolean(ctx.config.geminiApiKey),
        news: true,
        heat: true,
    }));

    app.post<{ Body: AnalyzeBody }>('/api/v1/ai/analyze', async (req, reply) => {
        const code = (req.body?.code ?? '').trim();
        const bars = Array.isArray(req.body?.bars) ? req.body.bars : [];
        if (!code) {
            return reply.code(400).send({ error: 'code required' });
        }
        const stopPct = req.body?.stop_pct ?? 0.01;
        const takePct = req.body?.take_pct ?? 0.02;
        const withCoach = req.body?.with_coach !== false;
        const name = req.body?.name;
        const at = new Date().toLocaleTimeString('zh-TW', { hour12: false });

        // Prefer Python analyzer when configured, then still enrich news/heat
        if (ctx.config.analyzerUrl) {
            try {
                const url = `${ctx.config.analyzerUrl.replace(/\/$/, '')}/analyze`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        code,
                        name,
                        bars,
                        stop_pct: stopPct,
                        take_pct: takePct,
                    }),
                    signal: AbortSignal.timeout(25000),
                });
                if (res.ok) {
                    const data = (await res.json()) as Record<string, unknown>;
                    const base: AnalyzeCore = {
                        score: Number(data.score ?? 0),
                        stance: (data.stance as AnalyzeCore['stance']) ?? '盤整',
                        reasons: Array.isArray(data.reasons)
                            ? (data.reasons as string[])
                            : [],
                        entry:
                            typeof data.entry === 'number'
                                ? data.entry
                                : undefined,
                        stop:
                            typeof data.stop === 'number'
                                ? data.stop
                                : undefined,
                        take:
                            typeof data.take === 'number'
                                ? data.take
                                : undefined,
                        rr:
                            typeof data.rr === 'number' ? data.rr : undefined,
                        up_prob:
                            typeof data.up_prob === 'number'
                                ? data.up_prob
                                : 50,
                    };
                    const enriched = await enrichContext(
                        code,
                        name,
                        bars,
                        base,
                        stopPct,
                        takePct,
                    );
                    let coach =
                        typeof data.coach === 'string' ? data.coach : undefined;
                    if (
                        withCoach &&
                        ctx.config.geminiApiKey &&
                        bars.length >= 30
                    ) {
                        try {
                            coach = await geminiCoach({
                                apiKey: ctx.config.geminiApiKey,
                                code,
                                name,
                                ...enriched.scored,
                                newsSummary: enriched.news.summary,
                                heatSummary: enriched.heat.notes[0],
                            });
                        } catch {
                            // keep prior coach
                        }
                    }
                    return {
                        ...enriched.scored,
                        source: 'python+context',
                        coach,
                        at: data.at ?? at,
                        news: enriched.news,
                        heat: enriched.heat,
                        context_adj: enriched.context_adj,
                    };
                }
            } catch {
                // fall through to local
            }
        }

        const core = scoreBars(bars, stopPct, takePct);
        const enriched = await enrichContext(
            code,
            name,
            bars,
            core,
            stopPct,
            takePct,
        );
        let coach: string | undefined;
        let source: 'local+context' | 'local+context+gemini' = 'local+context';
        if (withCoach && ctx.config.geminiApiKey && bars.length >= 30) {
            try {
                coach = await geminiCoach({
                    apiKey: ctx.config.geminiApiKey,
                    code,
                    name,
                    ...enriched.scored,
                    newsSummary: enriched.news.summary,
                    heatSummary: enriched.heat.notes[0],
                });
                source = 'local+context+gemini';
            } catch (err) {
                coach = `（Gemini 暫不可用：${err instanceof Error ? err.message : String(err)}）`;
            }
        }

        return {
            ...enriched.scored,
            source,
            coach,
            at,
            news: enriched.news,
            heat: enriched.heat,
            context_adj: enriched.context_adj,
        };
    });

    app.post<{
        Body: {
            code?: string;
            name?: string;
            stance?: string;
            score?: number;
            reasons?: string[];
            entry?: number;
            stop?: number;
            take?: number;
            rr?: number;
            up_prob?: number;
            newsSummary?: string;
            heatSummary?: string;
        };
    }>('/api/v1/ai/coach', async (req, reply) => {
        if (!ctx.config.geminiApiKey) {
            return reply
                .code(503)
                .send({ error: 'GEMINI_API_KEY not configured' });
        }
        try {
            const text = await geminiCoach({
                apiKey: ctx.config.geminiApiKey,
                code: req.body?.code ?? '',
                name: req.body?.name,
                stance: req.body?.stance ?? '盤整',
                score: req.body?.score ?? 0,
                reasons: req.body?.reasons ?? [],
                entry: req.body?.entry,
                stop: req.body?.stop,
                take: req.body?.take,
                rr: req.body?.rr,
                up_prob: req.body?.up_prob,
                newsSummary: req.body?.newsSummary,
                heatSummary: req.body?.heatSummary,
            });
            return { coach: text, source: 'gemini' };
        } catch (err) {
            return reply.code(502).send({
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });
}
