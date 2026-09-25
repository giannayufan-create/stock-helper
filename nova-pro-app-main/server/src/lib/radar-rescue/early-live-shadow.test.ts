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
    evaluateLiveTradeTick,
    sampleToBarKnownAt,
} from './early-live-shadow.ts';
import { selectEodBarForTradeDate } from './eod-truth.ts';

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
        const tradeTs = t - 1_000;
        store.sampleTrade(
            symbol,
            {
                price: priceFn(t),
                trade_ts_ms: tradeTs,
                source: 'injected',
            },
            tradeTs,
        );
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
        store.sampleTrade(
            '2330',
            { price: 100, trade_ts_ms: now, source: 'injected' },
            now,
        );
    }
    assert.equal(short.getOpen(sid), null, '5m window finalized');

    // +3% only after 5 minutes (day_ref 100 → 103)
    const hitAt = T0 + 8 * 60_000;
    now = hitAt;
    store.sampleTrade(
        '2330',
        { price: 103.5, trade_ts_ms: hitAt, source: 'injected' },
        hitAt,
    );
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
    store.sampleTrade(
        '2330',
        { price: 100, trade_ts_ms: now, source: 'injected' },
        now,
    );

    // Simulate restart hours later with new store instance
    now = T0 + 3 * 60 * 60_000;
    const store2 = new EarlyLiveShadowStore(dir, () => now);
    store2.sampleTrade(
        '2330',
        { price: 110, trade_ts_ms: now, source: 'injected' },
        now,
    ); // late price must not fill gap as success-only
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
    store.sampleTrade(
        '2330',
        { price: 100, trade_ts_ms: now, source: 'injected' },
        now,
    );

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
    assert.equal(store.get('early_2330_eod')!.settled, false, 'EOD fail keeps unsettled for retry');
    assert.deepEqual(store.datesNeedingSettlement(now), [TRADE_DATE]);

    // Retry after EOD recovers: patch day ref and settle for real.
    store.patchDayReference('early_2330_eod', 100, 'eod_yahoo');
    const retried = store.settleAndPersist({
        trade_date: TRADE_DATE,
        nowMs: now + 1000,
        sessionEnded: true,
        eodFetchFailed: false,
        reportsDir: dir,
    });
    assert.equal(retried.live_report_written, true);
    assert.equal(store.get('early_2330_eod')!.settled, true);
    assert.equal(store.datesNeedingSettlement(now + 1000).length, 0);
    assert.equal(
        store.getSettlementStatus(TRADE_DATE, now + 1000).live_report_ready,
        true,
    );
    console.log('OK EOD/tracking missing → INCOMPLETE; retry settles after EOD ok');
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
testStalePriceRejected();
testDuplicateQuoteNotNewTrade();
testEodPreviousDayRejected();
testPendingSettleAndRestartCatchUp();
testNextDayRestartLoadsYesterday();
testBatchTradesCaptureHigh();
console.log('\nAll early-live-shadow tests passed');

function testNextDayRestartLoadsYesterday(): void {
    let now = expectedSessionEndKnownAt(TRADE_DATE) + 60_000;
    const dir = mkdtempSync(join(tmpdir(), 'els-nextday-'));
    const day1 = new EarlyLiveShadowStore(dir, () => now);
    day1.recordTrigger({
        signal_id: 'early_2330_yday',
        symbol: '2330',
        triggered_at_ms: T0,
        trigger_price: 100,
        state_at_trigger: 'EARLY',
        day_reference_price: 100,
        trade_date: TRADE_DATE,
    });
    fillBarsToClose(day1, '2330', T0, () => 100);
    assert.deepEqual(day1.datesNeedingSettlement(now), [TRADE_DATE]);

    // Next calendar day restart — must still see yesterday unsettled.
    const nextDayMs = Date.parse('2026-06-16T02:00:00.000Z');
    const day2 = new EarlyLiveShadowStore(dir, () => nextDayMs);
    assert.ok(
        day2.get('early_2330_yday'),
        'yesterday track hydrated on next-day restart',
    );
    assert.deepEqual(day2.datesNeedingSettlement(nextDayMs), [TRADE_DATE]);
    const result = day2.settleAndPersist({
        trade_date: TRADE_DATE,
        nowMs: nextDayMs,
        sessionEnded: true,
        reportsDir: dir,
    });
    assert.equal(result.live_report_written, true);
    assert.equal(day2.get('early_2330_yday')!.settled, true);
    assert.equal(day2.datesNeedingSettlement(nextDayMs).length, 0);
    console.log('OK next-day restart catch-up settles yesterday EARLY');
    rmSync(dir, { recursive: true, force: true });
}

function testBatchTradesCaptureHigh(): void {
    let now = T0 + 60_000;
    const dir = mkdtempSync(join(tmpdir(), 'els-batch-'));
    const store = new EarlyLiveShadowStore(dir, () => now);
    store.recordTrigger({
        signal_id: 'early_2330_batch',
        symbol: '2330',
        triggered_at_ms: T0,
        trigger_price: 100,
        state_at_trigger: 'EARLY',
        day_reference_price: 100,
        trade_date: TRADE_DATE,
    });
    const base = now;
    // Same poll batch: mid print is highest — must not keep only the last print.
    const batch = store.sampleTrades(
        '2330',
        [
            { price: 101, trade_ts_ms: base, source: 'opengate_last' },
            { price: 108, trade_ts_ms: base + 200, source: 'opengate_last' },
            { price: 103, trade_ts_ms: base + 400, source: 'opengate_last' },
        ],
        now,
    );
    assert.equal(batch.accepted, 3);
    const bar = store
        .get('early_2330_batch')!
        .bars.find((b) => b.gap_kind == null)!;
    assert.ok(bar);
    assert.equal(bar.high, 108, 'batch must record peak print as bar high');
    assert.equal(bar.close, 103);
    console.log('OK batch prints capture high=108 not only last=103');
    rmSync(dir, { recursive: true, force: true });
}

function testStalePriceRejected(): void {
    let now = T0 + 60_000;
    const dir = mkdtempSync(join(tmpdir(), 'els-stale-'));
    const store = new EarlyLiveShadowStore(dir, () => now);
    store.recordTrigger({
        signal_id: 'early_2330_stale',
        symbol: '2330',
        triggered_at_ms: T0,
        trigger_price: 100,
        state_at_trigger: 'EARLY',
        day_reference_price: 100,
        trade_date: TRADE_DATE,
    });
    const staleTs = now - 120_000;
    const r = store.sampleTrade(
        '2330',
        { price: 105, trade_ts_ms: staleTs, source: 'opengate_last' },
        now,
    );
    assert.equal(r.accepted, false);
    assert.equal(r.reason, 'stale');
    const row = store.get('early_2330_stale')!;
    assert.equal(
        row.bars.filter((b) => b.gap_kind == null).length,
        0,
        'stale must not create a traded bar',
    );
    const gate = evaluateLiveTradeTick(
        { price: 105, trade_ts_ms: staleTs, source: 'opengate_last' },
        now,
        null,
    );
    assert.equal(gate.ok, false);
    console.log('OK stale price rejected — not written to live bar');
    rmSync(dir, { recursive: true, force: true });
}

function testDuplicateQuoteNotNewTrade(): void {
    let now = T0 + 60_000;
    const dir = mkdtempSync(join(tmpdir(), 'els-dupq-'));
    const store = new EarlyLiveShadowStore(dir, () => now);
    store.recordTrigger({
        signal_id: 'early_2330_dq',
        symbol: '2330',
        triggered_at_ms: T0,
        trigger_price: 100,
        state_at_trigger: 'EARLY',
        day_reference_price: 100,
        trade_date: TRADE_DATE,
    });
    const tradeTs = now;
    assert.equal(
        store.sampleTrade(
            '2330',
            { price: 101, trade_ts_ms: tradeTs, source: 'injected' },
            now,
        ).accepted,
        true,
    );
    const barsAfterFirst = store.get('early_2330_dq')!.bars.length;
    // Same last_price with same or older trade_ts — not a new print
    now = T0 + 90_000;
    const dup = store.sampleTrade(
        '2330',
        { price: 101, trade_ts_ms: tradeTs, source: 'injected' },
        now,
    );
    assert.equal(dup.accepted, false);
    assert.equal(dup.reason, 'duplicate');
    assert.equal(store.get('early_2330_dq')!.bars.length, barsAfterFirst);
    // Bare last_price without trade_ts
    const bare = store.samplePrice('2330', 101, now, 'c_last');
    assert.equal(bare.accepted, false);
    assert.equal(bare.reason, 'missing_timestamp');
    console.log('OK duplicate last_price / missing timestamp not new trade');
    rmSync(dir, { recursive: true, force: true });
}

function testEodPreviousDayRejected(): void {
    const bars = [
        { date: '2026-06-13', close: 99, open: 98, high: 100, low: 97 },
        { date: '2026-06-14', close: 100, open: 99, high: 101, low: 98 },
    ];
    // Want 2026-06-15 but feed only has prior days — must not pick 06-14
    assert.equal(selectEodBarForTradeDate(bars, '2026-06-15'), null);
    const ok = selectEodBarForTradeDate(
        [
            ...bars,
            { date: '2026-06-15', close: 102, open: 100, high: 103, low: 99 },
        ],
        '2026-06-15',
    );
    assert.ok(ok);
    assert.equal(ok!.today.date, '2026-06-15');
    assert.equal(ok!.prev!.date, '2026-06-14');
    assert.equal(ok!.prev!.close, 100);
    console.log('OK EOD rejects previous-day bar; exact trade_date only');
}

function testPendingSettleAndRestartCatchUp(): void {
    let now = T0 + 30 * 60_000;
    const dir = mkdtempSync(join(tmpdir(), 'els-catch-'));
    const store = new EarlyLiveShadowStore(dir, () => now);
    store.recordTrigger({
        signal_id: 'early_2330_catch',
        symbol: '2330',
        triggered_at_ms: T0,
        trigger_price: 100,
        state_at_trigger: 'EARLY',
        day_reference_price: 100,
        trade_date: TRADE_DATE,
    });
    fillBarsToClose(store, '2330', T0, () => 100);

    // Before session end: pending not yet — waiting_session_end
    let st = store.getSettlementStatus(TRADE_DATE, now);
    assert.equal(st.status, 'waiting_session_end');
    assert.equal(st.live_report_ready, false);
    assert.equal(store.datesNeedingSettlement(now).length, 0);

    // Session ended but not settled yet
    now = expectedSessionEndKnownAt(TRADE_DATE) + 60_000;
    st = store.getSettlementStatus(TRADE_DATE, now);
    assert.equal(st.status, 'pending');
    assert.equal(st.message, '當日實盤日報尚未結算完成');
    assert.deepEqual(store.datesNeedingSettlement(now), [TRADE_DATE]);

    // Restart: new store instance still sees needing settlement
    const store2 = new EarlyLiveShadowStore(dir, () => now);
    assert.deepEqual(store2.datesNeedingSettlement(now), [TRADE_DATE]);
    assert.equal(
        store2.getSettlementStatus(TRADE_DATE, now).live_report_ready,
        false,
    );

    const result = store2.settleAndPersist({
        trade_date: TRADE_DATE,
        nowMs: now,
        sessionEnded: true,
        reportsDir: dir,
    });
    assert.equal(result.live_report_written, true);
    st = store2.getSettlementStatus(TRADE_DATE, now);
    assert.equal(st.status, 'settled');
    assert.equal(st.live_report_ready, true);
    assert.equal(st.message, null);
    assert.equal(store2.datesNeedingSettlement(now).length, 0);

    // Retry after restart still one report
    const store3 = new EarlyLiveShadowStore(dir, () => now + 1000);
    const again = store3.settleAndPersist({
        trade_date: TRADE_DATE,
        nowMs: now + 1000,
        sessionEnded: true,
        reportsDir: dir,
    });
    assert.equal(again.retried, true);
    assert.equal(again.summary.signal_count, 1);
    console.log('OK pending until settle; restart catch-up; no double count');
    rmSync(dir, { recursive: true, force: true });
}