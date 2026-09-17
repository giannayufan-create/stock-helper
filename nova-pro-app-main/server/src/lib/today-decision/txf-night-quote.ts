// server/src/lib/today-decision/txf-night-quote.ts
// TAIFEX TXF snapshot for overnight tape only — never feeds A/B/C/BP.

import type { MarketManager } from '../../providers/manager.ts';
import type { Snapshot } from '../../types/dto.ts';

export interface TxfNightQuote {
    at: number;
    pct: number | null;
    price: number | null;
    code: string | null;
}

let cache: TxfNightQuote | null = null;
let inFlight: Promise<TxfNightQuote> | null = null;

export function getTxfNightQuote(): TxfNightQuote | null {
    return cache;
}

function pctFromSnap(s: Snapshot): number | null {
    if (Number.isFinite(s.change_rate)) return s.change_rate;
    if (s.close > 0 && Number.isFinite(s.change_price) && s.change_price !== 0) {
        const prev = s.close - s.change_price;
        if (prev > 0) return (s.change_price / prev) * 100;
    }
    return null;
}

export async function refreshTxfNightQuote(
    market: MarketManager,
): Promise<TxfNightQuote> {
    if (cache && Date.now() - cache.at < 25_000) return cache;
    if (inFlight) return inFlight;
    inFlight = (async () => {
        try {
            const snaps = await market.snapshots([
                {
                    security_type: 'FUT',
                    exchange: 'TAIFEX',
                    code: 'TXFR1',
                },
            ]);
            const s = snaps[0];
            cache = {
                at: Date.now(),
                pct: s ? pctFromSnap(s) : null,
                price: s && s.close > 0 ? s.close : null,
                code: s?.code ?? null,
            };
        } catch {
            cache = {
                at: Date.now(),
                pct: null,
                price: null,
                code: null,
            };
        }
        return cache;
    })().finally(() => {
        inFlight = null;
    });
    return inFlight;
}
