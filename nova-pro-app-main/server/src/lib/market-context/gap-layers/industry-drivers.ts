// server/src/lib/market-context/gap-layers/industry-drivers.ts
// Pluggable registry. SCFI/CCFI/DRAM spot unavailable → available=false (no guess).
// REUSES Yahoo copper/WTI when present.

import type { GlobalAssetQuote } from '../../market-intelligence/types.ts';
import { buildMeta } from '../freshness.ts';
import type {
    IndustryDriver,
    IndustryDriverRegistryData,
    LayerEnvelope,
} from './types.ts';

export function evaluateIndustryDrivers(
    assets: GlobalAssetQuote[],
    fetchedAt: string,
): LayerEnvelope<IndustryDriverRegistryData> {
    const byId = new Map(assets.map((a) => [a.id, a]));
    const drivers: IndustryDriver[] = [
        {
            sector: 'Memory',
            driver: 'DRAM',
            source: 'none',
            frequency: 'unknown',
            direction_semantics: 'price_up_positive_for_memory_makers',
            freshness: 'unavailable',
            confidence: 'NONE',
            available: false,
            value: null,
            change_pct: null,
            realtime_level: 'UNKNOWN',
        },
        {
            sector: 'Memory',
            driver: 'NAND',
            source: 'none',
            frequency: 'unknown',
            direction_semantics: 'price_up_positive_for_memory_makers',
            freshness: 'unavailable',
            confidence: 'NONE',
            available: false,
            value: null,
            change_pct: null,
            realtime_level: 'UNKNOWN',
        },
        {
            sector: 'Shipping',
            driver: 'SCFI',
            source: 'none',
            frequency: 'weekly',
            direction_semantics: 'freight_rate_up_positive_for_shipping',
            freshness: 'unavailable',
            confidence: 'NONE',
            available: false,
            value: null,
            change_pct: null,
            realtime_level: 'UNKNOWN',
        },
        {
            sector: 'Shipping',
            driver: 'CCFI',
            source: 'none',
            frequency: 'weekly',
            direction_semantics: 'freight_rate_up_positive_for_shipping',
            freshness: 'unavailable',
            confidence: 'NONE',
            available: false,
            value: null,
            change_pct: null,
            realtime_level: 'UNKNOWN',
        },
    ];

    // Reliable commodity proxies already in GlobalMarketService — enable only if OK
    const copper = byId.get('copper');
    if (copper?.status === 'OK' && copper.change_pct != null) {
        drivers.push({
            sector: 'Materials',
            driver: 'Copper',
            source: 'yahoo_HG=F',
            frequency: 'intraday_delayed',
            direction_semantics: 'copper_up_supportive_for_related_industrials',
            freshness: copper.freshness,
            confidence: 'MEDIUM',
            available: true,
            value: copper.value,
            change_pct: copper.change_pct,
            realtime_level: 'DELAYED',
        });
    }
    const wti = byId.get('wti');
    if (wti?.status === 'OK' && wti.change_pct != null) {
        drivers.push({
            sector: 'Energy',
            driver: 'WTI',
            source: 'yahoo_CL=F',
            frequency: 'intraday_delayed',
            direction_semantics: 'oil_up_mixed_for_tw_importers',
            freshness: wti.freshness,
            confidence: 'MEDIUM',
            available: true,
            value: wti.value,
            change_pct: wti.change_pct,
            realtime_level: 'DELAYED',
        });
    }

    const enabled = drivers.filter((d) => d.available).length;
    return {
        layer: 'IndustryDriverRegistry',
        completeness: enabled > 0 ? 'PARTIAL' : 'PARTIAL',
        available: true,
        proxy: false,
        note: 'DRAM/NAND/SCFI/CCFI disabled until reliable feed exists. Copper/WTI reused from Yahoo when available.',
        meta: buildMeta({
            source: 'industry_driver_registry',
            source_type: 'industry_drivers',
            fetched_at: fetchedAt,
            available: true,
            realtime_level: enabled > 0 ? 'DELAYED' : 'UNKNOWN',
            confidence: enabled > 0 ? 'MEDIUM' : 'LOW',
            coverage_pct: (enabled / Math.max(1, drivers.length)) * 100,
        }),
        data: { drivers },
    };
}
