// server/src/lib/signal-outcome/live-tracker.test.ts
// Run: npx tsx src/lib/signal-outcome/live-tracker.test.ts

import assert from 'node:assert/strict';
import type { SymbolMarketState } from '../open-gate-v2/types.ts';
import {
    STRATEGY_VERSION,
    type StrategySignal,
} from '../strategy-signal/index.ts';
import { LiveOutcomeTracker } from './live-tracker.ts';
import type { SignalOutcomeRepository } from './repository.ts';
import type { SignalOutcome } from './types.ts';

class MemoryOutcomeRepo implements SignalOutcomeRepository {
    rows: SignalOutcome[] = [];
    appendUpdate(o: SignalOutcome): void {
        this.rows.push(o);
    }
    findBySignalId(id: string): SignalOutcome | null {
        return [...this.rows].reverse().find((o) => o.signal_id === id) ?? null;
    }
    listByDate(): SignalOutcome[] {
        return this.rows;
    }
    listByType(): SignalOutcome[] {
        return this.rows;
    }
    listRange(): SignalOutcome[] {
        return this.rows;
    }
    materializeRange(): SignalOutcome[] {
        const m = new Map<string, SignalOutcome>();
        for (const r of this.rows) m.set(r.signal_id, r);
        return [...m.values()];
    }
}

const T0 = Date.parse('2026-06-15T01:30:00.000Z');

function signal(over: Partial<StrategySignal> = {}): StrategySignal {
    return {
        signal_id: 'sig_live_1',
        symbol: '2330',
        signal_type: 'SURGE',
        signal_time: new Date(T0).toISOString(),
        reference_price: 100,
        reference_price_source: 'live_tick',
        source: 'C',
        strategy_version: STRATEGY_VERSION,
        config_hash: 'hash',
        source_mode: 'live',
        data_resolution: 'tick',
        learning_eligible: true,
        feature_snapshot: { score: 88 },
        ...over,
    };
}

function state(
    price: number,
    recent: Array<{ t: number; p: number }> = [],
): SymbolMarketState {
    return {
        symbol: '2330',
        timestamp: 0,
        last_price: price,
        open: 100,
        high: price,
        low: price,
        prev_close: 99,
        total_volume: 1000,
        total_amount: 1000,
        turnover: 0,
        avg_price: price,
        best_bid: price - 0.5,
        best_ask: price + 0.5,
        bid_volume: 10,
        ask_volume: 10,
        tick_count: 10,
        last_tick_at: null,
        last_bidask_at: null,
        vwap_num: 0,
        vwap_den: 0,
        vwap_source: 'fallback',
        vwap_valid: false,
        recent_prices: recent.map((r) => ({ t: r.t, p: r.p, v: 1 })),
    };
}

/** Drive the tracker forward at a fixed cadence with a price path. */
function run(
    tracker: LiveOutcomeTracker,
    priceAt: (minute: number) => number,
    minutes: number,
    setPrice: (s: SymbolMarketState | undefined) => void,
    current: { st: SymbolMarketState | undefined },
): void {
    for (let m = 1; m <= minutes; m++) {
        current.st = state(priceAt(m));
        setPrice(current.st);
        tracker.sampleOnce(T0 + m * 60_000);
    }
}

function testSettlesAndMeasuresUpMove(): void {
    const repo = new MemoryOutcomeRepo();
    const current: { st: SymbolMarketState | undefined } = { st: undefined };
    const tracker = new LiveOutcomeTracker(
        { getState: () => current.st },
        repo,
        { max_track_minutes: 61 },
    );
    tracker.track(signal());

    run(tracker, (m) => 100 + m * 0.05, 62, () => undefined, current);

    const o = repo.findBySignalId('sig_live_1');
    assert.ok(o, 'outcome should be written');
    assert.equal(o!.symbol, '2330');
    assert.ok(o!.forward_return_5m != null, 'forward_return_5m filled');
    assert.ok(o!.forward_return_60m != null, 'forward_return_60m filled');
    assert.ok(o!.forward_return_60m! > 2.5, 'up move measured');
    assert.equal(o!.hit_plus_1pct, true);
    assert.equal(o!.status, 'complete');
    assert.equal(tracker.getHealth().tracked, 0, 'signal retired after settle');
    console.log('OK settles and measures an up move');
}

function testInvalidHitRecorded(): void {
    const repo = new MemoryOutcomeRepo();
    const current: { st: SymbolMarketState | undefined } = { st: undefined };
    const tracker = new LiveOutcomeTracker(
        { getState: () => current.st },
        repo,
        { max_track_minutes: 61 },
    );
    tracker.track(signal({ invalid_price: 99 }));

    // Open high then fade below the invalid price — the pattern we care about.
    run(tracker, (m) => (m <= 3 ? 101 : 98.5), 10, () => undefined, current);

    const hit = repo.rows.find((r) => r.invalid_hit === true);
    assert.ok(hit, 'invalid break should be written as soon as it happens');
    assert.ok((hit!.time_to_invalid_sec ?? 0) > 0);
    console.log('OK invalid break recorded immediately');
}

function testNoWritesWithoutReferencePrice(): void {
    const repo = new MemoryOutcomeRepo();
    const current: { st: SymbolMarketState | undefined } = {
        st: state(100),
    };
    const tracker = new LiveOutcomeTracker(
        { getState: () => current.st },
        repo,
    );
    tracker.track(signal({ signal_id: 'no_ref', reference_price: 0 }));
    tracker.sampleOnce(T0 + 60_000);
    assert.equal(repo.rows.length, 0);
    assert.equal(tracker.getHealth().dropped_no_reference, 1);
    console.log('OK signals without reference price are skipped');
}

function testCapacityGuard(): void {
    const repo = new MemoryOutcomeRepo();
    const tracker = new LiveOutcomeTracker(
        { getState: () => undefined },
        repo,
        { max_tracked: 2 },
    );
    for (let i = 0; i < 5; i++) {
        tracker.track(signal({ signal_id: `cap_${i}` }));
    }
    assert.equal(tracker.getHealth().tracked, 2);
    assert.equal(tracker.getHealth().dropped_capacity, 3);
    console.log('OK capacity guard caps tracked signals');
}

function testUsesRecentPricesForHighLow(): void {
    const repo = new MemoryOutcomeRepo();
    // A spike between two samples must still show up in MFE.
    const spiked = state(100, [
        { t: T0 + 30_000, p: 103 },
        { t: T0 + 50_000, p: 100 },
    ]);
    const current: { st: SymbolMarketState | undefined } = { st: spiked };
    const tracker = new LiveOutcomeTracker(
        { getState: () => current.st },
        repo,
        { max_track_minutes: 1 },
    );
    tracker.track(signal({ signal_id: 'spike' }));
    tracker.sampleOnce(T0 + 60_000);

    const o = repo.findBySignalId('spike');
    assert.ok(o, 'forced settle should write');
    assert.ok((o!.mfe_5m ?? 0) >= 2.9, `spike captured in MFE, got ${o!.mfe_5m}`);
    console.log('OK intra-window spike captured from recent_prices');
}

function testSettleAll(): void {
    const repo = new MemoryOutcomeRepo();
    const current: { st: SymbolMarketState | undefined } = { st: state(101) };
    const tracker = new LiveOutcomeTracker(
        { getState: () => current.st },
        repo,
    );
    tracker.track(signal({ signal_id: 'a' }));
    tracker.track(signal({ signal_id: 'b' }));
    const n = tracker.settleAll(T0 + 20 * 60_000);
    assert.equal(n, 2);
    assert.equal(tracker.getHealth().tracked, 0);
    assert.equal(repo.materializeRange().length, 2);
    console.log('OK settleAll drains open signals');
}

function main(): void {
    testSettlesAndMeasuresUpMove();
    testInvalidHitRecorded();
    testNoWritesWithoutReferencePrice();
    testCapacityGuard();
    testUsesRecentPricesForHighLow();
    testSettleAll();
    console.log('live-tracker.test.ts 6 passed');
}

main();
