// server/src/lib/open-gate-v2/liquidity-gate.test.ts
// Run: npx tsx src/lib/open-gate-v2/liquidity-gate.test.ts

import assert from 'node:assert/strict';
import { DEFAULT_OPEN_GATE_CONFIG } from './config.ts';
import { runLiquidityGate } from './liquidity-gate.ts';
import type { ACandidate, SymbolMarketState } from './types.ts';

function candidate(over: Partial<ACandidate> = {}): ACandidate {
    return {
        symbol: '2330',
        name: '台積電',
        exchange: 'tse',
        a_score: 80,
        a_score_source: 'server',
        prev_close: 100,
        avg_volume_20d: 20_000_000,
        avg_amount_20d: 2_000_000_000,
        sector: '半導體',
        warning_status: false,
        disposition_status: false,
        source: 'eod_a',
        lite: true,
        ...over,
    };
}

function state(): SymbolMarketState {
    return {
        symbol: '2330',
        timestamp: Date.now(),
        last_price: 101,
        open: 100,
        high: 101.5,
        low: 99.8,
        prev_close: 100,
        total_volume: 5_000_000,
        total_amount: 500_000_000,
        turnover: 0,
        avg_price: 100.5,
        best_bid: 100.5,
        best_ask: 101,
        bid_volume: 20,
        ask_volume: 20,
        tick_count: 80,
        last_tick_at: Date.now(),
        last_bidask_at: Date.now(),
        vwap_num: 0,
        vwap_den: 0,
        vwap_source: 'fallback',
        vwap_valid: true,
        recent_prices: [],
    };
}

function testAttentionIsSoftReject(): void {
    const r = runLiquidityGate({
        cfg: DEFAULT_OPEN_GATE_CONFIG,
        candidate: candidate({ warning_status: true }),
        state: state(),
        sessionMinutes: 15,
        rvolSameTime: 1.5,
    });
    assert.equal(r.hard_reject, false);
    assert.equal(r.soft_reject, true);
    assert.ok(r.risks.some((x) => x.includes('注意股')));
    console.log('OK attention stock is soft_reject');
}

function testDispositionStaysHardReject(): void {
    const r = runLiquidityGate({
        cfg: DEFAULT_OPEN_GATE_CONFIG,
        candidate: candidate({
            warning_status: true,
            disposition_status: true,
        }),
        state: state(),
        sessionMinutes: 15,
        rvolSameTime: 1.5,
    });
    assert.equal(r.hard_reject, true);
    console.log('OK disposition remains hard_reject');
}

function testCleanNameIsNotRejected(): void {
    const r = runLiquidityGate({
        cfg: DEFAULT_OPEN_GATE_CONFIG,
        candidate: candidate(),
        state: state(),
        sessionMinutes: 15,
        rvolSameTime: 1.5,
    });
    assert.equal(r.hard_reject, false);
    assert.ok(!r.risks.some((x) => x.includes('注意股')));
    console.log('OK clean name is not flagged as attention');
}

function main(): void {
    testAttentionIsSoftReject();
    testDispositionStaysHardReject();
    testCleanNameIsNotRejected();
    console.log('liquidity-gate.test.ts 3 passed');
}

main();
