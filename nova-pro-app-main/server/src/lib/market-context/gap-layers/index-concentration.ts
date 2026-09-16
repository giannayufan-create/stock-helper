// server/src/lib/market-context/gap-layers/index-concentration.ts
// PROXY via turnover weights — official index weights not wired.

import type { TwDayQuote } from '../../tw-market-day.ts';
import { buildMeta, dayQuoteRealtimeLevel } from '../freshness.ts';
import { avgChangePct, computeLargeSmallRs } from '../taiwan-regime.ts';
import type {
    IndexConcentrationData,
    IndexConcentrationState,
    LayerEnvelope,
} from './types.ts';

function changePct(q: TwDayQuote): number {
    const prior = q.close - q.change;
    return prior > 0 ? (q.change / prior) * 100 : 0;
}

export function evaluateIndexConcentration(
    quotes: TwDayQuote[],
    breadthAdvancePct: number | null,
    fetchedAt: string,
): LayerEnvelope<IndexConcentrationData> {
    if (quotes.length < 50) {
        return {
            layer: 'IndexConcentrationContext',
            completeness: 'UNAVAILABLE',
            available: false,
            proxy: true,
            note: 'Insufficient day quotes.',
            meta: buildMeta({
                source: 'TWSE_TPEX_DAY_QUOTES',
                source_type: 'index_concentration',
                fetched_at: fetchedAt,
                available: false,
                realtime_level: 'UNKNOWN',
                confidence: 'NONE',
            }),
            data: {
                state: 'UNAVAILABLE',
                top1_contribution: null,
                top5_contribution: null,
                large_cap_strength: null,
                small_mid_strength: null,
                breadth: breadthAdvancePct,
                weight_source: 'NONE',
            },
        };
    }

    const sorted = [...quotes]
        .filter((q) => q.amount > 0)
        .sort((a, b) => b.amount - a.amount);
    const totalAmt = sorted.reduce((a, q) => a + q.amount, 0) || 1;
    // PROXY: contribution ≈ turnover share × signed change (not official free-float weight)
    const contrib = (q: TwDayQuote) =>
        (q.amount / totalAmt) * changePct(q);

    const top1 = sorted[0] ? contrib(sorted[0]) : null;
    const top5 = sorted
        .slice(0, 5)
        .reduce((a, q) => a + contrib(q), 0);

    const largeN = Math.max(20, Math.floor(sorted.length * 0.15));
    const large = sorted.slice(0, largeN);
    const small = sorted.slice(Math.floor(sorted.length * 0.5));
    const large_cap_strength = avgChangePct(large, () => true);
    const small_mid_strength = avgChangePct(small, () => true);
    const rs = computeLargeSmallRs(quotes);
    const marketAvg = avgChangePct(quotes, () => true) ?? 0;
    const adv = breadthAdvancePct ?? 50;

    let state: IndexConcentrationState = 'NARROW_MARKET';
    if (marketAvg > 0.3 && adv >= 55) state = 'BROAD_RALLY';
    else if (marketAvg < -0.3 && adv <= 45) state = 'BROAD_WEAKNESS';
    else if (rs != null && rs > 0.4 && marketAvg > 0) state = 'LARGE_CAP_LED';
    else if (rs != null && rs < -0.4 && marketAvg > 0) state = 'SMALL_CAP_LED';
    else if (adv < 40 || (top5 != null && Math.abs(top5) > Math.abs(marketAvg) * 0.6))
        state = 'NARROW_MARKET';

    const session = quotes[0]?.date ?? null;
    const level = dayQuoteRealtimeLevel(session);

    return {
        layer: 'IndexConcentrationContext',
        completeness: 'PARTIAL',
        available: true,
        proxy: true,
        note: 'PROXY — contribution estimated from turnover×change, not official index weights.',
        meta: buildMeta({
            source: 'TWSE_TPEX_DAY_QUOTES',
            source_type: 'index_concentration',
            observed_at: session ? `${session}T05:00:00.000Z` : null,
            published_at: session,
            fetched_at: fetchedAt,
            available: true,
            realtime_level: level,
            confidence: 'LOW',
            coverage_pct: Math.min(100, (quotes.length / 1000) * 100),
        }),
        data: {
            state,
            top1_contribution: top1 != null ? Math.round(top1 * 1000) / 1000 : null,
            top5_contribution: Math.round(top5 * 1000) / 1000,
            large_cap_strength:
                large_cap_strength != null
                    ? Math.round(large_cap_strength * 100) / 100
                    : null,
            small_mid_strength:
                small_mid_strength != null
                    ? Math.round(small_mid_strength * 100) / 100
                    : null,
            breadth: breadthAdvancePct,
            weight_source: 'PROXY_TURNOVER',
        },
    };
}
