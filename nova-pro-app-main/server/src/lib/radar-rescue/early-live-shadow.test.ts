// EARLY live shadow tests — injectable clock + simulated prices.
// Scenarios: two EARLY same symbol, EARLY→ACTIVE, +3% after 5m, restart,
// missing day ref, EOD gap, duplicate settle. Never FAIL mid-session.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectedSessionEndKnownAt } from './early-backtest.ts';
import { EarlyDailyReportStore } from './early-daily-report.ts';
import { EarlySignalStore } from './early-signal-store.ts';
import {
    EarlyLiveShadowStore,
    sampleToBarKnownAt,
} from './early-live-shadow.ts';

const TRADE_DATE = '2026-06-15';

/** 09:10 Taipei ≈ known trigger for tests (UTC+8). */
const T0 = Date.parse('2026-06-15T01:10:00.000Z');

function fillBarsToClose(
    store: EarlyLiveShadowStore,
    symbol: string,
    fromMs: number,
    priceFn: (t: number) => number,
): void {
    const end = expectedSessionEndKnownAt(TRADE_DATE);
    let t = sampleToBarKnownAt(fromMs);
    if (t <= fromMs) t += 60_000;
    for (; t <= end; t += 60_000) {
        store.samplePrice(symbol, priceFn(t), t - 1_000, 'injected');
    }
}

function testTwoEarlySameSymbol(): void {
    let now = T0;
    const dir = mkdtempSync(join(tmpdir(), 'els-two-'));
    const store = new EarlyLiveShadowStore(dir, () => now);

    store.recordTrigger({
        signal_id: 'early_2330_a',
        symbol: '2330',
        triggered_at_ms: T0,
        trigger_price: 100,
        state_at_trigger: 'EARLY',
        day_reference_price: 100,
        day_reference_source: 'injected',
        trade_date: TRADE_DATE,
    });
    const t1 = T0 + 20 * 60_000;
    now = t1;
    store.recordTrigger({
        signal_id: 'early_2330_b',
        symbol: '2330',
        triggered_at_ms: t1,
        trigger_price: 101,
        state_at_trigger: 'EARLY',
        day_reference_price: 100,
        day_reference_source: 'injected',
        trade_date: TRADE_DATE,
    });
    // Upgrade same signal — must not create a third row
    store.recordTrigger({
        signal_id: 'early_2330_a',
        symbol: '2330',
        triggered_at_ms: T0,
        trigger_price: 100,
        state_at_trigger: 'PRE_ATTACK',
        trade_date: TRADE_DATE,
    });

    const rows = store.list(TRADE_DATE);
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((r) => r.symbol === '2330').length, 2);
    console.log('OK same-symbol two EARLY signal_ids; upgrade not double-counted');
    rmSync(dir, { recursive: true, force: true });
}

function testEarlyToActive(): void {
    let now = T0;
    const dir = mkdtempSync(join(tmpdir(), 'els-act-'));
    const store = new EarlyLiveShadowStore(dir, () => now);
    store.recordTrigger({
        signal_id: 'early_2330_act',
        symbol: '2330',
        triggered_at_ms: T0,
        trigger_price: 100,
        state_at_trigger: 'EARLY',
        day_reference_price: 100,
        trade_date: TRADE_DATE,
    });
    now = T0 + 3 * 60_000;
    store.noteActive('early_2330_act', now);
    store.noteActive('early_2330_act', now + 60_000); // second call ignored
    fillBarsToClose(store, '2330', T0, () => 100);

    now = expectedSessionEndKnownAt(TRADE_DATE) + 60_000;
    const summary = store.settleDay({
        trade_date: TRADE_DATE,
        nowMs: now,
        sessionEnded: true,
    });
    const o = summary.outcomes[0]!;
    assert.equal(o.active_upgrade.verdict, 'SUCCESS');
    assert.equal(o.active_upgrade.reached, true);
    assert.equal(store.get('early_2330_act')!.active_at_ms, T0 + 3 * 60_000);
    console.log('OK EARLY→ACTIVE counted once');
    rmSync(dir, { recursive: true, force: true });
}

function testPlus3AfterFiveMinutes(): void {
    let now = T0;
    const dir = mkdtempSync(join(tmpdir(), 'els-p3-'));
    const short = new EarlySignalStore(dir, () => now);
    const store = new EarlyLiveShadowStore(dir, () => now);

    const sid = short.recordTrigger({
        symbol: '2330',
        name: 'TSMC',
        timestamp: new Date(T0).toISOString(),
        trigger_price: 100,
        change_pct: 1,
        vwap_pos_pct: null,
        volume_accel: null,
        rank_velocity: null,
        bp_score: null,
        bp_slope: null,
        ask_eating: false,
        buy_surge: false,
        trigger_score: 70,
        state: 'EARLY',
    });
    store.recordTrigger({
        signal_id: sid,
        symbol: '2330',
        triggered_at_ms: T0,
        trigger_price: 100,
        state_at_trigger: 'EARLY',
        day_reference_price: 100,
        trade_date: TRADE_DATE,
    });

    // Within 5m: short horizons sample at 100; day track flat
    for (const offset of [30_000, 60_000, 90_000, 180_000, 300_000]) {
        now = T0 + offset;
        short.sample('2330', 100, 'EARLY', now);
        store.samplePrice('2330', 100, now, 'injected');
    }
    assert.equal(short.getOpen(sid), null, '5m window finalized');

    // +3% only after 5 minutes (day_ref 100 → 103)
    const hitAt = T0 + 8 * 60_000;
    now = hitAt;
    store.samplePrice('2330', 103.5, hitAt, 'injected');
    fillBarsToClose(store, '2330', hitAt, () => 103.5);

    now = expectedSessionEndKnownAt(TRADE_DATE) + 1;
    const summary = store.settleDay({
        trade_date: TRADE_DATE,
        nowMs: now,
        sessionEnded: true,
    });
    const o = summary.outcomes.find((x) => x.signal_id === sid)!;
    assert.equal(o.day_plus_3pct.verdict, 'SUCCESS');
    assert.ok((o.day_plus_3pct.first_hit_after_min ?? 0) >= 5);
    console.log('OK +3% hit after 5m still tracked to close');
    rmSync(dir, { recursive: true, force: true });
}

function testRestartNoBackfill(): void {
    let now = T0;
    const dir = mkdtempSync(join(tmpdir(), 'els-rs-'));
    const store = new EarlyLiveShadowStore(dir, () => now);
    store.recordTrigger({
        signal_id: 'early_2330_rs',
        symbol: '2330',
        triggered_at_ms: T0,
        trigger_price: 100,
        state_at_trigger: 'EARLY',
        day_reference_price: 100,
        trade_date: TRADE_DATE,
    });
    now = T0 + 60_000;
    store.samplePrice('2330', 100, now, 'injected');

    // Simulate restart hours later with new store instance
    now = T0 + 3 * 60 * 60_000;
    const store2 = new EarlyLiveShadowStore(dir, () => now);
    store2.samplePrice('2330', 110, now, 'injected'); // late price must not fill gap as success-only
    const row = store2.get('early_2330_rs')!;
    assert.ok(
        row.bars.some((b) => b.gap_kind === 'DATA_MISSING'),
        'gap marked DATA_MISSING after restart',
    );

    fillBarsToClose(store2, '2330', now, () => 110);
    now = expectedSessionEndKnownAt(TRADE_DATE) + 1;
    const summary = store2.settleDay({
        trade_date: TRADE_DATE,
        nowMs: now,
        sessionEnded: true,
    });
    // DATA_MISSING in window → not trackingToClose → no FAIL
    const o = summary.outcomes[0]!;
    assert.equal(o.tracking_to_close, false);
    assert.notEqual(o.day_plus_3pct.verdict, 'FAIL');
    // 110 is SUCCESS for day+3 if seen on non-missing bars
    assert.equal(o.day_plus_3pct.verdict, 'SUCCESS');
    console.log('OK restart: gap DATA_MISSING; no FAIL; late price not backfill');
    rmSync(dir, { recursive: true, force: true });
}

function testMissingDayRefUnknown(): void {
    let now = T0;
    const dir = mkdtempSync(join(tmpdir(), 'els-unk-'));
    const store = new EarlyLiveShadowStore(dir, () => now);
    store.recordTrigger({
        signal_id: 'early_2330_unk',
        symbol: '2330',
        triggered_at_ms: T0,
        trigger_price: 100,
        state_at_trigger: 'EARLY',
        day_reference_price: null,
        day_reference_source: 'none',
        trade_date: TRADE_DATE,
    });
    fillBarsToClose(store, '2330', T0, () => 105);
    now = expectedSessionEndKnownAt(TRADE_DATE) + 1;
    const o = store.settleDay({
        trade_date: TRADE_DATE,
        nowMs: now,
        sessionEnded: true,
    }).outcomes[0]!;
    assert.equal(o.day_plus_3pct.verdict, 'UNKNOWN');
    assert.equal(o.day_plus_5pct.verdict, 'UNKNOWN');
    // post-trigger still evaluable
    assert.equal(o.post_trigger_plus_3pct.verdict, 'SUCCESS');
    console.log('OK missing day ref → day metrics UNKNOWN');
    rmSync(dir, { recursive: true, force: true });
}

function testEodMissingIncomplete(): void {
    let now = T0;
    const dir = mkdtempSync(join(tmpdir(), 'els-eod-'));
    const store = new EarlyLiveShadowStore(dir, () => now);
    store.recordTrigger({
        signal_id: 'early_2330_eod',
        symbol: '2330',
        triggered_at_ms: T0,
        trigger_price: 100,
        state_at_trigger: 'EARLY',
        day_reference_price: 100,
        trade_date: TRADE_DATE,
    });
    // Only a few bars — incomplete tracking
    now = T0 + 60_000;
    store.samplePrice('2330', 100, now, 'injected');

    now = expectedSessionEndKnownAt(TRADE_DATE) + 1;
    const summary = store.settleDay({
        trade_date: TRADE_DATE,
        nowMs: now,
        sessionEnded: true,
        eodFetchFailed: true,
    });
    const o = summary.outcomes[0]!;
    assert.equal(o.tracking_to_close, false);
    assert.equal(o.day_plus_3pct.verdict, 'INCOMPLETE');
    assert.notEqual(o.day_plus_3pct.verdict, 'FAIL');

    const persisted = store.settleAndPersist({
        trade_date: TRADE_DATE,
        nowMs: now,
        sessionEnded: true,
        eodFetchFailed: true,
        reportsDir: dir,
    });
    assert.equal(persisted.live_report_written, true);
    assert.equal(persisted.report!.source, 'live');
    assert.ok(persisted.report!.note.includes('INCOMPLETE') || persisted.report!.note.includes('失敗'));
    console.log('OK EOD/tracking missing → INCOMPLETE not FAIL; live report written');
    rmSync(dir, { recursive: true, force: true });
}

function testMidSessionNoFail(): void {
    let now = T0 + 30 * 60_000; // still morning
    const dir = mkdtempSync(join(tmpdir(), 'els-mid-'));
    const store = new EarlyLiveShadowStore(dir, () => now);
    store.recordTrigger({
        signal_id: 'early_2330_mid',
        symbol: '2330',
        triggered_at_ms: T0,
        trigger_price: 100,
        state_at_trigger: 'EARLY',
        day_reference_price: 100,
        trade_date: TRADE_DATE,
    });
    fillBarsToClose(store, '2330', T0, () => 100);

    const summary = store.settleDay({
        trade_date: TRADE_DATE,
        nowMs: now,
        sessionEnded: false,
    });
    const o = summary.outcomes[0]!;
    assert.equal(o.day_plus_3pct.verdict, 'INCOMPLETE');
    assert.notEqual(o.day_plus_3pct.verdict, 'FAIL');

    const written = store.settleAndPersist({
        trade_date: TRADE_DATE,
        nowMs: now,
        sessionEnded: false,
        reportsDir: dir,
    });
    assert.equal(written.live_report_written, false);
    console.log('OK mid-session: unmet → INCOMPLETE; no FAIL; no report yet');
    rmSync(dir, { recursive: true, force: true });
}

function testDuplicateSettleNoDoubleCount(): void {
    let now = T0;
    const dir = mkdtempSync(join(tmpdir(), 'els-dup-'));
    const store = new EarlyLiveShadowStore(dir, () => now);
    store.recordTrigger({
        signal_id: 'early_2330_dup',
        symbol: '2330',
        triggered_at_ms: T0,
        trigger_price: 100,
        state_at_trigger: 'EARLY',
        day_reference_price: 100,
        trade_date: TRADE_DATE,
    });
    fillBarsToClose(store, '2330', T0, () => 100);
    now = expectedSessionEndKnownAt(TRADE_DATE) + 1;

    const a = store.settleAndPersist({
        trade_date: TRADE_DATE,
        nowMs: now,
        sessionEnded: true,
        reportsDir: dir,
    });
    const b = store.settleAndPersist({
        trade_date: TRADE_DATE,
        nowMs: now + 1000,
        sessionEnded: true,
        reportsDir: dir,
    });
    assert.equal(a.live_report_written, true);
    assert.equal(b.retried, true);
    assert.equal(a.summary.signal_count, 1);
    assert.equal(b.summary.signal_count, 1);

    const reports = new EarlyDailyReportStore(dir).listForApi(TRADE_DATE);
    const live = reports.reports.filter((r) => r.source === 'live');
    assert.equal(live.length, 1, 'one live report file (same run_id overwrite)');
    assert.equal(live[0]!.signal_count, 1);
    console.log('OK duplicate settle retryable; no double count');
    rmSync(dir, { recursive: true, force: true });
}

testTwoEarlySameSymbol();
testEarlyToActive();
testPlus3AfterFiveMinutes();
testRestartNoBackfill();
testMissingDayRefUnknown();
testEodMissingIncomplete();
testMidSessionNoFail();
testDuplicateSettleNoDoubleCount();
console.log('\nAll early-live-shadow tests passed');
