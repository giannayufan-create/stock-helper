// src/lib/strategy-validation.ts — OPEN_PASS fixed-strategy validation API client.

import { apiGet } from './api';

export interface StrategyValidationSummaryDto {
    strategy_name: string;
    strategy_version: string;
    validation_date: string;
    data_source: string;
    source_mode: string;
    assumptions: {
        assumptions_not_original_strategy: boolean;
        fill_delay_ms: number;
        buy_slippage_pct: number;
        sell_slippage_pct: number;
        provisional_take_profit_pct: number | null;
        provisional_stop_use_invalid_price: boolean;
        provisional_stop_loss_pct: number | null;
        provisional_max_hold_minutes: number | null;
        shares_per_trade: number;
        note: string;
    } | null;
    exit_decisions_needed: string[];
    counts: {
        signals: number;
        evaluable: number;
        simulated_fills: number;
        unfilled: number;
        insufficient_data: number;
    };
    sim_stats: {
        available: boolean;
        assumptions_not_original_strategy: boolean;
        avg_net_pnl: number | null;
        win_rate: number | null;
        avg_win: number | null;
        avg_loss: number | null;
        cumulative_net_pnl: number | null;
        max_drawdown: number | null;
        max_drawdown_note: string;
    };
    benchmark: {
        label: string;
        avg_net_pnl: number | null;
        cumulative_net_pnl: number | null;
        note: string;
    } | null;
    trades: Array<{
        signal_id: string;
        symbol: string;
        signal_time: string;
        path: {
            evaluable: boolean;
            insufficient_data: boolean;
            forward_return_15m: number | null;
            mfe_15m: number | null;
            mae_15m: number | null;
        };
        simulated: {
            filled: boolean;
            skip_reason?: string;
            net_pnl?: number;
            exit_reason?: string;
            assumptions_not_original_strategy: boolean;
        } | null;
        real_fill: { real_fill_pnl: null; note: string };
    }>;
    disclaimer: string;
    empty: boolean;
}

export function fetchStrategyValidationSummary(opts?: {
    from?: string;
    to?: string;
    demo?: boolean;
}) {
    const qs = new URLSearchParams();
    if (opts?.from) qs.set('from', opts.from);
    if (opts?.to) qs.set('to', opts.to);
    if (opts?.demo) qs.set('demo', '1');
    const suffix = qs.toString() ? `?${qs}` : '';
    return apiGet<StrategyValidationSummaryDto>(
        `/api/v1/research/strategy-validation/summary${suffix}`,
    );
}

export function moneyLabel(v: number | null | undefined, digits = 0): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toFixed(digits);
}

export function pctRateLabel(v: number | null | undefined): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return `${(v * 100).toFixed(1)}%`;
}
