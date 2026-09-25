// EARLY daily report unit tests — UNKNOWN / INCOMPLETE / multi-signal / source isolation.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    EarlyBacktestSession,
    type EarlyBacktestOutcome,
    type EarlyBacktestSummary,
    type MetricBucket,
    type TargetMetric,
} from './early-backtest.ts';
import {
    buildEarlyDailyReport,
    EarlyDailyReportStore,
    formatRateLabel,
    toBucketView,
    type EarlyReportSource,
} from './early-daily-report.ts';

function emptyTarget(verdict: TargetMetric['verdict']): TargetMetric {
    return {
        verdict,
        first_hit_bar_known_at_ms: null,
        first_hit_after_min: null,
        time_precision: 'none',
    };
}

function bucketFrom(
    verdicts: Array<TargetMetric['verdict']>,
): MetricBucket {
    let success = 0;
    let fail = 0;
    let incomplete = 0;
    let unknown = 0;
    for (const v of verdicts) {
        if (v === 'SUCCESS') success += 1;
        else if (v === 'FAIL') fail += 1;
        else if (v === 'INCOMPLETE') incomplete += 1;
        else unknown += 1;
    }
    const d = success + fail;
    return {
        success,
        fail,
        incomplete,
        unknown,
        rate: d > 0 ? Math.round((success / d) * 1000) / 1000 : null,
    };
}

function fakeOutcome(
    over: Partial<EarlyBacktestOutcome> &
        Pick<EarlyBacktestOutcome, 'signal_id' | 'symbol'>,
): EarlyBacktestOutcome {
    const unk = emptyTarget('UNKNOWN');
    return {
        signal_id: over.signal_id,
        symbol: over.symbol,
        triggered_at_ms: over.triggered_at_ms ?? Date.parse('2026-06-15T01:10:00.000Z'),
        trigger_price: over.trigger_price ?? 100,
        change_pct_at_trigger: over.change_pct_at_trigger ?? 1,
        state_at_trigger: over.state_at_trigger ?? 'EARLY',
        trigger_score: over.trigger_score ?? 70,
        day_reference_price: over.day_reference_price ?? null,
        day_plus_3pct: over.day_plus_3pct ?? unk,
        day_plus_5pct: over.day_plus_5pct ?? unk,
        post_trigger_plus_3pct: over.post_trigger_plus_3pct ?? unk,
        post_trigger_plus_5pct: over.post_trigger_plus_5pct ?? unk,
        active_upgrade: over.active_upgrade ?? {
            ...emptyTarget('INCOMPLETE'),
            reached: false,
        },
        max_price: over.max_price ?? null,
        max_return_vs_trigger_pct: over.max_return_vs_trigger_pct ?? null,
        max_return_vs_day_ref_pct: over.max_return_vs_day_ref_pct ?? null,
        tracking_to_close: over.tracking_to_close ?? false,
        terminal_state: over.terminal_state ?? 'EARLY',
    };
}

function summaryFrom(outcomes: EarlyBacktestOutcome[]): EarlyBacktestSummary {
    const day3 = bucketFrom(outcomes.map((o) => o.day_plus_3pct.verdict));
    const scored = day3.success + day3.fail + day3.incomplete;
    return {
        signal_count: outcomes.length,
        unique_symbol_count: new Set(outcomes.map((o) => o.symbol)).size,
        day_plus_3pct: day3,
        day_plus_5pct: bucketFrom(outcomes.map((o) => o.day_plus_5pct.verdict)),
        post_trigger_plus_3pct: bucketFrom(
            outcomes.map((o) => o.post_trigger_plus_3pct.verdict),
        ),
        post_trigger_plus_5pct: bucketFrom(
            outcomes.map((o) => o.post_trigger_plus_5pct.verdict),
        ),
        active_upgrade: bucketFrom(
            outcomes.map((o) => o.active_upgrade.verdict),
        ),
        data_completeness_rate:
            scored > 0
                ? Math.round(((day3.success + day3.fail) / scored) * 1000) / 1000
                : null,
        outcomes,
    };
}

function testFormatRateInsufficient(): void {
    assert.equal(formatRateLabel(null, 0), '資料不足');
    assert.equal(formatRateLabel(0, 0), '資料不足');
    assert.equal(formatRateLabel(0, 5), '0.0%'); // real zero with denom
    assert.equal(formatRateLabel(0.5, 10), '50.0%');
    const v = toBucketView({
        success: 0,
        fail: 0,
        incomplete: 3,
        unknown: 0,
        rate: null,
    });
    assert.equal(v.rate_label, '資料不足');
    assert.notEqual(v.rate_label, '0%');
    console.log('OK formatRateLabel → 資料不足 when denom=0');
}

function testAllUnknown(): void {
    const outcomes = [
        fakeOutcome({
            signal_id: 'u1',
            symbol: '2330',
            day_plus_3pct: emptyTarget('UNKNOWN'),
            day_plus_5pct: emptyTarget('UNKNOWN'),
        }),
        fakeOutcome({
            signal_id: 'u2',
            symbol: '2317',
            day_plus_3pct: emptyTarget('UNKNOWN'),
            day_plus_5pct: emptyTarget('UNKNOWN'),
        }),
    ];
    const report = buildEarlyDailyReport(summaryFrom(outcomes), {
        trade_date: '2026-06-15',
        source: 'live',
    });
    assert.equal(report.day_plus_3pct.unknown, 2);
    assert.equal(report.day_plus_3pct.denominator, 0);
    assert.equal(report.day_plus_3pct.rate_label, '資料不足');
    assert.equal(report.signal_count, 2);
    assert.equal(report.unique_symbol_count, 2);
    console.log('OK all UNKNOWN → rate_label=資料不足');
}

function testAllIncomplete(): void {
    const outcomes = [
        fakeOutcome({
            signal_id: 'i1',
            symbol: '2330',
            day_plus_3pct: emptyTarget('INCOMPLETE'),
            post_trigger_plus_3pct: emptyTarget('INCOMPLETE'),
        }),
        fakeOutcome({
            signal_id: 'i2',
            symbol: '2330',
            day_plus_3pct: emptyTarget('INCOMPLETE'),
            post_trigger_plus_3pct: emptyTarget('INCOMPLETE'),
        }),
    ];
    const report = buildEarlyDailyReport(summaryFrom(outcomes), {
        trade_date: '2026-06-15',
        source: 'replay',
    });
    assert.equal(report.day_plus_3pct.incomplete, 2);
    assert.equal(report.day_plus_3pct.denominator, 0);
    assert.equal(report.day_plus_3pct.rate_label, '資料不足');
    assert.equal(report.data_completeness_label, '資料不足');
    assert.equal(report.active_upgrade.label, '狀態升級率');
    assert.equal(report.active_upgrade.kind, 'state_upgrade_rate');
    console.log('OK all INCOMPLETE → 資料不足; ACTIVE labeled 狀態升級率');
}

function testMultiSignalSameSymbol(): void {
    const outcomes = [
        fakeOutcome({
            signal_id: 'early_2330_1',
            symbol: '2330',
            day_plus_3pct: {
                verdict: 'SUCCESS',
                first_hit_after_min: 5,
                first_hit_bar_known_at_ms: 1,
                time_precision: '1m_bar',
            },
            day_reference_price: 100,
            trigger_price: 101,
        }),
        fakeOutcome({
            signal_id: 'early_2330_2',
            symbol: '2330',
            day_plus_3pct: emptyTarget('FAIL'),
            day_reference_price: 100,
            trigger_price: 102,
        }),
        fakeOutcome({
            signal_id: 'early_2317_1',
            symbol: '2317',
            day_plus_3pct: emptyTarget('FAIL'),
            day_reference_price: 50,
        }),
    ];
    const report = buildEarlyDailyReport(summaryFrom(outcomes), {
        trade_date: '2026-06-15',
        source: 'replay',
    });
    assert.equal(report.signal_count, 3);
    assert.equal(report.unique_symbol_count, 2);
    assert.equal(report.day_plus_3pct.success, 1);
    assert.equal(report.day_plus_3pct.fail, 2);
    assert.equal(report.day_plus_3pct.denominator, 3);
    assert.equal(report.signals.length, 3);
    assert.ok(report.signals.every((s) => s.signal_id.length > 0));
    const first = report.signals.find((s) => s.signal_id === 'early_2330_1')!;
    assert.equal(first.day_plus_3pct.first_hit_after_min, 5);
    assert.equal(first.trigger_price, 101);
    assert.equal(first.day_reference_price, 100);
    console.log('OK same-symbol multi signal_id counted separately');
}

function testSourcesNotMixed(): void {
    const dir = mkdtempSync(join(tmpdir(), 'early-rep-'));
    const store = new EarlyDailyReportStore(dir);

    const replayOutcomes = [
        fakeOutcome({
            signal_id: 'r1',
            symbol: '2330',
            day_plus_3pct: {
                verdict: 'SUCCESS',
                first_hit_after_min: 2,
                first_hit_bar_known_at_ms: 1,
                time_precision: '1m_bar',
            },
        }),
    ];
    const liveOutcomes = [
        fakeOutcome({
            signal_id: 'l1',
            symbol: '2330',
            day_plus_3pct: emptyTarget('FAIL'),
        }),
        fakeOutcome({
            signal_id: 'l2',
            symbol: '2317',
            day_plus_3pct: emptyTarget('FAIL'),
        }),
    ];

    const replay = buildEarlyDailyReport(summaryFrom(replayOutcomes), {
        trade_date: '2026-06-15',
        source: 'replay',
    });
    const live = buildEarlyDailyReport(summaryFrom(liveOutcomes), {
        trade_date: '2026-06-15',
        source: 'live',
    });
    store.save(replay);
    store.save(live);

    const sources = store.listSources('2026-06-15');
    assert.deepEqual(sources, ['live', 'replay']);

    const loadedReplay = store.load('2026-06-15', 'replay')!;
    const loadedLive = store.load('2026-06-15', 'live')!;
    assert.equal(loadedReplay.day_plus_3pct.success, 1);
    assert.equal(loadedReplay.day_plus_3pct.fail, 0);
    assert.equal(loadedLive.day_plus_3pct.success, 0);
    assert.equal(loadedLive.day_plus_3pct.fail, 2);
    // Mixing would be 1/3 — must not happen on either report
    assert.notEqual(
        loadedReplay.day_plus_3pct.rate,
        loadedLive.day_plus_3pct.rate,
    );
    assert.equal(loadedReplay.source_label, '歷史重播');
    assert.equal(loadedLive.source_label, '實盤歷史');

    const all = store.loadAllForDate('2026-06-15');
    assert.equal(all.length, 2);
    // Each keeps own rate — no merged bucket
    for (const r of all) {
        assert.ok(
            r.source === 'replay' || r.source === 'live',
            'source tagged',
        );
    }

    rmSync(dir, { recursive: true, force: true });
    console.log('OK sources stored separately; rates not mixed');
}

function testSyntheticLabel(): void {
    const report = buildEarlyDailyReport(summaryFrom([]), {
        trade_date: '2026-06-15',
        source: 'synthetic' satisfies EarlyReportSource,
    });
    assert.equal(report.source_label, '模擬資料');
    assert.equal(report.signal_count, 0);
    assert.equal(report.day_plus_3pct.rate_label, '資料不足');
    console.log('OK synthetic source label + empty report');
}

testFormatRateInsufficient();
testAllUnknown();
testAllIncomplete();
testMultiSignalSameSymbol();
testSourcesNotMixed();
testSyntheticLabel();
// Ensure EarlyBacktestSession still importable alongside report builder
assert.ok(typeof EarlyBacktestSession === 'function');
console.log('\nAll early-daily-report tests passed');
