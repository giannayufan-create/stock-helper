// server/src/lib/market-context/breadth-engine.ts

import type { TwDayQuote } from '../tw-market-day.ts';
import type { MarketContextConfig } from './config.ts';
import {
    buildMeta,
    confidenceFromCoverage,
    dayQuoteRealtimeLevel,
} from './freshness.ts';
import type { MarketBreadth } from './types.ts';

export function computeMarketBreadth(
    quotes: TwDayQuote[],
    cfg: MarketContextConfig,
    fetchedAt = new Date().toISOString(),
): MarketBreadth {
    let advancers = 0;
    let decliners = 0;
    let unchanged = 0;
    for (const q of quotes) {
        if (q.change > 0) advancers++;
        else if (q.change < 0) decliners++;
        else unchanged++;
    }
    const n = quotes.length;
    const adRatio =
        decliners > 0
            ? advancers / decliners
            : advancers > 0
              ? Infinity
              : null;
    const advance_decline_ratio =
        adRatio != null && Number.isFinite(adRatio)
            ? Math.round(adRatio * 1000) / 1000
            : adRatio === Infinity
              ? null
              : null;
    const advance_pct = n > 0 ? (advancers / n) * 100 : null;
    const decline_pct = n > 0 ? (decliners / n) * 100 : null;
    const coverage_pct =
        cfg.expected_universe_size > 0
            ? Math.min(100, (n / cfg.expected_universe_size) * 100)
            : 0;
    const sessionDate = quotes[0]?.date ?? null;
    const level = dayQuoteRealtimeLevel(sessionDate);

    return {
        advancers,
        decliners,
        unchanged,
        advance_decline_ratio,
        advance_pct,
        decline_pct,
        coverage_pct: Math.round(coverage_pct * 10) / 10,
        confidence: confidenceFromCoverage(coverage_pct),
        universe_size: n,
        uses_active_watch_pool: false,
        meta: buildMeta({
            source: 'TWSE_STOCK_DAY_ALL+TPEX_DAILY',
            source_type: 'exchange_day_quotes',
            observed_at: sessionDate ? `${sessionDate}T05:00:00.000Z` : null,
            published_at: sessionDate,
            fetched_at: fetchedAt,
            available: n > 0,
            coverage_pct,
            confidence: confidenceFromCoverage(coverage_pct),
            realtime_level: level,
        }),
    };
}
