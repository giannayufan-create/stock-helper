// server/src/lib/tw-full-screener.ts — full-market screener enrichment pipeline
// TWSE/TPEx day universe → liquid filter → OpenAPI fundamentals → tech → streak → TDCC

import type { ScannerItem } from '../types/dto.ts';
import {
    dayQuoteToScannerItem,
    fetchTwMarketDayAll,
    pickLiquidUniverse,
    type TwDayQuote,
} from './tw-market-day.ts';
import { fetchTechFactorsBatch, type TechFactors } from './tw-tech-factors.ts';
import { getInstStreakMap, type InstStreakInfo } from './tw-inst-streak.ts';
import { fetchTdccBatch, type TdccInfo } from './tw-tdcc.ts';
import {
    ensureOpenApiBundle,
    type OpenApiEnrichment,
    type OpenApiMarketTape,
} from './tw-openapi-enrich.ts';

export interface FullScreenerItem extends ScannerItem {
    market: 'tse' | 'otc';
    tech_delta: number;
    streak_delta: number;
    tdcc_delta: number;
    openapi_delta: number;
    factors: {
        vol_ratio_20: number | null;
        rs_20: number | null;
        near_high_20: number | null;
        above_ma20: boolean | null;
        inst_buy_streak: number | null;
        tdcc_large_pct: number | null;
        pe: number | null;
        pb: number | null;
        yield_pct: number | null;
        revenue_yoy: number | null;
        revenue_mom: number | null;
        day_trade_pct: number | null;
        ex_div_soon: boolean | null;
        industry: string | null;
        punished: boolean;
        attention: boolean;
    };
    factor_notes: string[];
}

export interface FullScreenerResult {
    as_of: string | null;
    universe_count: number;
    liquid_count: number;
    enriched_count: number;
    openapi_stats?: {
        valuation: number;
        revenue: number;
        day_trade: number;
        punish: number;
        attention: number;
    };
    market_tape?: OpenApiMarketTape;
    items: FullScreenerItem[];
    warnings: string[];
    took_ms: number;
}

function enrichItem(
    q: TwDayQuote,
    tech: TechFactors | undefined,
    streak: InstStreakInfo | undefined,
    tdcc: TdccInfo | undefined,
    openapi: OpenApiEnrichment | undefined,
): FullScreenerItem {
    const base = dayQuoteToScannerItem(q);
    const notes: string[] = [];
    const techDelta = tech?.techDelta ?? 0;
    const streakDelta = streak?.delta ?? 0;
    const tdccDelta = tdcc?.delta ?? 0;
    const openapiDelta = openapi?.openapiDelta ?? 0;
    if (tech?.notes.length) notes.push(...tech.notes);
    if (streak?.note) notes.push(streak.note);
    if (tdcc?.note) notes.push(tdcc.note);
    if (openapi?.notes.length) notes.push(...openapi.notes);

    return {
        ...base,
        volume_ratio: tech?.volRatio20 ?? base.volume_ratio,
        yesterday_volume: tech?.avgVol20
            ? Math.round(tech.avgVol20 / 1000)
            : base.yesterday_volume,
        market: q.market,
        tech_delta: techDelta,
        streak_delta: streakDelta,
        tdcc_delta: tdccDelta,
        openapi_delta: openapiDelta,
        factors: {
            vol_ratio_20: tech?.volRatio20 ?? null,
            rs_20: tech?.rs20 ?? null,
            near_high_20: tech?.nearHigh20 ?? null,
            above_ma20: tech?.aboveMa20 ?? null,
            inst_buy_streak: streak?.streak ?? null,
            tdcc_large_pct: tdcc?.largeHolderPct ?? null,
            pe: openapi?.valuation?.pe ?? null,
            pb: openapi?.valuation?.pb ?? null,
            yield_pct: openapi?.valuation?.yieldPct ?? null,
            revenue_yoy: openapi?.revenue?.yoyPct ?? null,
            revenue_mom: openapi?.revenue?.momPct ?? null,
            day_trade_pct: openapi?.dayTrade?.ratioPct ?? null,
            ex_div_soon: openapi?.exDiv?.soon ?? null,
            industry: openapi?.profile?.industry ?? null,
            punished: openapi?.punished ?? false,
            attention: openapi?.attention ?? false,
        },
        factor_notes: notes,
    };
}

/**
 * Full-market screening candidates with open-data enrichment.
 * Not all 1900 names get Yahoo/TDCC — liquid prefilter keeps it usable.
 * OpenAPI valuation/revenue/day-trade covers the whole liquid pool cheaply.
 */
export async function runFullScreener(opts?: {
    techLimit?: number;
    tdccLimit?: number;
}): Promise<FullScreenerResult> {
    const t0 = Date.now();
    const warnings: string[] = [];
    const techLimit = opts?.techLimit ?? 120;
    const tdccLimit = opts?.tdccLimit ?? 40;

    let all: TwDayQuote[] = [];
    try {
        all = await fetchTwMarketDayAll();
    } catch (err) {
        warnings.push(
            `全市場日線失敗：${err instanceof Error ? err.message : String(err)}`,
        );
    }

    if (!all.length) {
        return {
            as_of: null,
            universe_count: 0,
            liquid_count: 0,
            enriched_count: 0,
            items: [],
            warnings: [
                ...warnings,
                'TWSE/TPEx 日線無資料（休市或 OpenAPI 暫時不可用）',
            ],
            took_ms: Date.now() - t0,
        };
    }

    // OpenAPI bundle in parallel with liquid pick (covers whole market cheaply)
    let openapiByCode = new Map<string, OpenApiEnrichment>();
    let marketTape: OpenApiMarketTape | undefined;
    let openapiStats:
        | FullScreenerResult['openapi_stats']
        | undefined;
    try {
        const bundle = await ensureOpenApiBundle();
        openapiByCode = bundle.byCode;
        marketTape = bundle.market;
        openapiStats = {
            valuation: bundle.valuationCount,
            revenue: bundle.revenueCount,
            day_trade: bundle.dayTradeCount,
            punish: bundle.punishCount,
            attention: bundle.attentionCount,
        };
        if (bundle.market.note) {
            warnings.push(bundle.market.note);
        }
    } catch (err) {
        warnings.push(
            `OpenAPI 補強失敗：${err instanceof Error ? err.message : String(err)}`,
        );
    }

    // Drop 處置股 from universe early
    const cleanAll = all.filter((q) => !openapiByCode.get(q.code)?.punished);
    const droppedPunish = all.length - cleanAll.length;
    if (droppedPunish > 0) {
        warnings.push(`已剔除處置股 ${droppedPunish} 檔`);
    }

    const liquid = pickLiquidUniverse(cleanAll.length ? cleanAll : all);
    const techPool = [...liquid]
        .sort((a, b) => b.amount - a.amount)
        .slice(0, techLimit);

    let techMap = new Map<string, TechFactors>();
    try {
        techMap = await fetchTechFactorsBatch(
            techPool.map((r) => r.code),
            6,
        );
    } catch (err) {
        warnings.push(
            `多日技術失敗：${err instanceof Error ? err.message : String(err)}`,
        );
    }

    let streakMap = new Map<string, InstStreakInfo>();
    try {
        streakMap = await getInstStreakMap(liquid.map((r) => r.code));
    } catch (err) {
        warnings.push(
            `法人連買失敗：${err instanceof Error ? err.message : String(err)}`,
        );
    }

    const provisional = liquid
        .map((q) => {
            const tech = techMap.get(q.code);
            const streak = streakMap.get(q.code);
            const oa = openapiByCode.get(q.code);
            const score =
                Math.log10(Math.max(q.amount, 1)) * 10 +
                (tech?.techDelta ?? 0) +
                (streak?.delta ?? 0) +
                (oa?.openapiDelta ?? 0) +
                (q.change > 0 ? 2 : 0);
            return { q, score };
        })
        .sort((a, b) => b.score - a.score);

    let tdccMap = new Map<string, TdccInfo>();
    try {
        tdccMap = await fetchTdccBatch(
            provisional.slice(0, tdccLimit).map((x) => x.q.code),
            3,
        );
    } catch (err) {
        warnings.push(
            `集保失敗：${err instanceof Error ? err.message : String(err)}`,
        );
    }

    const items = liquid
        .map((q) =>
            enrichItem(
                q,
                techMap.get(q.code),
                streakMap.get(q.code),
                tdccMap.get(q.code),
                openapiByCode.get(q.code),
            ),
        )
        .sort((a, b) => {
            const as =
                a.tech_delta +
                a.streak_delta +
                a.tdcc_delta +
                a.openapi_delta +
                Math.log10(Math.max(a.total_amount, 1));
            const bs =
                b.tech_delta +
                b.streak_delta +
                b.tdcc_delta +
                b.openapi_delta +
                Math.log10(Math.max(b.total_amount, 1));
            return bs - as;
        });

    return {
        as_of: all[0]?.date ?? null,
        universe_count: all.length,
        liquid_count: liquid.length,
        enriched_count: techMap.size,
        openapi_stats: openapiStats,
        market_tape: marketTape,
        items,
        warnings,
        took_ms: Date.now() - t0,
    };
}
