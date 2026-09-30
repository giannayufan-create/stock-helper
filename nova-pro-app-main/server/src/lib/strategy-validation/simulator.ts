// server/src/lib/strategy-validation/simulator.ts
// Simulate fills AFTER signal time only — no future leak into entry decision.

import { netPnlAfterCost, type TwCostRates, DEFAULT_TW_COST_RATES } from './cost-model.ts';
import type {
    ExitReason,
    FillSkipReason,
    PriceBar,
    SimulatedTrade,
    SimulationAssumptions,
} from './types.ts';
import type { RawSignalEvent } from '../strategy-signal/raw-signal-event.ts';

function iso(ms: number): string {
    return new Date(ms).toISOString();
}

function barsAfter(
    bars: PriceBar[],
    afterMs: number,
): PriceBar[] {
    // Strictly after signal/fill time — no same-ms lookahead as fill if needed
    return bars.filter((b) => b.t > afterMs);
}

/**
 * Same-bar stop+target: both high and low would trigger in one bar.
 * Ambiguous sequence — NOT a favorable assumption (no auto win).
 */
export function sameBarAmbiguous(
    bar: PriceBar,
    stop: number | null,
    target: number | null,
): boolean {
    if (stop == null || target == null) return false;
    const hitStop = bar.low <= stop;
    const hitTarget = bar.high >= target;
    return hitStop && hitTarget;
}

export function simulateTrade(
    event: RawSignalEvent,
    bars: PriceBar[],
    assumptions: SimulationAssumptions,
    costRates: TwCostRates = DEFAULT_TW_COST_RATES,
): SimulatedTrade {
    const base: SimulatedTrade = {
        signal_id: event.signal_id,
        symbol: event.symbol,
        filled: false,
        shares: assumptions.shares_per_trade,
        assumptions_not_original_strategy:
            assumptions.assumptions_not_original_strategy,
    };

    if (!assumptions.assumptions_not_original_strategy) {
        // Safety: refuse unlabeled sim when strategy exits incomplete
        return {
            ...base,
            skip_reason: 'missing_data',
            exit_reason: 'unfilled',
        };
    }

    const signalMs = Date.parse(event.signal_time);
    if (!Number.isFinite(signalMs)) {
        return { ...base, skip_reason: 'missing_data', exit_reason: 'unfilled' };
    }

    const fillEligibleMs = signalMs + assumptions.fill_delay_ms;
    const afterSignal = barsAfter(bars, signalMs);
    if (afterSignal.length === 0) {
        return {
            ...base,
            skip_reason: 'insufficient_bars',
            exit_reason: 'unfilled',
        };
    }

    const afterDelay = barsAfter(bars, fillEligibleMs);
    if (afterDelay.length === 0) {
        return {
            ...base,
            skip_reason: 'no_bar_after_delay',
            exit_reason: 'unfilled',
        };
    }

    const fillBar = afterDelay[0]!;
    if (fillBar.limit_up) {
        return { ...base, skip_reason: 'limit_up', exit_reason: 'unfilled' };
    }
    if (fillBar.no_liquidity || !(fillBar.open > 0)) {
        return {
            ...base,
            skip_reason: fillBar.no_liquidity ? 'no_liquidity' : 'missing_data',
            exit_reason: 'unfilled',
        };
    }

    const entryPrice =
        fillBar.open * (1 + assumptions.buy_slippage_pct);
    const entryTime = iso(fillBar.t);

    const invalidPx =
        assumptions.provisional_stop_use_invalid_price &&
        event.exit_rules_snapshot.invalid_price != null
            ? event.exit_rules_snapshot.invalid_price
            : null;
    const stopFromPct =
        assumptions.provisional_stop_loss_pct != null
            ? entryPrice * (1 - assumptions.provisional_stop_loss_pct)
            : null;
    const stopPx =
        invalidPx != null
            ? invalidPx
            : stopFromPct;
    const targetPx =
        assumptions.provisional_take_profit_pct != null
            ? entryPrice * (1 + assumptions.provisional_take_profit_pct)
            : null;
    const maxHoldMs =
        assumptions.provisional_max_hold_minutes != null
            ? fillBar.t + assumptions.provisional_max_hold_minutes * 60_000
            : null;

    // Walk bars strictly after fill bar
    const path = barsAfter(bars, fillBar.t);
    let exitPrice: number | null = null;
    let exitTime: string | null = null;
    let exitReason: ExitReason = 'end_of_data';
    let skip: FillSkipReason | undefined;

    for (const bar of path) {
        if (maxHoldMs != null && bar.t > maxHoldMs) {
            exitPrice = bar.open * (1 - assumptions.sell_slippage_pct);
            exitTime = iso(bar.t);
            exitReason = 'max_hold';
            break;
        }

        if (sameBarAmbiguous(bar, stopPx, targetPx)) {
            // Ambiguous — do NOT pick the favorable exit
            skip = 'ambiguous_same_bar';
            exitReason = 'ambiguous_same_bar';
            break;
        }

        if (stopPx != null && bar.low <= stopPx) {
            exitPrice = stopPx * (1 - assumptions.sell_slippage_pct);
            exitTime = iso(bar.t);
            exitReason =
                invalidPx != null && stopPx === invalidPx
                    ? 'invalid_price'
                    : 'stop_loss';
            break;
        }
        if (targetPx != null && bar.high >= targetPx) {
            exitPrice = targetPx * (1 - assumptions.sell_slippage_pct);
            exitTime = iso(bar.t);
            exitReason = 'take_profit';
            break;
        }
    }

    if (skip === 'ambiguous_same_bar') {
        return {
            ...base,
            filled: true,
            entry_time: entryTime,
            entry_price: entryPrice,
            skip_reason: 'ambiguous_same_bar',
            exit_reason: 'ambiguous_same_bar',
        };
    }

    if (exitPrice == null) {
        // End of data — mark to last bar close after fill (still after signal)
        const last = path[path.length - 1] ?? fillBar;
        exitPrice = last.close * (1 - assumptions.sell_slippage_pct);
        exitTime = iso(last.t);
        exitReason = 'end_of_data';
    }

    const pnl = netPnlAfterCost(
        assumptions.shares_per_trade,
        entryPrice,
        exitPrice,
        costRates,
    );

    return {
        ...base,
        filled: true,
        entry_time: entryTime,
        entry_price: entryPrice,
        exit_time: exitTime ?? undefined,
        exit_price: exitPrice,
        exit_reason: exitReason,
        gross_pnl: pnl.gross,
        fees: pnl.fees,
        tax: pnl.tax,
        net_pnl: pnl.net,
        net_pnl_pct:
            entryPrice > 0 ? (exitPrice - entryPrice) / entryPrice : undefined,
    };
}
