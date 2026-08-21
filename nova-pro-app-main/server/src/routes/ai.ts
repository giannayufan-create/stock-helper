// server/src/routes/ai.ts — analyze + Gemini coach (+ optional Python proxy)

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { geminiCoach } from '../ai/gemini.ts';
import { scoreBars, type AiBar } from '../ai/score.ts';

interface AnalyzeBody {
    code?: string;
    name?: string;
    bars?: AiBar[];
    stop_pct?: number;
    take_pct?: number;
    with_coach?: boolean;
}

export function registerAiRoutes(app: FastifyInstance, ctx: AppContext) {
    app.get('/api/v1/ai/status', async () => ({
        python: Boolean(ctx.config.analyzerUrl),
        analyzer_url: ctx.config.analyzerUrl || null,
        gemini: Boolean(ctx.config.geminiApiKey),
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

        // Prefer Python analyzer when configured
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
                    // If Python didn't attach coach but we have Gemini, enrich here
                    let coach =
                        typeof data.coach === 'string' ? data.coach : undefined;
                    if (
                        withCoach &&
                        !coach &&
                        ctx.config.geminiApiKey &&
                        bars.length >= 30
                    ) {
                        try {
                            coach = await geminiCoach({
                                apiKey: ctx.config.geminiApiKey,
                                code,
                                name,
                                stance: String(data.stance ?? ''),
                                score: Number(data.score ?? 0),
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
                                    typeof data.rr === 'number'
                                        ? data.rr
                                        : undefined,
                            });
                        } catch {
                            // keep python result without coach
                        }
                    }
                    return {
                        ...data,
                        source: 'python',
                        coach,
                        at: data.at ?? at,
                    };
                }
            } catch {
                // fall through to local
            }
        }

        const core = scoreBars(bars, stopPct, takePct);
        let coach: string | undefined;
        let source: 'local' | 'local+gemini' = 'local';
        if (withCoach && ctx.config.geminiApiKey && bars.length >= 30) {
            try {
                coach = await geminiCoach({
                    apiKey: ctx.config.geminiApiKey,
                    code,
                    name,
                    ...core,
                });
                source = 'local+gemini';
            } catch (err) {
                coach = `（Gemini 暫不可用：${err instanceof Error ? err.message : String(err)}）`;
            }
        }

        return { ...core, source, coach, at };
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
            });
            return { coach: text, source: 'gemini' };
        } catch (err) {
            return reply.code(502).send({
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });
}
