// server/src/lib/strategy-validation/strategy-validation.test.ts
// Run: npx tsx src/lib/strategy-validation/strategy-validation.test.ts

import assert from 'node:assert/strict';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emergencySweep, sweepOldLogs } from '../data-janitor.ts';
import type { DayBars } from '../historical-replay/historical-data-loader.ts';
import { RawSignalStore } from '../strategy-signal/raw-signal-store.ts';
import {
    CachedValidationBarSource,
    toPriceBars,
    twLimitUpPrice,
    type ValidationBarSource,
} from './bar-source.ts';
import {
    RAW_SIGNAL_EVENT_SCHEMA,
    type RawSignalEvent,
} from '../strategy-signal/raw-signal-event.ts';
import { netPnlAfterCost, TW_COST_ASSUMPTIONS_AS_OF } from './cost-model.ts';
import { sameBarAmbiguous, simulateTrade } from './simulator.ts';
import {
    StrategyValidationService,
    VALIDATION_DATA_START_YMD,
} from './service.ts';
import { computeSignalPathMetrics, validateSignals } from './tracker.ts';
import {
    DEFAULT_PROVISIONAL_ASSUMPTIONS,
    type PriceBar,
} from './types.ts';

let passed = 0;
function pass(name: string) {
    passed++;
    console.log(`PASS ${name}`);
}

const T0 = Date.parse('2026-09-25T01:30:00.000Z'); // ~09:30 Taipei

function bar(
    offsetMin: number,
    o: number,
    h: number,
    l: number,
    c: number,
    extra?: Partial<PriceBar>,
): PriceBar {
    return {
        t: T0 + offsetMin * 60_000,
        open: o,
        high: h,
        low: l,
        close: c,
        ...extra,
    };
}

function event(partial?: Partial<RawSignalEvent>): RawSignalEvent {
    return {
        signal_id: partial?.signal_id ?? 'sv_001',
        symbol: partial?.symbol ?? '2330',
        strategy_name: partial?.strategy_name ?? 'OPEN_PASS',
        strategy_version: partial?.strategy_version ?? 'bc-strategy-v1',
        config_hash: partial?.config_hash ?? 'cfg',
        signal_time: partial?.signal_time ?? new Date(T0).toISOString(),
        observation_time:
            partial?.observation_time ?? new Date(T0).toISOString(),
        data_source: partial?.data_source ?? 'synthetic',
        source_mode: partial?.source_mode ?? 'synthetic',
        price_at_signal: partial?.price_at_signal ?? 100,
        scores: partial?.scores ?? { final_open_score: 80 },
        trigger_conditions: partial?.trigger_conditions ?? {
            tradeable_candidate: true,
        },
        key_inputs: partial?.key_inputs ?? {},
        data_completeness: partial?.data_completeness ?? {
            learning_eligible: true,
        },
        exit_rules_snapshot: {
            invalid_price: 97,
            ...partial?.exit_rules_snapshot,
        },
        schema_version: RAW_SIGNAL_EVENT_SCHEMA,
    };
}

// ---- cost model documented ----
assert.ok(TW_COST_ASSUMPTIONS_AS_OF);
const c = netPnlAfterCost(1000, 100, 102);
assert.ok(c.net < c.gross);
pass('cost_model_reduces_gross');

// ---- no future leak: bars before signal ignored for fill ----
{
    const bars: PriceBar[] = [
        bar(-5, 99, 101, 98, 100), // before signal — must not use
        bar(0.5, 100, 100.5, 99.5, 100.2), // still before delay (1m)
        bar(2, 100.5, 103, 100, 102), // after 1m delay → fill
        bar(5, 102, 104, 101, 103),
        bar(10, 103, 105, 102, 104),
    ];
    const assumptions = {
        ...DEFAULT_PROVISIONAL_ASSUMPTIONS,
        fill_delay_ms: 60_000,
        provisional_take_profit_pct: 0.05,
        provisional_stop_loss_pct: 0.1,
        provisional_max_hold_minutes: 30,
    };
    const trade = simulateTrade(event(), bars, assumptions);
    assert.equal(trade.filled, true);
    assert.ok(trade.entry_time);
    assert.ok(Date.parse(trade.entry_time!) > T0 + 60_000 - 1);
    // Entry from bar at +2m open with slippage, not pre-signal bar
    assert.ok(Math.abs(trade.entry_price! - 100.5 * 1.001) < 1e-6);
    pass('no_future_leak_fill_after_delay');
}

// ---- limit-up / no liquidity → unfilled ----
{
    const bars: PriceBar[] = [
        bar(2, 110, 110, 110, 110, { limit_up: true }),
        bar(5, 110, 111, 109, 110),
    ];
    const trade = simulateTrade(
        event(),
        bars,
        DEFAULT_PROVISIONAL_ASSUMPTIONS,
    );
    assert.equal(trade.filled, false);
    assert.equal(trade.skip_reason, 'limit_up');
    pass('limit_up_no_fill');
}
{
    const bars: PriceBar[] = [
        bar(2, 100, 101, 99, 100, { no_liquidity: true }),
    ];
    const trade = simulateTrade(
        event(),
        bars,
        DEFAULT_PROVISIONAL_ASSUMPTIONS,
    );
    assert.equal(trade.filled, false);
    assert.equal(trade.skip_reason, 'no_liquidity');
    pass('no_liquidity_no_fill');
}

// ---- same-bar ambiguous: NOT favorable ----
{
    assert.equal(
        sameBarAmbiguous(
            { t: 1, open: 100, high: 105, low: 95, close: 100 },
            97,
            103,
        ),
        true,
    );
    const bars: PriceBar[] = [
        bar(2, 100, 100.2, 99.8, 100),
        // after fill: both stop(97) and TP(~102) hit same bar
        bar(5, 100, 103, 96, 100),
    ];
    const assumptions = {
        ...DEFAULT_PROVISIONAL_ASSUMPTIONS,
        provisional_take_profit_pct: 0.02,
        provisional_stop_use_invalid_price: true,
        provisional_max_hold_minutes: 60,
    };
    const trade = simulateTrade(
        event({ exit_rules_snapshot: { invalid_price: 97 } }),
        bars,
        assumptions,
    );
    assert.equal(trade.filled, true);
    assert.equal(trade.skip_reason, 'ambiguous_same_bar');
    assert.equal(trade.net_pnl, undefined);
    pass('same_bar_ambiguous_not_favorable');
}

// ---- path metrics: only bars after signal ----
{
    const bars: PriceBar[] = [
        bar(-1, 90, 95, 90, 94), // before — must not affect MFE as if after
        bar(1, 100, 101, 99.5, 100.5),
        bar(5, 100.5, 102, 100, 101.5),
        bar(15, 101.5, 103, 101, 102),
    ];
    const path = computeSignalPathMetrics(event(), bars);
    assert.equal(path.bars_after_signal, 3);
    assert.equal(path.evaluable, true);
    assert.ok(path.mfe_15m != null && path.mfe_15m < 0.05); // not from pre-signal 95→ wait high after is 103
    // MFE from highs after signal only (max 103)
    assert.ok(Math.abs(path.mfe_15m! - 0.03) < 1e-9);
    pass('path_metrics_no_pre_signal');
}

// ---- validateSignals summary + assumptions flag ----
{
    const bars: PriceBar[] = [
        bar(2, 100, 101, 99, 100.5),
        bar(10, 100.5, 103, 100, 102.5),
        bar(30, 102.5, 103, 101, 102),
        bar(50, 102, 102.5, 101.5, 102),
    ];
    const summary = validateSignals({
        events: [event()],
        barsBySymbol: { '2330': bars },
        data_source: 'synthetic_test',
    });
    assert.equal(summary.strategy_name, 'OPEN_PASS');
    assert.equal(summary.empty, false);
    assert.equal(summary.sim_stats.assumptions_not_original_strategy, true);
    assert.equal(
        summary.sim_stats.max_drawdown_note,
        '尚未建立部位規則，不計算投資組合回撤',
    );
    assert.ok(summary.assumptions?.assumptions_not_original_strategy);
    assert.equal(summary.trades[0]!.real_fill.real_fill_pnl, null);
    pass('validate_summary_provisional');
}

// ---- insufficient data ----
{
    const summary = validateSignals({
        events: [event({ signal_id: 'sv_thin' })],
        barsBySymbol: { '2330': [bar(1, 100, 100.1, 99.9, 100)] },
    });
    assert.equal(summary.counts.insufficient_data, 1);
    assert.equal(summary.trades[0]!.path.evaluable, false);
    pass('insufficient_data_count');
}

// ---- raw signals before the single-writer start date are ignored ----
{
    const dir = mkdtempSync(join(tmpdir(), 'sv-start-'));
    try {
        const store = new RawSignalStore(dir);
        store.append(
            event({
                signal_id: 'sv_before_start',
                signal_time: '2026-09-29T02:00:00.000Z',
                observation_time: '2026-09-29T02:00:00.000Z',
                source_mode: 'live',
            }),
        );
        store.append(
            event({
                signal_id: 'sv_after_start',
                signal_time: '2026-10-01T02:00:00.000Z',
                observation_time: '2026-10-01T02:00:00.000Z',
                source_mode: 'live',
            }),
        );
        const svc = new StrategyValidationService(store);
        const before = await svc.getSummary({ from: '2026-09-01', to: '2026-09-30' });
        assert.equal(before.empty, true);
        const span = await svc.getSummary({ from: '2026-09-01', to: '2026-10-02' });
        assert.equal(span.trades.length, 1);
        assert.equal(span.trades[0]!.signal_id, 'sv_after_start');
        assert.ok(span.data_source.includes(VALIDATION_DATA_START_YMD));
        pass('ignores_signals_before_start_date');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---- C signals share strategy_version but are not OPEN_PASS ----
{
    const dir = mkdtempSync(join(tmpdir(), 'sv-filter-'));
    try {
        const store = new RawSignalStore(dir);
        const base = {
            signal_time: '2026-10-01T02:00:00.000Z',
            observation_time: '2026-10-01T02:00:00.000Z',
            source_mode: 'live' as const,
        };
        store.append(event({ ...base, signal_id: 'sv_open' }));
        store.append(
            event({ ...base, signal_id: 'sv_surge', strategy_name: 'SURGE' }),
        );
        store.append(
            event({
                ...base,
                signal_id: 'sv_open_replay',
                source_mode: 'replay' as RawSignalEvent['source_mode'],
            }),
        );
        const s = await new StrategyValidationService(store).getSummary({
            from: '2026-10-01',
            to: '2026-10-01',
        });
        assert.deepEqual(
            s.trades.map((t) => t.signal_id),
            ['sv_open'],
        );
        assert.equal(
            validateSignals({
                events: [event({ strategy_name: 'SURGE' })],
                barsBySymbol: {},
            }).trades.length,
            0,
        );
        pass('only_live_open_pass_is_validated');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---- bar source: each signal uses its own day's bars ----
{
    const dir = mkdtempSync(join(tmpdir(), 'sv-bars-'));
    try {
        const store = new RawSignalStore(dir);
        const d1 = Date.parse('2026-10-01T01:30:00.000Z');
        const d2 = Date.parse('2026-10-02T01:30:00.000Z');
        for (const [id, t] of [
            ['sv_d1', d1],
            ['sv_d2', d2],
        ] as const) {
            store.append(
                event({
                    signal_id: id,
                    signal_time: new Date(t).toISOString(),
                    observation_time: new Date(t).toISOString(),
                    source_mode: 'live',
                }),
            );
        }
        const requested: string[] = [];
        const mkBars = (t0: number): PriceBar[] =>
            [1, 2, 3, 4, 5].map((m) => ({
                t: t0 + m * 60_000,
                open: 100,
                high: 101,
                low: 99.5,
                close: 100.5,
                volume: 10,
            }));
        const source: ValidationBarSource = {
            async loadDay(date, symbol) {
                requested.push(`${date}:${symbol}`);
                return date === '2026-10-01' ? mkBars(d1) : null;
            },
        };
        const s = await new StrategyValidationService(store, source).getSummary(
            { from: '2026-10-01', to: '2026-10-02' },
        );
        assert.deepEqual(requested.sort(), [
            '2026-10-01:2330',
            '2026-10-02:2330',
        ]);
        const byId = Object.fromEntries(s.trades.map((t) => [t.signal_id, t]));
        assert.equal(byId.sv_d1!.path.evaluable, true);
        assert.equal(byId.sv_d2!.path.insufficient_data, true);
        pass('bars_are_same_day_and_missing_day_stays_insufficient');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---- TW limit-up price rounds down to a valid tick ----
{
    assert.equal(twLimitUpPrice(100), 110);
    assert.equal(twLimitUpPrice(45.45), 49.95); // 49.995 → 0.05 tick
    assert.equal(twLimitUpPrice(9.5), 10.45); // 10.45 → 0.05 tick
    assert.equal(twLimitUpPrice(8), 8.8); // 0.01 tick
    assert.equal(twLimitUpPrice(950), 1045); // 1045 → 5 tick
    pass('tw_limit_up_price_ticks');
}

// ---- toPriceBars flags limit-up locks and illiquid / synthetic bars ----
{
    const day = {
        symbol: '2330',
        date: '2026-10-01',
        bars: [
            { known_at: 1, open: 100, high: 105, low: 100, close: 104, volume: 5 },
            { known_at: 2, open: 110, high: 110, low: 110, close: 110, volume: 3 },
            { known_at: 3, open: 110, high: 110, low: 110, close: 110, volume: 0 },
            { known_at: 4, open: 104, high: 104, low: 104, close: 104, volume: 0, gap_kind: 'no_trade' },
        ],
    } as unknown as DayBars;
    const bars = toPriceBars(day, 100);
    assert.deepEqual(
        bars.map((b) => [b.t, b.limit_up, b.no_liquidity]),
        [
            [1, false, false],
            [2, true, false],
            [3, true, true],
            [4, false, true],
        ],
    );
    pass('price_bars_limit_up_and_liquidity_flags');
}

// ---- CachedValidationBarSource: disk cache only after session close ----
{
    const dir = mkdtempSync(join(tmpdir(), 'sv-cache-'));
    try {
        let fetches = 0;
        let now = Date.parse('2026-10-01T03:00:00.000Z'); // 11:00 Taipei
        let prev: number | null = 100;
        const day = {
            symbol: '2330',
            date: '2026-10-01',
            bars: [{ known_at: 1, open: 100, high: 101, low: 99, close: 100, volume: 1 }],
        } as unknown as DayBars;
        const src = new CachedValidationBarSource({
            loadStockDay: async () => {
                fetches++;
                return day;
            },
            prevClose: async () => prev,
            cacheDir: dir,
            nowMs: () => now,
        });
        assert.equal(await src.loadDay('2026-10-01', '2330'), null);
        assert.equal(fetches, 0, 'no intraday kbars before the close');

        now = Date.parse('2026-10-01T06:00:00.000Z'); // 14:00 Taipei
        assert.ok(await src.loadDay('2026-10-01', '2330'));
        assert.equal(existsSync(join(dir, '2026-10-01', '2330.json')), true);
        await src.loadDay('2026-10-01', '2330');
        assert.equal(fetches, 1);

        prev = null;
        assert.equal(await src.loadDay('2026-10-01', '1101'), null);
        pass('bar_fetch_only_after_close_cached_and_null_without_prev_close');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---- data janitor removes only old dated logs ----
{
    const dir = mkdtempSync(join(tmpdir(), 'sv-janitor-'));
    try {
        const now = Date.parse('2026-10-20T04:00:00.000Z');
        mkdirSync(join(dir, 'open-confirm-logs'));
        writeFileSync(join(dir, 'open-confirm-logs', '2026-10-01.jsonl'), 'x');
        writeFileSync(join(dir, 'open-confirm-logs', '2026-10-18.jsonl'), 'x');
        writeFileSync(join(dir, 'open-confirm-logs', 'index.json'), 'x');
        mkdirSync(join(dir, 'strategy_validation_bars', '2026-08-01'), {
            recursive: true,
        });
        writeFileSync(
            join(dir, 'strategy_validation_bars', '2026-08-01', '2330.json'),
            '[]',
        );
        mkdirSync(join(dir, 'raw_strategy_signals'));
        writeFileSync(join(dir, 'raw_strategy_signals', '2026-01-01.jsonl'), 'x');
        const r = sweepOldLogs(dir, now);
        assert.equal(r.deleted_files, 2);
        assert.equal(existsSync(join(dir, 'open-confirm-logs', '2026-10-01.jsonl')), false);
        assert.equal(existsSync(join(dir, 'open-confirm-logs', '2026-10-18.jsonl')), true);
        assert.equal(existsSync(join(dir, 'open-confirm-logs', 'index.json')), true);
        assert.equal(existsSync(join(dir, 'strategy_validation_bars', '2026-08-01')), false);
        assert.equal(existsSync(join(dir, 'raw_strategy_signals', '2026-01-01.jsonl')), true);
        pass('janitor_keeps_research_and_recent_logs');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---- low-disk guard deletes oldest dated logs first, never today ----
{
    const dir = mkdtempSync(join(tmpdir(), 'sv-lowdisk-'));
    try {
        const now = Date.parse('2026-10-20T04:00:00.000Z');
        mkdirSync(join(dir, 'open-confirm-logs'));
        mkdirSync(join(dir, 'intraday-rank-logs'));
        for (const f of ['2026-10-18.jsonl', '2026-10-20.jsonl']) {
            writeFileSync(join(dir, 'open-confirm-logs', f), 'x');
        }
        writeFileSync(join(dir, 'intraday-rank-logs', 'rank-2026-10-17.jsonl'), 'x');
        let free = 100 * 1048576;
        const r = emergencySweep(dir, now, () => {
            const v = free;
            free += 60 * 1048576; // 100 → 160 → 220: two deletes, still < target
            return v;
        });
        assert.equal(r.deleted_files, 2);
        assert.equal(existsSync(join(dir, 'intraday-rank-logs', 'rank-2026-10-17.jsonl')), false);
        assert.equal(existsSync(join(dir, 'open-confirm-logs', '2026-10-18.jsonl')), false);
        assert.equal(existsSync(join(dir, 'open-confirm-logs', '2026-10-20.jsonl')), true);
        assert.equal(
            emergencySweep(dir, now, () => 500 * 1048576).deleted_files,
            0,
        );
        pass('low_disk_guard_oldest_first_keeps_today');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

console.log(`\nOK ${passed} tests`);
