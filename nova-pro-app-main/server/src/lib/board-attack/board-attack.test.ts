// BoardAttack offline backtest tests — fixture only, no network / A/B/C.

import assert from 'node:assert/strict';
import {
    buildOpenFeatures,
    evaluateDay,
    isLimitUp,
    parseFinMindPriceRows,
    runBoardAttackBacktest,
    scoreEqualWeight,
} from './index.ts';
import type { DailyBar } from './types.ts';

function bar(
    date: string,
    symbol: string,
    open: number,
    high: number,
    low: number,
    close: number,
    volume: number,
): DailyBar {
    return { date, symbol, open, high, low, close, volume, amount: null };
}

// --- labels ---
{
    const prev = 100;
    const lu = bar('2026-09-10', '1111', 105, 110, 104, 110, 1e6);
    assert.equal(isLimitUp(lu, prev), true);
    const flat = bar('2026-09-10', '2222', 100, 101, 99, 100.5, 1e5);
    assert.equal(isLimitUp(flat, prev), false);
    console.log('ok labels');
}

// --- features no look-ahead (gap uses open, not close) ---
{
    const hist = [
        bar('2026-09-01', '1111', 90, 95, 89, 94, 1e5),
        bar('2026-09-02', '1111', 94, 103.5, 93, 103.4, 5e5), // ~10% lu
        bar('2026-09-03', '1111', 103, 104, 100, 101, 2e5),
        bar('2026-09-04', '1111', 101, 102, 100, 100, 1.5e5),
        bar('2026-09-05', '1111', 100, 101, 99, 100, 1.2e5),
    ];
    const today = bar('2026-09-08', '1111', 108, 110, 107, 109, 3e5);
    const f = buildOpenFeatures(today, hist);
    assert.ok(f.gap_pct != null && f.gap_pct > 7);
    assert.equal(f.prev_was_limit_up, false);
    // close of today must not affect gap
    const today2 = { ...today, close: 50 };
    const f2 = buildOpenFeatures(today2, hist);
    assert.equal(f.gap_pct, f2.gap_pct);
    console.log('ok features (no close leakage)');
}

// --- parse FinMind rows ---
{
    const rows = parseFinMindPriceRows(
        [
            {
                date: '2026-09-08',
                stock_id: '2330',
                open: 900,
                max: 910,
                min: 895,
                close: 905,
                Trading_Volume: 10000,
            },
            {
                date: '2026-09-08',
                stock_id: '0050',
                open: 100,
                max: 101,
                min: 99,
                close: 100,
                Trading_Volume: 1,
            },
        ],
        '2026-09-08',
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.symbol, '2330');
    console.log('ok parse (skip ETF)');
}

// --- end-to-end fixture backtest ---
{
    const dayBars = new Map<string, DailyBar[]>();
    // Build 10 days × 5 symbols; day 10 has two limit-ups with big open gaps
    const syms = ['1001', '1002', '1003', '1004', '1005'];
    const dates: string[] = [];
    for (let i = 1; i <= 10; i++) {
        dates.push(`2026-09-${String(i).padStart(2, '0')}`);
    }
    for (const d of dates) {
        dayBars.set(
            d,
            syms.map((s, j) => {
                const base = 50 + j * 10;
                return bar(d, s, base, base + 1, base - 1, base, 1e5 + j * 1e4);
            }),
        );
    }
    // Yesterday mild; today open gap + end limit-up for 1001/1002
    const d9 = dayBars.get('2026-09-09')!;
    const d10 = dayBars.get('2026-09-10')!;
    for (const b of d9) {
        if (b.symbol === '1001' || b.symbol === '1002') {
            b.close = b.open;
            b.high = b.open;
            b.volume = 8e5;
        }
    }
    for (const b of d10) {
        if (b.symbol === '1001' || b.symbol === '1002') {
            const prev = d9.find((x) => x.symbol === b.symbol)!.close;
            b.open = prev * 1.06;
            b.close = prev * 1.1;
            b.high = b.close;
            b.low = b.open;
            b.volume = 2e6;
        }
    }

    const summary = await runBoardAttackBacktest({
        from: '2026-09-10',
        to: '2026-09-10',
        topN: 2,
        lookbackDays: 9,
        minHistory: 3,
        dayBars,
    });
    assert.equal(summary.days.length, 1);
    const day = summary.days[0]!;
    assert.ok(day.limit_up_count >= 2, `lu=${day.limit_up_count}`);
    assert.ok(
        day.hit_in_top_n >= 1,
        `expected gap leaders in top2, hits=${day.hit_in_top_n}`,
    );
    const top2 = day.rows.slice(0, 2).map((r) => r.symbol);
    assert.ok(
        top2.includes('1001') || top2.includes('1002'),
        `top2=${top2.join(',')}`,
    );
    console.log('ok fixture backtest');
}

// --- scoring ranks higher gap ---
{
    const feats = [
        buildOpenFeatures(
            bar('2026-09-10', 'A', 110, 110, 110, 110, 1),
            [
                bar('2026-09-01', 'A', 100, 100, 100, 100, 1e5),
                bar('2026-09-02', 'A', 100, 100, 100, 100, 1e5),
                bar('2026-09-03', 'A', 100, 100, 100, 100, 1e5),
                bar('2026-09-04', 'A', 100, 100, 100, 100, 1e5),
                bar('2026-09-05', 'A', 100, 100, 100, 100, 1e5),
            ],
        ),
        buildOpenFeatures(
            bar('2026-09-10', 'B', 100, 100, 100, 100, 1),
            [
                bar('2026-09-01', 'B', 100, 100, 100, 100, 1e5),
                bar('2026-09-02', 'B', 100, 100, 100, 100, 1e5),
                bar('2026-09-03', 'B', 100, 100, 100, 100, 1e5),
                bar('2026-09-04', 'B', 100, 100, 100, 100, 1e5),
                bar('2026-09-05', 'B', 100, 100, 100, 100, 1e5),
            ],
        ),
    ];
    const scored = scoreEqualWeight(feats);
    scored.sort((a, b) => b.score - a.score);
    assert.equal(scored[0]!.symbol, 'A');
    const day = evaluateDay(
        '2026-09-10',
        [
            {
                ...feats[0]!,
                score: 1,
                rank: 1,
                is_limit_up: true,
                day_chg_pct: 10,
            },
            {
                ...feats[1]!,
                score: 0,
                rank: 2,
                is_limit_up: false,
                day_chg_pct: 0,
            },
        ],
        1,
    );
    assert.equal(day.recall, 1);
    assert.equal(day.precision, 1);
    console.log('ok score + metrics');
}

console.log('\nAll board-attack tests passed.');
