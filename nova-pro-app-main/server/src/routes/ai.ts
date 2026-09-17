// server/src/routes/ai.ts — analyze + Gemini coach (+ optional Python proxy)

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { scoreChips } from '../ai/chips-signal.ts';
import {
    applyVerdictToCore,
    buildDaytradeVerdict,
} from '../ai/daytrade-verdict.ts';
import { geminiCoach } from '../ai/gemini.ts';
import { instIntentDto, scoreInstIntent } from '../ai/inst-intent.ts';
import { measureMarketHeat } from '../ai/market-heat.ts';
import {
    marketRegimeDto,
    measureMarketRegime,
} from '../ai/market-regime.ts';
import { fetchFilteredNews } from '../ai/news-filter.ts';
import {
    overnightEdgeDto,
    overnightEdgeForCode,
} from '../ai/overnight-edge.ts';
import {
    finalizeScore,
    scoreBars,
    type AiBar,
    type AnalyzeCore,
} from '../ai/score.ts';
import {
    analyzeSymbolSnapshot,
    type SymbolAnalyzeInput,
} from '../ai/symbol-analyze.ts';
import { getChipRow } from '../lib/tw-chips.ts';
import {
    fetchUsIndices,
    scoreUsOvernightBias,
} from '../lib/us-indices.ts';

interface AnalyzeBody {
    code?: string;
    name?: string;
    bars?: AiBar[];
    stop_pct?: number;
    take_pct?: number;
    with_coach?: boolean;
    screener_strength?: number;
    screener_mode?: 'intraday' | 'overnight';
    screener_overnight_winrate?: number;
    regulatory?: 'punish' | 'attention' | null;
}

async function enrichContext(
    code: string,
    name: string | undefined,
    bars: AiBar[],
    core: AnalyzeCore,
    stopPct: number,
    takePct: number,
    opts?: {
        screenerStrength?: number | null;
        screenerMode?: 'intraday' | 'overnight' | null;
        regulatory?: 'punish' | 'attention' | null;
        /** Mobile / fast: skip slow news RSS */
        fast?: boolean;
    },
) {
    const lastClose = bars.length ? bars[bars.length - 1]!.close : undefined;
    const firstClose = bars.length ? bars[0]!.close : undefined;
    const changePct =
        lastClose && firstClose
            ? ((lastClose - firstClose) / firstClose) * 100
            : undefined;
    const heat = measureMarketHeat(bars, { changePct });
    const fast = opts?.fast === true;
    const [news, chipRow, overnight, usQuotes] = await Promise.all([
        fast
            ? Promise.resolve({
                  items: [],
                  bias: '中性' as const,
                  scoreAdj: 0,
                  summary: '快速模式略過新聞',
              })
            : fetchFilteredNews(code, name),
        getChipRow(code).catch(() => null),
        overnightEdgeForCode(code).catch(() => null),
        fetchUsIndices().catch(() => []),
    ]);
    const chips = scoreChips(chipRow);
    const { regime } = await measureMarketRegime(usQuotes).catch(() => ({
        regime: null as null,
        usQuotes,
    }));
    const usBias = scoreUsOvernightBias(usQuotes);
    const instIntent = scoreInstIntent(chips, bars);

    let chasePenalty = 0;
    if (heat.score >= 75 && core.score >= 40) {
        chasePenalty = -6;
    }

    const newsHeatAdj = news.scoreAdj + heat.scoreAdj + chasePenalty;
    const extras: string[] = [];
    if (news.scoreAdj) extras.push(`新聞${news.bias}`);
    extras.push(`${heat.session}${heat.label}`);
    if (chasePenalty) extras.push('熱度偏高防追價');

    const afterNewsHeat = finalizeScore(
        core,
        newsHeatAdj,
        extras,
        stopPct,
        takePct,
        lastClose,
    );

    const verdict = buildDaytradeVerdict({
        bars,
        core: afterNewsHeat,
        regulatory: opts?.regulatory ?? null,
        screenerStrength: opts?.screenerStrength ?? null,
        screenerMode: opts?.screenerMode ?? null,
        chips,
        overnight,
        usBias,
        regime,
        instIntent,
    });

    const scored = applyVerdictToCore(
        afterNewsHeat,
        verdict,
        lastClose,
        stopPct,
        takePct,
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
        chips: {
            available: chips.available,
            bias: chips.bias,
            label: chips.label,
            summary: chips.summary,
            score_adj: chips.scoreAdj,
            as_of: chips.asOf,
            foreign_net: chips.foreignNet,
            trust_net: chips.trustNet,
            dealer_net: chips.dealerNet,
            inst_net: chips.instNet,
            margin_delta: chips.marginDelta,
            short_delta: chips.shortDelta,
            notes: chips.notes,
        },
        overnight: overnight ? overnightEdgeDto(overnight) : null,
        market_regime: regime ? marketRegimeDto(regime) : null,
        inst_intent: instIntentDto(instIntent),
        us_market: {
            summary: usBias.summary,
            score_adj: usBias.scoreAdj,
            quotes: usQuotes.map((q) => ({
                symbol: q.symbol,
                label: q.label,
                change_rate: +q.changeRate.toFixed(3),
            })),
        },
        verdict: {
            state: verdict.state,
            headline: verdict.headline,
            session: verdict.session,
            session_note: verdict.sessionNote,
            traps: verdict.traps,
            align: verdict.align,
            risk: verdict.risk,
            micro_backtest: verdict.microBacktest,
            fail_exit: verdict.failExit,
        },
        context_adj: newsHeatAdj + verdict.scoreAdj,
    };
}

export function registerAiRoutes(app: FastifyInstance, ctx: AppContext) {
    app.get('/api/v1/ai/status', async () => ({
        python: Boolean(ctx.config.analyzerUrl),
        analyzer_url: ctx.config.analyzerUrl || null,
        gemini: Boolean(ctx.config.geminiApiKey),
        news: true,
        heat: true,
        chips: true,
        overnight: true,
        market_regime: true,
        inst_intent: true,
        verdict: true,
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
        const preferFast = req.body?.with_coach === false;
        const enrichOpts = {
            screenerStrength:
                typeof req.body?.screener_strength === 'number'
                    ? req.body.screener_strength
                    : null,
            screenerMode:
                req.body?.screener_mode === 'overnight' ||
                req.body?.screener_mode === 'intraday'
                    ? req.body.screener_mode
                    : null,
            regulatory: req.body?.regulatory ?? null,
            fast: preferFast,
        };
        const at = new Date().toLocaleTimeString('zh-TW', { hour12: false });

        // Prefer Python analyzer when configured (skip on fast path / mobile)
        if (ctx.config.analyzerUrl && !preferFast) {
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
                        enrichOpts,
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
                                chipsSummary: enriched.chips.summary,
                                overnightSummary: enriched.overnight?.summary,
                                usSummary: enriched.us_market.summary,
                                regimeSummary: enriched.market_regime?.summary,
                                instIntentSummary: enriched.inst_intent?.summary,
                                verdictSummary: enriched.verdict.headline,
                                failExitSummary: `${enriched.verdict.fail_exit.action}：${enriched.verdict.fail_exit.reason}`,
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
                        chips: enriched.chips,
                        overnight: enriched.overnight,
                        market_regime: enriched.market_regime,
                        inst_intent: enriched.inst_intent,
                        us_market: enriched.us_market,
                        verdict: enriched.verdict,
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
            enrichOpts,
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
                    chipsSummary: enriched.chips.summary,
                    overnightSummary: enriched.overnight?.summary,
                    usSummary: enriched.us_market.summary,
                    regimeSummary: enriched.market_regime?.summary,
                    instIntentSummary: enriched.inst_intent?.summary,
                    verdictSummary: enriched.verdict.headline,
                    failExitSummary: `${enriched.verdict.fail_exit.action}：${enriched.verdict.fail_exit.reason}`,
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
            chips: enriched.chips,
            overnight: enriched.overnight,
            market_regime: enriched.market_regime,
            inst_intent: enriched.inst_intent,
            us_market: enriched.us_market,
            verdict: enriched.verdict,
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

    /** Radar Detail: structured snapshot → structured JSON (no markdown). */
    const symbolAiCache = new Map<
        string,
        { at: number; result: ReturnType<typeof analyzeSymbolSnapshot> }
    >();

    app.post<{ Body: SymbolAnalyzeInput }>(
        '/api/v1/ai/analyze-symbol',
        async (req, reply) => {
            const body = req.body ?? ({} as SymbolAnalyzeInput);
            const symbol = String(body.symbol ?? '').trim();
            if (!symbol) {
                return reply.code(400).send({ error: 'symbol required' });
            }
            const featureHash =
                body.feature_hash ??
                [
                    symbol,
                    body.c_score,
                    body.heat,
                    body.rank,
                    body.chase_risk,
                    body.data_health,
                    body.score_coverage_pct,
                    (body.recent_events ?? []).join(','),
                ].join('|');

            const cacheKey = `${symbol}::${featureHash}`;
            const hit = symbolAiCache.get(cacheKey);
            const now = Date.now();
            if (hit && now - hit.at < 90_000) {
                return { ...hit.result, cached: true };
            }

            try {
                const result = analyzeSymbolSnapshot({
                    ...body,
                    symbol,
                    feature_hash: featureHash,
                });
                symbolAiCache.set(cacheKey, { at: now, result });
                // bound cache
                if (symbolAiCache.size > 200) {
                    const first = symbolAiCache.keys().next().value;
                    if (first) symbolAiCache.delete(first);
                }
                return { ...result, cached: false };
            } catch (err) {
                return reply.code(500).send({
                    error: err instanceof Error ? err.message : String(err),
                    message: 'AI 暫時無法分析，系統即時分數仍正常',
                });
            }
        },
    );
}
