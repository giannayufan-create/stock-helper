// server/src/lib/market-context/gap-layers/asia-regime.ts
// REUSES GlobalMarketService Asia quotes — does not fork GlobalRegime.

import type { GlobalAssetQuote } from '../../market-intelligence/types.ts';
import { buildMeta } from '../freshness.ts';
import type {
    AsiaIndexRow,
    AsiaRegimeData,
    AsiaRegimeState,
    AsiaVsTaiwan,
    LayerEnvelope,
} from './types.ts';

const ASIA_IDS = ['nikkei', 'kospi', 'hsi', 'shanghai', 'csi300'] as const;

function trend(chg: number | null): AsiaIndexRow['intraday_trend'] {
    if (chg == null || !Number.isFinite(chg)) return 'UNKNOWN';
    if (chg > 0.15) return 'UP';
    if (chg < -0.15) return 'DOWN';
    return 'FLAT';
}

export function evaluateAsiaRegime(
    assets: GlobalAssetQuote[],
    taiwanRegime: string | null,
    fetchedAt: string,
): LayerEnvelope<AsiaRegimeData> {
    const byId = new Map(assets.map((a) => [a.id, a]));
    const indices: AsiaIndexRow[] = ASIA_IDS.map((id) => {
        const a = byId.get(id);
        const pct = a?.change_pct ?? null;
        return {
            id,
            name: a?.name ?? id,
            change_pct: pct,
            intraday_trend: trend(pct),
            freshness: a?.freshness ?? 'unknown',
            realtime_level: 'DELAYED',
            available: Boolean(a && a.status === 'HEALTHY' && pct != null),
        };
    });

    const avail = indices.filter((i) => i.available && i.change_pct != null);
    const avg =
        avail.length > 0
            ? avail.reduce((s, i) => s + (i.change_pct ?? 0), 0) / avail.length
            : null;

    let state: AsiaRegimeState = 'UNAVAILABLE';
    if (avg != null) {
        if (avg >= 0.5) state = 'ASIA_RISK_ON';
        else if (avg <= -0.5) state = 'ASIA_RISK_OFF';
        else state = 'ASIA_NEUTRAL';
    }

    let vs: AsiaVsTaiwan = 'UNKNOWN';
    const tw = taiwanRegime ?? '';
    if (state !== 'UNAVAILABLE' && tw) {
        const twOn = tw.startsWith('RISK_ON');
        const twOff = tw.startsWith('RISK_OFF');
        if (
            (state === 'ASIA_RISK_ON' && twOn) ||
            (state === 'ASIA_RISK_OFF' && twOff) ||
            (state === 'ASIA_NEUTRAL' && tw === 'NEUTRAL')
        ) {
            vs = 'ASIA_CONFIRMED';
        } else if (
            (state === 'ASIA_RISK_ON' && twOff) ||
            (state === 'ASIA_RISK_OFF' && twOn)
        ) {
            vs = 'ASIA_DIVERGENCE';
        } else {
            vs = 'ASIA_CONFIRMED';
        }
    }

    return {
        layer: 'AsiaRegime',
        completeness: avail.length >= 3 ? 'FULL' : avail.length > 0 ? 'PARTIAL' : 'UNAVAILABLE',
        available: avail.length > 0,
        proxy: false,
        note: 'Reuses Yahoo Asia quotes from GlobalMarketService; CSI300 added when Yahoo returns.',
        meta: buildMeta({
            source: 'yahoo_via_global_market_service',
            source_type: 'asia_regime',
            fetched_at: fetchedAt,
            available: avail.length > 0,
            realtime_level: 'DELAYED',
            confidence: avail.length >= 3 ? 'MEDIUM' : 'LOW',
            coverage_pct: (avail.length / ASIA_IDS.length) * 100,
        }),
        data: {
            state,
            vs_taiwan: vs,
            taiwan_regime: taiwanRegime,
            indices,
        },
    };
}
