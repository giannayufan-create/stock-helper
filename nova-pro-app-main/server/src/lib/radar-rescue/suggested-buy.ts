// server/src/lib/radar-rescue/suggested-buy.ts
// Decision-support entry price hint — never mutates A/B/C/BP.

import { tickSize } from '../open-gate-v2/risk-gate.ts';
import type { RescueRadarState } from './types.ts';

export interface SuggestedBuy {
    /** Primary limit / watch price (tick-rounded). */
    price: number;
    /** Soft zone for limit orders. */
    zone_low: number | null;
    zone_high: number | null;
    /** Short Chinese note for UI. */
    note: string;
}

function roundTick(price: number): number {
    if (!(price > 0) || !Number.isFinite(price)) return price;
    const t = tickSize(price);
    const rounded = Math.round(price / t) * t;
    // Avoid float junk (e.g. 10.0000000002)
    const decimals = t < 0.1 ? 2 : t < 1 ? 1 : 0;
    return Number(rounded.toFixed(decimals));
}

/**
 * Suggest a buy-in reference from attack state + VWAP / breakout / last.
 * Returns null when stale / failed / no usable price.
 */
export function computeSuggestedBuy(opts: {
    state: RescueRadarState;
    dataStale: boolean;
    lastPrice: number | null;
    vwap: number | null;
    breakoutPrice: number | null;
    triggerPrice: number | null;
    chaseRisk: string | null;
}): SuggestedBuy | null {
    if (opts.dataStale) return null;
    const last = opts.lastPrice;
    if (last == null || !(last > 0)) return null;

    const vwap = opts.vwap != null && opts.vwap > 0 ? opts.vwap : null;
    const bo =
        opts.breakoutPrice != null && opts.breakoutPrice > 0
            ? opts.breakoutPrice
            : null;
    const trig =
        opts.triggerPrice != null && opts.triggerPrice > 0
            ? opts.triggerPrice
            : null;

    switch (opts.state) {
        case 'EARLY_FAILED':
        case 'FAKE_BREAKOUT':
        case 'WEAKENING':
        case 'INVALID':
        case 'INSUFFICIENT_DATA':
        case 'DATA_STALE':
        case 'DATA_INCOMPLETE':
        case 'INACTIVE':
            return null;

        case 'PRE_ATTACK': {
            // Wait for breakout confirmation — buy above breakout, not chase mid-air.
            const confirm = bo ?? last;
            const high = roundTick(confirm + tickSize(confirm));
            const low = roundTick(confirm);
            return {
                price: high,
                zone_low: low,
                zone_high: high,
                note: '突破確認後再買（盯突破價）',
            };
        }

        case 'EARLY':
        case 'STALLING': {
            // Prefer VWAP / trigger neighbourhood — no chase.
            let ref = last;
            if (vwap != null) ref = Math.min(last, Math.max(vwap, last * 0.997));
            else if (trig != null) ref = Math.min(last, trig);
            const px = roundTick(ref);
            const low = roundTick(
                vwap != null ? Math.min(vwap, px) : px - tickSize(px),
            );
            return {
                price: px,
                zone_low: low,
                zone_high: roundTick(Math.min(last, px + tickSize(px))),
                note:
                    opts.state === 'STALLING'
                        ? '停滯中：回 VWAP／現價附近限價，勿追'
                        : '漲3%前：VWAP／現價附近限價',
            };
        }

        case 'ACTIVE':
        case 'NEAR_LIMIT': {
            // Already running — suggest pullback entry, not chase.
            const pull = bo ?? vwap ?? (trig != null ? trig : last * 0.995);
            const px = roundTick(Math.min(pull, last));
            if (
                (opts.chaseRisk === 'HIGH' || opts.chaseRisk === 'EXTREME') &&
                last > px * 1.008
            ) {
                return {
                    price: px,
                    zone_low: roundTick(px - tickSize(px)),
                    zone_high: px,
                    note: '已急攻：勿追；回檔至此再考慮',
                };
            }
            return {
                price: px,
                zone_low: roundTick(px - tickSize(px)),
                zone_high: roundTick(Math.min(last, px + tickSize(px) * 2)),
                note: '急攻中：優先等回檔至突破價／VWAP',
            };
        }

        case 'LIMIT_UP':
            return null;

        case 'PULLBACK': {
            const ref = vwap ?? last;
            const px = roundTick(ref);
            return {
                price: px,
                zone_low: roundTick(px - tickSize(px)),
                zone_high: roundTick(px + tickSize(px)),
                note: '回踩：VWAP／支撐附近限價',
            };
        }

        case 'WATCH':
        default: {
            if (vwap == null) return null;
            const px = roundTick(Math.min(last, vwap));
            return {
                price: px,
                zone_low: roundTick(px - tickSize(px)),
                zone_high: roundTick(Math.max(px, Math.min(last, vwap))),
                note: '觀察：先盯 VWAP 附近',
            };
        }
    }
}
