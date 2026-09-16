// server/src/lib/market-context/gap-layers/crowding.ts
// REUSES tw-chips — always EOD / PREVIOUS_DAY. Never realtime.

import { ensureTwChipsLoaded } from '../../tw-chips.ts';
import { buildMeta } from '../freshness.ts';
import type { CrowdingData, CrowdingState, LayerEnvelope } from './types.ts';

export async function evaluateCrowding(
    fetchedAt: string,
): Promise<LayerEnvelope<CrowdingData>> {
    try {
        const bundle = await ensureTwChipsLoaded();
        const rows = [...bundle.byCode.values()];
        if (!rows.length) {
            return unavailable(fetchedAt, 'chips empty');
        }

        const n = rows.length;
        const marginBal = rows.reduce((a, r) => a + r.marginBal, 0);
        const marginDelta = rows.reduce((a, r) => a + r.marginDelta, 0);
        const shortBal = rows.reduce((a, r) => a + r.shortBal, 0);
        const shortDelta = rows.reduce((a, r) => a + r.shortDelta, 0);

        const marginUp = rows.filter((r) => r.marginDelta > 0).length / n;
        const shortUp = rows.filter((r) => r.shortDelta > 0).length / n;

        let state: CrowdingState = 'NORMAL';
        if (marginUp >= 0.55 && marginDelta > 0) state = 'LEVERAGE_BUILDING';
        else if (shortUp >= 0.55 && shortDelta > 0) state = 'SHORT_CROWDING';
        // day_trade_ratio not in tw-chips aggregate — leave null (no invent)

        return {
            layer: 'CrowdingContext',
            completeness: 'PARTIAL',
            available: true,
            proxy: false,
            note: 'EOD/PREVIOUS_DAY only. day_trade_ratio / lending sell not in chips feed — null.',
            meta: buildMeta({
                source: 'TWSE_TPEX_MARGIN_SHORT_OPEN_DATA',
                source_type: 'crowding',
                observed_at: bundle.asOf ? `${bundle.asOf}T05:00:00.000Z` : null,
                published_at: bundle.asOf,
                fetched_at: fetchedAt,
                available: true,
                realtime_level: 'PREVIOUS_DAY',
                confidence: 'MEDIUM',
                coverage_pct: Math.min(100, (n / 800) * 100),
            }),
            data: {
                state,
                margin_balance: marginBal,
                margin_delta: marginDelta,
                short_balance: shortBal,
                short_delta: shortDelta,
                securities_lending_sell_balance: null,
                day_trade_ratio: null,
                sample_symbols: n,
                realtime_level: 'PREVIOUS_DAY',
            },
        };
    } catch (e) {
        return unavailable(
            fetchedAt,
            e instanceof Error ? e.message : 'chips load failed',
        );
    }
}

function unavailable(
    fetchedAt: string,
    note: string,
): LayerEnvelope<CrowdingData> {
    return {
        layer: 'CrowdingContext',
        completeness: 'UNAVAILABLE',
        available: false,
        proxy: false,
        note,
        meta: buildMeta({
            source: 'TWSE_TPEX_MARGIN_SHORT_OPEN_DATA',
            source_type: 'crowding',
            fetched_at: fetchedAt,
            available: false,
            realtime_level: 'PREVIOUS_DAY',
            confidence: 'NONE',
        }),
        data: {
            state: 'UNAVAILABLE',
            margin_balance: null,
            margin_delta: null,
            short_balance: null,
            short_delta: null,
            securities_lending_sell_balance: null,
            day_trade_ratio: null,
            sample_symbols: 0,
            realtime_level: 'PREVIOUS_DAY',
        },
    };
}
