// server/src/lib/market-context/gap-layers/derivatives-positioning.ts
// Best-effort TAIFEX public PC ratio; else available=false — never invent OI.

import { buildMeta } from '../freshness.ts';
import type {
    DerivativesPositioningData,
    DerivativesState,
    LayerEnvelope,
} from './types.ts';

async function tryFetchTaifexPcRatio(): Promise<{
    ratio: number;
    asOf: string | null;
} | null> {
    // TAIFEX daily PC ratio JSON (public). Fail soft.
    const urls = [
        'https://www.taifex.com.tw/cht/3/pcRatioDown',
    ];
    for (const url of urls) {
        try {
            const res = await fetch(url, {
                signal: AbortSignal.timeout(10000),
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; stock-helper/1.0)',
                    Accept: 'application/json,text/html,*/*',
                },
            });
            if (!res.ok) continue;
            const ct = res.headers.get('content-type') ?? '';
            if (!ct.includes('json')) {
                // HTML form download page — not parseable here
                return null;
            }
            const json = (await res.json()) as unknown;
            // Unknown schema — refuse to invent
            if (!json || typeof json !== 'object') return null;
            return null;
        } catch {
            /* try next */
        }
    }
    return null;
}

export async function evaluateDerivativesPositioning(
    fetchedAt: string,
): Promise<LayerEnvelope<DerivativesPositioningData>> {
    const pc = await tryFetchTaifexPcRatio();
    if (!pc) {
        return {
            layer: 'DerivativesPositioningContext',
            completeness: 'UNAVAILABLE',
            available: false,
            proxy: false,
            note: 'TAIFEX Put/Call / OI / foreign futures not reliably parseable without paid API — no fabricated values.',
            meta: buildMeta({
                source: 'TAIFEX_PUBLIC',
                source_type: 'derivatives_positioning',
                fetched_at: fetchedAt,
                available: false,
                realtime_level: 'PREVIOUS_DAY',
                confidence: 'NONE',
                coverage_pct: 0,
            }),
            data: {
                state: 'UNAVAILABLE',
                put_call_ratio: null,
                futures_oi: null,
                options_oi: null,
                foreign_futures_position: null,
                institutional_positioning: null,
                as_of: null,
            },
        };
    }

    let state: DerivativesState = 'DERIVATIVES_NEUTRAL';
    if (pc.ratio < 0.7) state = 'DERIVATIVES_RISK_ON';
    else if (pc.ratio > 1.2) state = 'DERIVATIVES_RISK_OFF';

    return {
        layer: 'DerivativesPositioningContext',
        completeness: 'PARTIAL',
        available: true,
        proxy: false,
        note: 'PC ratio only; OI / foreign positioning still unavailable.',
        meta: buildMeta({
            source: 'TAIFEX_PUBLIC',
            source_type: 'derivatives_positioning',
            published_at: pc.asOf,
            fetched_at: fetchedAt,
            available: true,
            realtime_level: 'PREVIOUS_DAY',
            confidence: 'LOW',
            coverage_pct: 25,
        }),
        data: {
            state,
            put_call_ratio: pc.ratio,
            futures_oi: null,
            options_oi: null,
            foreign_futures_position: null,
            institutional_positioning: null,
            as_of: pc.asOf,
        },
    };
}
