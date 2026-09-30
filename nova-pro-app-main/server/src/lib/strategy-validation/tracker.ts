// server/src/lib/strategy-validation/tracker.ts
// Separates: (a) post-signal price path, (b) simulated trade P&L,
// (c) real fill P&L placeholders (null until wired).

import type { RawSignalEvent } from '../strategy-signal/raw-signal-event.ts';
import { DEFAULT_TW_COST_RATES, netPnlAfterCost } from './cost-model.ts';
import { simulateTrade } from './simulator.ts';
import {
    DEFAULT_PROVISIONAL_ASSUMPTIONS,
    EXIT_DECISIONS_NEEDED,
    VALIDATION_STRATEGY_NAME,
    VALIDATION_STRATEGY_VERSION,
    type PriceBar,
    type SignalPathMetrics,
    type SimulationAssumptions,
    type ValidateSignalsInput,
    type ValidationSummary,
    type ValidationTradeRow,
} from './types.ts';

function forwardReturn(
    bars: PriceBar[],
    signalMs: number,
    priceAt: number,
    horizonMin: number,
): number | null {
    if (!(priceAt > 0)) return null;
    const target = signalMs + horizonMin * 60_000;
    // Use last bar with t <= target but t > signalMs (no future beyond horizon)
    let chosen: PriceBar | null = null;
    for (const b of bars) {
        if (b.t <= signalMs) continue;
        if (b.t > target) break;
        chosen = b;
    }
    if (!chosen) return null;
    return (chosen.close - priceAt) / priceAt;
}

function mfeMae(
    bars: PriceBar[],
    signalMs: number,
    priceAt: number,
    horizonMin: number,
): { mfe: number | null; mae: number | null } {
    if (!(priceAt > 0)) return { mfe: null, mae: null };
    const target = signalMs + horizonMin * 60_000;
    let maxHigh = -Infinity;
    let minLow = Infinity;
    let n = 0;
    for (const b of bars) {
        if (b.t <= signalMs) continue;
        if (b.t > target) break;
        maxHigh = Math.max(maxHigh, b.high);
        minLow = Math.min(minLow, b.low);
        n++;
    }
    if (n === 0) return { mfe: null, mae: null };
    return {
        mfe: (maxHigh - priceAt) / priceAt,
        mae: (minLow - priceAt) / priceAt,
    };
}

export function computeSignalPathMetrics(
    event: RawSignalEvent,
    bars: PriceBar[],
): SignalPathMetrics {
    const signalMs = Date.parse(event.signal_time);
    const after = bars.filter((b) => b.t > signalMs);
    const priceAt = event.price_at_signal;
    const invalid =
        event.exit_rules_snapshot.invalid_price != null
            ? event.exit_rules_snapshot.invalid_price
            : null;
    let invalidHit: boolean | null = invalid != null ? false : null;
    if (invalid != null) {
        for (const b of after) {
            if (b.low <= invalid) {
                invalidHit = true;
                break;
            }
        }
    }
    const m15 = mfeMae(bars, signalMs, priceAt, 15);
    const m60 = mfeMae(bars, signalMs, priceAt, 60);
    const insufficient = after.length < 3;
    return {
        signal_id: event.signal_id,
        symbol: event.symbol,
        signal_time: event.signal_time,
        price_at_signal: priceAt,
        forward_return_5m: forwardReturn(bars, signalMs, priceAt, 5),
        forward_return_15m: forwardReturn(bars, signalMs, priceAt, 15),
        forward_return_30m: forwardReturn(bars, signalMs, priceAt, 30),
        forward_return_60m: forwardReturn(bars, signalMs, priceAt, 60),
        mfe_15m: m15.mfe,
        mae_15m: m15.mae,
        mfe_60m: m60.mfe,
        mae_60m: m60.mae,
        invalid_hit: invalidHit,
        bars_after_signal: after.length,
        evaluable: after.length >= 3,
        insufficient_data: insufficient,
    };
}

function taipeiYmd(iso?: string): string {
    const d = iso ? new Date(iso) : new Date();
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

function avg(nums: number[]): number | null {
    if (nums.length === 0) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Validate a batch of raw OPEN_PASS (or filtered) events against bars.
 * Never invents profitability claims — returns labeled sim or path-only.
 */
export function validateSignals(
    input: ValidateSignalsInput,
): ValidationSummary {
    const assumptions: SimulationAssumptions | null =
        input.assumptions === null
            ? null
            : (input.assumptions ?? DEFAULT_PROVISIONAL_ASSUMPTIONS);
    const runSim =
        input.run_simulation !== false &&
        assumptions != null &&
        assumptions.assumptions_not_original_strategy === true;

    const events = input.events.filter(
        (e) =>
            e.strategy_name === VALIDATION_STRATEGY_NAME ||
            e.strategy_version === VALIDATION_STRATEGY_VERSION,
    );

    const trades: ValidationTradeRow[] = [];
    let evaluable = 0;
    let insufficient = 0;
    let filled = 0;
    let unfilled = 0;

    for (const ev of events) {
        const bars = input.barsBySymbol[ev.symbol] ?? [];
        const path = computeSignalPathMetrics(ev, bars);
        if (path.evaluable) evaluable++;
        if (path.insufficient_data) insufficient++;

        let simulated = null;
        if (runSim && assumptions) {
            simulated = simulateTrade(ev, bars, assumptions);
            if (simulated.filled && simulated.net_pnl != null) filled++;
            else if (!simulated.filled) unfilled++;
            else if (simulated.skip_reason === 'ambiguous_same_bar') unfilled++;
        }

        trades.push({
            signal_id: ev.signal_id,
            symbol: ev.symbol,
            signal_time: ev.signal_time,
            path,
            simulated,
            real_fill: {
                signal_id: ev.signal_id,
                real_fill_pnl: null,
                note: 'not_wired',
            },
        });
    }

    const simPnls = trades
        .map((t) => t.simulated)
        .filter(
            (s): s is NonNullable<typeof s> =>
                !!s && s.filled && s.net_pnl != null && !s.skip_reason,
        );
    const wins = simPnls.filter((s) => (s.net_pnl ?? 0) > 0);
    const losses = simPnls.filter((s) => (s.net_pnl ?? 0) <= 0);
    const cum = simPnls.reduce((a, s) => a + (s.net_pnl ?? 0), 0);

    // Benchmark: buy at signal price + delay, hold same max_hold, same costs
    let benchmark: ValidationSummary['benchmark'] = null;
    if (runSim && assumptions) {
        const benchPnls: number[] = [];
        for (const t of trades) {
            const ev = events.find((e) => e.signal_id === t.signal_id);
            if (!ev || !t.path.evaluable) continue;
            const bars = input.barsBySymbol[ev.symbol] ?? [];
            const signalMs = Date.parse(ev.signal_time);
            const fillMs = signalMs + assumptions.fill_delay_ms;
            const entryBar = bars.find((b) => b.t > fillMs);
            if (!entryBar || entryBar.limit_up || entryBar.no_liquidity) continue;
            const entry =
                entryBar.open * (1 + assumptions.buy_slippage_pct);
            const holdMs =
                assumptions.provisional_max_hold_minutes != null
                    ? entryBar.t +
                      assumptions.provisional_max_hold_minutes * 60_000
                    : entryBar.t + 60 * 60_000;
            let exitBar: PriceBar | null = null;
            for (const b of bars) {
                if (b.t <= entryBar.t) continue;
                if (b.t > holdMs) break;
                exitBar = b;
            }
            if (!exitBar) continue;
            const exit = exitBar.close * (1 - assumptions.sell_slippage_pct);
            const pnl = netPnlAfterCost(
                assumptions.shares_per_trade,
                entry,
                exit,
                DEFAULT_TW_COST_RATES,
            );
            benchPnls.push(pnl.net);
        }
        benchmark = {
            label: 'buy_hold_same_horizon_same_costs',
            avg_net_pnl: avg(benchPnls),
            cumulative_net_pnl: benchPnls.length
                ? benchPnls.reduce((a, b) => a + b, 0)
                : null,
            note: 'Same delay/slippage/fees/tax; hold to max_hold (no stop/TP). Not a claim of edge.',
        };
    }

    const empty = events.length === 0;

    return {
        strategy_name: VALIDATION_STRATEGY_NAME,
        strategy_version: VALIDATION_STRATEGY_VERSION,
        validation_date: input.validation_date ?? taipeiYmd(),
        data_source: input.data_source ?? 'synthetic_or_raw_store',
        source_mode: events[0]?.source_mode ?? 'synthetic',
        assumptions: runSim ? assumptions : assumptions,
        exit_decisions_needed: EXIT_DECISIONS_NEEDED,
        counts: {
            signals: events.length,
            evaluable,
            simulated_fills: filled,
            unfilled,
            insufficient_data: insufficient,
        },
        sim_stats: {
            available: runSim && simPnls.length > 0,
            assumptions_not_original_strategy:
                assumptions?.assumptions_not_original_strategy ?? true,
            avg_net_pnl: avg(simPnls.map((s) => s.net_pnl!)),
            win_rate:
                simPnls.length > 0 ? wins.length / simPnls.length : null,
            avg_win: avg(wins.map((s) => s.net_pnl!)),
            avg_loss: avg(losses.map((s) => s.net_pnl!)),
            cumulative_net_pnl: simPnls.length ? cum : null,
            max_drawdown: null,
            max_drawdown_note:
                '尚未建立部位規則，不計算投資組合回撤',
        },
        benchmark,
        trades,
        disclaimer:
            '研究驗證頁面：不代表已驗證優勢（proven edge）。' +
            '模擬損益僅在 assumptions_not_original_strategy=true 時顯示。' +
            '無實盤下單／無帳戶連線。',
        empty,
    };
}

/** Empty summary for API when no data. */
export function emptyValidationSummary(
    opts?: Partial<ValidationSummary>,
): ValidationSummary {
    return {
        strategy_name: VALIDATION_STRATEGY_NAME,
        strategy_version: VALIDATION_STRATEGY_VERSION,
        validation_date: opts?.validation_date ?? taipeiYmd(),
        data_source: opts?.data_source ?? 'none',
        source_mode: opts?.source_mode ?? 'synthetic',
        assumptions: DEFAULT_PROVISIONAL_ASSUMPTIONS,
        exit_decisions_needed: EXIT_DECISIONS_NEEDED,
        counts: {
            signals: 0,
            evaluable: 0,
            simulated_fills: 0,
            unfilled: 0,
            insufficient_data: 0,
        },
        sim_stats: {
            available: false,
            assumptions_not_original_strategy: true,
            avg_net_pnl: null,
            win_rate: null,
            avg_win: null,
            avg_loss: null,
            cumulative_net_pnl: null,
            max_drawdown: null,
            max_drawdown_note: '尚未建立部位規則，不計算投資組合回撤',
        },
        benchmark: null,
        trades: [],
        disclaimer:
            '研究驗證頁面：不代表已驗證優勢（proven edge）。尚無驗證結果。',
        empty: true,
        ...opts,
    };
}
