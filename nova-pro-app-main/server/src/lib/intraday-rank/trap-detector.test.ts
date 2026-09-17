// server/src/lib/intraday-rank/trap-detector.test.ts
// Run: npx tsx src/lib/intraday-rank/trap-detector.test.ts

import assert from 'node:assert/strict';
import type { SymbolMarketState } from '../open-gate-v2/types.ts';
import { detectIntradayTraps } from './trap-detector.ts';

function state(over: Partial<SymbolMarketState> = {}): SymbolMarketState {
    return {
        symbol: '2330',
        timestamp: 0,
        last_price: 100,
        open: 100,
        high: 100,
        low: 99,
        prev_close: 99,
        total_volume: 1000,
        total_amount: 1000,
        turnover: 0,
        avg_price: 100,
        best_bid: 99.5,
        best_ask: 100.5,
        bid_volume: 10,
        ask_volume: 10,
        tick_count: 10,
        last_tick_at: null,
        last_bidask_at: null,
        vwap_num: 0,
        vwap_den: 0,
        vwap_source: 'fallback',
        vwap_valid: false,
        recent_prices: [],
        ...over,
    };
}

function testFadeFromHigh(): void {
    const r = detectIntradayTraps({
        state: state({ open: 100, high: 104, last_price: 99.5, low: 99.4 }),
        breakoutType: 'none',
        volumeAcceleration: 1.4,
        rvolSameTime: 1.5,
        dayChangePct: 0.5,
    });
    assert.ok(r.flags.includes('FADE_FROM_HIGH'));
    assert.ok(r.penalty >= 10);
    console.log('OK FADE_FROM_HIGH');
}

function testFailedBreakout(): void {
    const r = detectIntradayTraps({
        state: state({ last_price: 101, open: 100, high: 102 }),
        breakoutType: 'failed_breakout',
        volumeAcceleration: 1.2,
        rvolSameTime: 1.3,
        dayChangePct: 1,
    });
    assert.ok(r.flags.includes('FAILED_BREAKOUT'));
    assert.ok(r.penalty >= 12);
    console.log('OK FAILED_BREAKOUT');
}

function testThinBreakout(): void {
    const r = detectIntradayTraps({
        state: state({ last_price: 105, high: 105, open: 100 }),
        breakoutType: 'breakout',
        volumeAcceleration: 0.6,
        rvolSameTime: 0.7,
        dayChangePct: 5,
    });
    assert.ok(r.flags.includes('THIN_BREAKOUT'));
    console.log('OK THIN_BREAKOUT');
}

function testCleanTapeHasNoPenalty(): void {
    const r = detectIntradayTraps({
        state: state({ last_price: 101.2, open: 100, high: 101.4, low: 99.8 }),
        breakoutType: 'breakout',
        volumeAcceleration: 1.8,
        rvolSameTime: 2.1,
        dayChangePct: 2.1,
    });
    assert.deepEqual(r.flags, []);
    assert.equal(r.penalty, 0);
    console.log('OK clean tape has no trap penalty');
}

function testPenaltyCapped(): void {
    const r = detectIntradayTraps({
        state: state({
            last_price: 99,
            open: 100,
            high: 110,
            low: 98.5,
        }),
        breakoutType: 'failed_breakout',
        volumeAcceleration: 0.4,
        rvolSameTime: 0.5,
        dayChangePct: 9.2,
        maxPenalty: 24,
    });
    assert.ok(r.flags.length >= 2);
    assert.ok(r.penalty <= 24);
    console.log('OK trap penalty is capped');
}

function main(): void {
    testFadeFromHigh();
    testFailedBreakout();
    testThinBreakout();
    testCleanTapeHasNoPenalty();
    testPenaltyCapped();
    console.log('trap-detector.test.ts 5 passed');
}

main();
