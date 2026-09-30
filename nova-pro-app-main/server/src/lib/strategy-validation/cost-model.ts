// server/src/lib/strategy-validation/cost-model.ts
// Taiwan stock fee/tax assumptions for research simulation only.
// Rates are documented assumptions — verify against broker schedule before production use.

/**
 * Source / as-of for TW cash equity round-trip cost assumptions.
 * Not legal advice; broker discounts vary.
 */
export const TW_COST_ASSUMPTIONS_AS_OF = '2026-03-01';
export const TW_COST_ASSUMPTIONS_SOURCE =
    'TWSE/broker common schedule (commission ~0.1425% per side; securities ' +
    'transaction tax 0.3% on sell for listed stocks; day-trade tax reduction ' +
    'not applied unless explicitly enabled). Research assumption only.';

export interface TwCostRates {
    /** Commission rate per side (buy and sell), fraction of notional. */
    commission_rate_per_side: number;
    /** Minimum commission TWD per side (many brokers floor ~20). */
    commission_min_twd: number;
    /** Securities transaction tax on sell notional (regular). */
    sell_tax_rate: number;
    /** Optional day-trade sell tax; unused unless apply_day_trade_tax=true. */
    day_trade_sell_tax_rate: number;
    apply_day_trade_tax: boolean;
    as_of: string;
    source: string;
}

export const DEFAULT_TW_COST_RATES: TwCostRates = {
    commission_rate_per_side: 0.001425,
    commission_min_twd: 20,
    sell_tax_rate: 0.003,
    day_trade_sell_tax_rate: 0.0015,
    apply_day_trade_tax: false,
    as_of: TW_COST_ASSUMPTIONS_AS_OF,
    source: TW_COST_ASSUMPTIONS_SOURCE,
};

export interface RoundTripCost {
    buy_notional: number;
    sell_notional: number;
    buy_commission: number;
    sell_commission: number;
    tax: number;
    total_fees: number;
    total_tax: number;
    total_cost: number;
}

function commission(notional: number, rates: TwCostRates): number {
    const raw = notional * rates.commission_rate_per_side;
    return Math.max(raw, rates.commission_min_twd);
}

/** Round-trip cost for a long equity trade (shares * prices). */
export function roundTripCost(
    shares: number,
    entryPrice: number,
    exitPrice: number,
    rates: TwCostRates = DEFAULT_TW_COST_RATES,
): RoundTripCost {
    const buy_notional = shares * entryPrice;
    const sell_notional = shares * exitPrice;
    const buy_commission = commission(buy_notional, rates);
    const sell_commission = commission(sell_notional, rates);
    const taxRate = rates.apply_day_trade_tax
        ? rates.day_trade_sell_tax_rate
        : rates.sell_tax_rate;
    const tax = sell_notional * taxRate;
    const total_fees = buy_commission + sell_commission;
    return {
        buy_notional,
        sell_notional,
        buy_commission,
        sell_commission,
        tax,
        total_fees,
        total_tax: tax,
        total_cost: total_fees + tax,
    };
}

export function netPnlAfterCost(
    shares: number,
    entryPrice: number,
    exitPrice: number,
    rates: TwCostRates = DEFAULT_TW_COST_RATES,
): { gross: number; net: number; fees: number; tax: number } {
    const gross = shares * (exitPrice - entryPrice);
    const c = roundTripCost(shares, entryPrice, exitPrice, rates);
    return {
        gross,
        net: gross - c.total_cost,
        fees: c.total_fees,
        tax: c.total_tax,
    };
}
