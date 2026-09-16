// server/src/lib/market-context/gap-layers/futures-lead.ts
// Reads existing runtime states only — NEVER creates futures subscriptions / mutates C/BP.

import { buildMeta } from '../freshness.ts';
import type { MarketRuntime } from '../../market-runtime/index.ts';
import type {
    FuturesLeadData,
    FuturesLeadState,
    LayerEnvelope,
} from './types.ts';

function mom(st: { last_price: number; prev_close: number } | undefined): number | null {
    if (!st || st.prev_close <= 0 || st.last_price <= 0) return null;
    return ((st.last_price - st.prev_close) / st.prev_close) * 100;
}

export function evaluateFuturesLead(
    runtime: MarketRuntime,
    fetchedAt: string,
): LayerEnvelope<FuturesLeadData> {
    const taiex = runtime.getState('IX0001');
    const tx =
        runtime.getState('TXFR1') ??
        runtime.getState('TXF') ??
        runtime.getState('TX');
    const te = runtime.getState('TEFR1') ?? runtime.getState('TE');
    const sof = runtime.getState('SOFTX') ?? runtime.getState('SOF');

    const spot_momentum = mom(taiex);
    const futures_momentum = mom(tx);
    const basis =
        taiex && tx && taiex.last_price > 0 && tx.last_price > 0
            ? tx.last_price - taiex.last_price
            : null;
    const basis_pct =
        basis != null && taiex && taiex.last_price > 0
            ? (basis / taiex.last_price) * 100
            : null;

    const available = Boolean(taiex && tx);
    let state: FuturesLeadState = 'UNAVAILABLE';
    if (available && futures_momentum != null && spot_momentum != null) {
        const diff = futures_momentum - spot_momentum;
        if (Math.abs(diff) < 0.15) state = 'CONFIRMED';
        else if (diff >= 0.4) state = 'FUTURES_LEADING_STRONG';
        else if (diff >= 0.15) state = 'FUTURES_LEADING_WEAK';
        else if (diff <= -0.25) state = 'DIVERGENCE';
        else state = 'CONFIRMED';
    }

    const data: FuturesLeadData = {
        state,
        basis,
        basis_pct,
        basis_change: null, // needs history buffer — not invented
        futures_momentum,
        spot_momentum,
        lead_lag_30s: null,
        lead_lag_60s: null,
        lead_lag_120s: null,
        symbols: {
            tx: Boolean(tx),
            te: Boolean(te),
            sof: Boolean(sof),
            taiex: Boolean(taiex),
        },
    };

    return {
        layer: 'FuturesLeadContext',
        completeness: available
            ? te || sof
                ? 'PARTIAL'
                : 'PARTIAL'
            : 'UNAVAILABLE',
        available,
        proxy: false,
        note: available
            ? 'Lead-lag 30/60/120s requires tick history buffer — not fabricated. TE/SOF only if already subscribed.'
            : 'TX/TAIEX not in runtime (no new subscription created).',
        meta: buildMeta({
            source: 'market_runtime_existing_states',
            source_type: 'futures_lead',
            fetched_at: fetchedAt,
            available,
            realtime_level: available ? 'REALTIME' : 'UNKNOWN',
            confidence: available ? 'MEDIUM' : 'NONE',
            coverage_pct: available ? (te || sof ? 70 : 50) : 0,
        }),
        data,
    };
}
