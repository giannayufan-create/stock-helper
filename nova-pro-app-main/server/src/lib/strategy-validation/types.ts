// server/src/lib/strategy-validation/types.ts
// Fixed-strategy validation types — research only; no live orders.

import type { RawSignalEvent } from '../strategy-signal/raw-signal-event.ts';

/** Chosen fixed strategy for Phase 3 validation. */
export const VALIDATION_STRATEGY_NAME = 'OPEN_PASS' as const;
export const VALIDATION_STRATEGY_VERSION = 'bc-strategy-v1' as const;

/**
 * Decisions still needed from product owner before claiming original-strategy P&L.
 * OPEN_PASS defines entry + invalid_price; not full trade exits / sizing.
 */
export const EXIT_DECISIONS_NEEDED = [
    'take_profit_pct_or_price',
    'stop_loss_pct_or_price_beyond_invalid',
    'max_hold_minutes_or_session_exit',
    'position_size_and_concurrency_rules',
    'fill_delay_and_slippage_policy',
    'day_trade_tax_rate_eligibility',
] as const;

export type ExitDecisionNeeded = (typeof EXIT_DECISIONS_NEEDED)[number];

export interface PriceBar {
    /** Bar end / known_at ms (UTC). Only bars with t > signal_time are usable. */
    t: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
    /** True when this bar is at limit-up (漲停) — no buy fill. */
    limit_up?: boolean;
    /** True when no tradeable liquidity (skip fill). */
    no_liquidity?: boolean;
}

export interface SimulationAssumptions {
    /**
     * True when exit/hold rules are provisional research assumptions,
     * NOT the original strategy definition.
     */
    assumptions_not_original_strategy: boolean;
    fill_delay_ms: number;
    /** Buy slippage as fraction of price (e.g. 0.001 = 0.1%). */
    buy_slippage_pct: number;
    /** Sell slippage as fraction of price. */
    sell_slippage_pct: number;
    /** Provisional take-profit % from entry (null = path-only / no TP). */
    provisional_take_profit_pct: number | null;
    /** Provisional stop: use invalid_price if present, else this % below entry. */
    provisional_stop_use_invalid_price: boolean;
    provisional_stop_loss_pct: number | null;
    /** Max hold from fill time; null = end of provided bars. */
    provisional_max_hold_minutes: number | null;
    shares_per_trade: number;
    note: string;
}

/** Default provisional assumptions — labeled, not claimed as strategy truth. */
export const DEFAULT_PROVISIONAL_ASSUMPTIONS: SimulationAssumptions = {
    assumptions_not_original_strategy: true,
    fill_delay_ms: 60_000,
    buy_slippage_pct: 0.001,
    sell_slippage_pct: 0.001,
    provisional_take_profit_pct: 0.02,
    provisional_stop_use_invalid_price: true,
    provisional_stop_loss_pct: 0.015,
    provisional_max_hold_minutes: 60,
    shares_per_trade: 1000,
    note:
        'Provisional research exits only. OPEN_PASS defines entry + invalid_price; ' +
        'TP/hold/sizing are NOT original strategy rules.',
};

export type FillSkipReason =
    | 'limit_up'
    | 'no_liquidity'
    | 'missing_data'
    | 'no_bar_after_delay'
    | 'ambiguous_same_bar'
    | 'insufficient_bars';

export type ExitReason =
    | 'take_profit'
    | 'stop_loss'
    | 'invalid_price'
    | 'max_hold'
    | 'end_of_data'
    | 'ambiguous_same_bar'
    | 'unfilled';

export interface SimulatedTrade {
    signal_id: string;
    symbol: string;
    filled: boolean;
    skip_reason?: FillSkipReason;
    entry_time?: string;
    entry_price?: number;
    exit_time?: string;
    exit_price?: number;
    exit_reason?: ExitReason;
    shares: number;
    gross_pnl?: number;
    fees?: number;
    tax?: number;
    net_pnl?: number;
    net_pnl_pct?: number;
    assumptions_not_original_strategy: boolean;
}

export interface SignalPathMetrics {
    signal_id: string;
    symbol: string;
    signal_time: string;
    price_at_signal: number;
    /** Forward returns after signal (not trade P&L). */
    forward_return_5m: number | null;
    forward_return_15m: number | null;
    forward_return_30m: number | null;
    forward_return_60m: number | null;
    mfe_15m: number | null;
    mae_15m: number | null;
    mfe_60m: number | null;
    mae_60m: number | null;
    invalid_hit: boolean | null;
    bars_after_signal: number;
    evaluable: boolean;
    insufficient_data: boolean;
}

export interface RealFillPlaceholder {
    signal_id: string;
    real_fill_pnl: null;
    note: 'not_wired';
}

export interface ValidationTradeRow {
    signal_id: string;
    symbol: string;
    signal_time: string;
    path: SignalPathMetrics;
    simulated: SimulatedTrade | null;
    real_fill: RealFillPlaceholder;
}

export interface ValidationSummary {
    strategy_name: string;
    strategy_version: string;
    validation_date: string;
    data_source: string;
    source_mode: string;
    assumptions: SimulationAssumptions | null;
    exit_decisions_needed: readonly ExitDecisionNeeded[];
    counts: {
        signals: number;
        evaluable: number;
        simulated_fills: number;
        unfilled: number;
        insufficient_data: number;
    };
    /** After-cost sim stats — only when assumptions present and labeled. */
    sim_stats: {
        available: boolean;
        assumptions_not_original_strategy: boolean;
        avg_net_pnl: number | null;
        win_rate: number | null;
        avg_win: number | null;
        avg_loss: number | null;
        cumulative_net_pnl: number | null;
        /** Portfolio MDD requires position/capital/concurrency rules. */
        max_drawdown: number | null;
        max_drawdown_note: string;
    };
    /** Same-cost buy&hold benchmark from signal price over same horizon. */
    benchmark: {
        label: string;
        avg_net_pnl: number | null;
        cumulative_net_pnl: number | null;
        note: string;
    } | null;
    trades: ValidationTradeRow[];
    disclaimer: string;
    empty: boolean;
}

export interface ValidateSignalsInput {
    events: RawSignalEvent[];
    /** Bars keyed by symbol; must be chronological. */
    barsBySymbol: Record<string, PriceBar[]>;
    /** Per-event bars (e.g. same-day only); overrides barsBySymbol when set. */
    barsForEvent?: (event: RawSignalEvent) => PriceBar[] | undefined;
    assumptions?: SimulationAssumptions | null;
    /** If false, skip trade sim (path metrics only). */
    run_simulation?: boolean;
    validation_date?: string;
    data_source?: string;
}
