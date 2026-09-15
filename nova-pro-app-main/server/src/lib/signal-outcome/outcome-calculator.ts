// server/src/lib/signal-outcome/outcome-calculator.ts
// Deterministic forward path metrics. Replay 1m: use completed bar close;
// same-bar target+invalid → outcome_sequence=ambiguous (never guess order).

import type { StrategySignal } from '../strategy-signal/types.ts';
import type {
    OutcomeSequence,
    PriceBar,
    SignalOutcome,
} from './types.ts';
import {
    FORWARD_HORIZONS_MIN,
    MFE_MAE_HORIZONS_MIN,
} from './types.ts';

function ret(ref: number, px: number): number {
    return Math.round(((px - ref) / ref) * 10000) / 100;
}

function mfe(ref: number, high: number): number {
    return Math.round((high / ref - 1) * 10000) / 100;
}

function mae(ref: number, low: number): number {
    return Math.round((low / ref - 1) * 10000) / 100;
}

/** First bar with known_at/t >= targetMs; deterministic. */
export function priceAtOrAfter(
    bars: PriceBar[],
    targetMs: number,
): PriceBar | null {
    for (const b of bars) {
        if (b.t >= targetMs) return b;
    }
    return null;
}

export function barsWithin(
    bars: PriceBar[],
    fromMs: number,
    toMs: number,
): PriceBar[] {
    return bars.filter((b) => b.t > fromMs && b.t <= toMs);
}

export function calculateOutcome(opts: {
    signal: StrategySignal;
    /** Future bars AFTER signal known time, sorted ascending by t. */
    futureBars: PriceBar[];
    /** Optional same-day close bar. */
    closeBar?: PriceBar | null;
    nowMs?: number;
}): SignalOutcome {
    const { signal, futureBars, closeBar } = opts;
    const ref = signal.reference_price;
    const signalMs = Date.parse(signal.signal_time);
    const nowMs = opts.nowMs ?? Date.now();

    const out: SignalOutcome = {
        signal_id: signal.signal_id,
        symbol: signal.symbol,
        signal_type: signal.signal_type,
        signal_time: signal.signal_time,
        reference_price: ref,
        status: 'pending',
        source_mode: signal.source_mode,
        data_resolution: signal.data_resolution,
        calculated_at: new Date(nowMs).toISOString(),
        event_kind: 'PARTIAL',
    };

    if (!(ref > 0)) {
        out.status = 'invalid_data';
        return out;
    }

    let filled = 0;
    for (const h of FORWARD_HORIZONS_MIN) {
        const target = signalMs + h * 60_000;
        const bar = priceAtOrAfter(futureBars, target);
        if (!bar) continue;
        const key = `forward_return_${h}m`;
        (out as unknown as Record<string, unknown>)[key] = ret(ref, bar.close);
        filled += 1;
    }

    if (closeBar && closeBar.t > signalMs) {
        out.close_return = ret(ref, closeBar.close);
        filled += 1;
    }

    for (const h of MFE_MAE_HORIZONS_MIN) {
        const window = barsWithin(futureBars, signalMs, signalMs + h * 60_000);
        if (!window.length) continue;
        const hi = Math.max(...window.map((b) => b.high));
        const lo = Math.min(...window.map((b) => b.low));
        const bag = out as unknown as Record<string, unknown>;
        bag[`mfe_${h}m`] = mfe(ref, hi);
        bag[`mae_${h}m`] = mae(ref, lo);
        filled += 1;
    }

    // Targets + invalid with ambiguous detection (1m)
    const invalid = signal.invalid_price;
    let hit1 = false;
    let hit2 = false;
    let hit3 = false;
    let invalidHit = false;
    let t1: number | undefined;
    let t2: number | undefined;
    let t3: number | undefined;
    let tInv: number | undefined;
    let ambiguous = false;

    for (const b of futureBars) {
        const sec = Math.round((b.t - signalMs) / 1000);
        const lvl1 = ref * 1.01;
        const lvl2 = ref * 1.02;
        const lvl3 = ref * 1.03;

        const hitPlus1 = b.high >= lvl1;
        const hitPlus2 = b.high >= lvl2;
        const hitPlus3 = b.high >= lvl3;
        const hitInv =
            invalid != null && invalid > 0 && b.low <= invalid;

        // Same bar ambiguous: target and invalid both touched
        if (
            signal.data_resolution === '1m' &&
            hitInv &&
            (hitPlus1 || hitPlus2 || hitPlus3)
        ) {
            ambiguous = true;
        }

        if (hitPlus1 && !hit1) {
            hit1 = true;
            t1 = sec;
        }
        if (hitPlus2 && !hit2) {
            hit2 = true;
            t2 = sec;
        }
        if (hitPlus3 && !hit3) {
            hit3 = true;
            t3 = sec;
        }
        if (hitInv && !invalidHit) {
            invalidHit = true;
            tInv = sec;
        }
    }

    out.hit_plus_1pct = hit1;
    out.hit_plus_2pct = hit2;
    out.hit_plus_3pct = hit3;
    out.time_to_plus_1pct_sec = t1;
    out.time_to_plus_2pct_sec = t2;
    out.time_to_plus_3pct_sec = t3;
    out.invalid_hit = invalid != null ? invalidHit : undefined;
    out.time_to_invalid_sec = tInv;

    let seq: OutcomeSequence = 'unknown';
    if (ambiguous) seq = 'ambiguous';
    else if (invalidHit && (hit1 || hit2 || hit3)) {
        // tick path could order; 1m without same-bar still unknown across bars
        // if different bars, we still don't claim order unless we track first
        seq = 'unknown';
    } else if (hit1 || hit2 || hit3) seq = 'target_only';
    else if (invalidHit) seq = 'invalid_only';
    else seq = 'neither';
    out.outcome_sequence = seq;

    const horizonComplete =
        out.forward_return_60m != null ||
        (nowMs - signalMs >= 60 * 60_000 && filled > 0);

    if (ambiguous && signal.data_resolution === '1m') {
        // Still can be complete with ambiguous flag
        out.status = horizonComplete ? 'ambiguous' : 'partial';
    } else if (horizonComplete || out.close_return != null) {
        out.status = 'complete';
        out.event_kind = 'COMPLETE';
    } else if (filled > 0) {
        out.status = 'partial';
    } else {
        out.status = 'pending';
    }

    return out;
}
