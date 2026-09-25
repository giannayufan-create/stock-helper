// EARLY daily report unit tests — UNKNOWN / INCOMPLETE / multi-signal / source isolation /
// full vs partial non-overwrite / date validation / live not wired.

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
    isValidTradeDate,
    LIVE_EARLY_DAILY_REPORT_MESSAGE,
    LIVE_EARLY_DAILY_REPORT_WIRED,
    resolveTradeDateParam,
    gateEarlyDailyReportDate,
    toBucketView,
    type EarlyReportSource,
    type BuildEarlyDailyReportOpts,
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

function meta(
    over: Partial<BuildEarlyDailyReportOpts> &
        Pick<BuildEarlyDailyReportOpts, 'run_id' | 'source'>,
): BuildEarlyDailyReportOpts {
    return {
        trade_date: over.trade_date ?? '2026-06-15',
        source: over.source,
        run_id: over.run_id,
        coverage: over.coverage ?? 'full',
        observation_cutoff_ms:
            over.observation_cutoff_ms ?? Date.parse('2026-06-15T05:30:00.000Z'),
        until_label: over.until_label ?? null,
        symbols: over.symbols ?? ['2330'],
        created_at: over.created_at,
    };
}

function testFormatRateInsufficient(): void {
    assert.equal(formatRateLabel(null, 0), '資料不足');
    assert.equal(formatRateLabel(0, 0), '資料不足');
    assert.equal(formatRateLabel(0, 5), '0.0%');
    assert.equal(formatRateLabel(0.5, 10), '50.0%');
    const v = toBucketView({
        success: 0,
        fail: 0,
        incomplete: 3,
        unknown: 0,
        rate: null,
    });
    assert.equal(v.rate_label, '資料不足');
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
    const report = buildEarlyDailyReport(
        summaryFrom(outcomes),
        meta({ run_id: 'run_unknown', source: 'replay' }),
    );
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
    const report = buildEarlyDailyReport(
        summaryFrom(outcomes),
        meta({ run_id: 'run_inc', source: 'replay' }),
    );
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
    const report = buildEarlyDailyReport(
        summaryFrom(outcomes),
        meta({
            run_id: 'run_multi',
            source: 'replay',
            symbols: ['2330', '2317'],
        }),
    );
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
    const synthOutcomes = [
        fakeOutcome({
            signal_id: 's1',
            symbol: '2330',
            day_plus_3pct: emptyTarget('FAIL'),
        }),
        fakeOutcome({
            signal_id: 's2',
            symbol: '2317',
            day_plus_3pct: emptyTarget('FAIL'),
        }),
    ];

    const replay = buildEarlyDailyReport(summaryFrom(replayOutcomes), {
        ...meta({ run_id: 'rr_full_1', source: 'replay' }),
        created_at: '2026-06-15T06:00:00.000Z',
    });
    const synth = buildEarlyDailyReport(summaryFrom(synthOutcomes), {
        ...meta({ run_id: 'sy_full_1', source: 'synthetic' }),
        created_at: '2026-06-15T06:01:00.000Z',
    });
    store.save(replay);
    store.save(synth);

    const sources = store.listSources('2026-06-15');
    assert.deepEqual(sources, ['replay', 'synthetic']);

    const loadedReplay = store.load('2026-06-15', 'replay')!;
    const loadedSynth = store.load('2026-06-15', 'synthetic')!;
    assert.equal(loadedReplay.day_plus_3pct.success, 1);
    assert.equal(loadedReplay.day_plus_3pct.fail, 0);
    assert.equal(loadedSynth.day_plus_3pct.success, 0);
    assert.equal(loadedSynth.day_plus_3pct.fail, 2);
    assert.notEqual(
        loadedReplay.day_plus_3pct.rate,
        loadedSynth.day_plus_3pct.rate,
    );
    assert.equal(loadedReplay.source_label, '歷史重播');
    assert.equal(loadedSynth.source_label, '模擬資料');

    rmSync(dir, { recursive: true, force: true });
    console.log('OK sources stored separately; rates not mixed');
}

function testSyntheticLabel(): void {
    const report = buildEarlyDailyReport(
        summaryFrom([]),
        meta({
            run_id: 'sy_empty',
            source: 'synthetic' satisfies EarlyReportSource,
        }),
    );
    assert.equal(report.source_label, '模擬資料');
    assert.equal(report.signal_count, 0);
    assert.equal(report.day_plus_3pct.rate_label, '資料不足');
    console.log('OK synthetic source label + empty report');
}

/** Full then partial — full file remains; both runs traceable. */
function testFullThenPartialPreserved(): void {
    const dir = mkdtempSync(join(tmpdir(), 'early-fp-'));
    const store = new EarlyDailyReportStore(dir);

    const fullOutcomes = [
        fakeOutcome({
            signal_id: 'f1',
            symbol: '2330',
            day_plus_3pct: {
                verdict: 'SUCCESS',
                first_hit_after_min: 10,
                first_hit_bar_known_at_ms: 1,
                time_precision: '1m_bar',
            },
        }),
    ];
    const partialOutcomes = [
        fakeOutcome({
            signal_id: 'p1',
            symbol: '2330',
            day_plus_3pct: emptyTarget('INCOMPLETE'),
        }),
    ];

    const full = buildEarlyDailyReport(summaryFrom(fullOutcomes), {
        ...meta({
            run_id: 'rr_full_abc',
            source: 'replay',
            coverage: 'full',
            symbols: ['2330', '2317'],
            observation_cutoff_ms: Date.parse('2026-06-15T05:30:00.000Z'),
        }),
        created_at: '2026-06-15T07:00:00.000Z',
    });
    store.save(full);

    const partial = buildEarlyDailyReport(summaryFrom(partialOutcomes), {
        ...meta({
            run_id: 'rr_partial_until1015',
            source: 'replay',
            coverage: 'partial',
            until_label: '10:15',
            symbols: ['2330'],
            observation_cutoff_ms: Date.parse('2026-06-15T02:16:00.000Z'),
        }),
        created_at: '2026-06-15T07:05:00.000Z',
    });
    store.save(partial);

    const stillFull = store.loadByRun(
        '2026-06-15',
        'replay',
        'full',
        'rr_full_abc',
    );
    assert.ok(stillFull, 'full report still on disk after partial save');
    assert.equal(stillFull!.day_plus_3pct.success, 1);
    assert.equal(stillFull!.coverage, 'full');
    assert.equal(stillFull!.evaluable, true);

    const loadedPartial = store.loadByRun(
        '2026-06-15',
        'replay',
        'partial',
        'rr_partial_until1015',
    );
    assert.ok(loadedPartial);
    assert.equal(loadedPartial!.coverage, 'partial');
    assert.equal(loadedPartial!.evaluable, false);
    assert.equal(loadedPartial!.until_label, '10:15');

    const api = store.listForApi('2026-06-15');
    assert.equal(api.reports.length, 1);
    assert.equal(api.reports[0]!.run_id, 'rr_full_abc');
    assert.equal(api.partial_reports.length, 1);
    assert.equal(api.partial_reports[0]!.run_id, 'rr_partial_until1015');
    assert.ok(api.partial_reports[0]!.note.includes('部分重播'));

    // Same-day different runs both listed
    const allRuns = store.listRuns('2026-06-15', { includeLive: false });
    assert.equal(allRuns.length, 2);
    const ids = new Set(allRuns.map((r) => r.run_id));
    assert.ok(ids.has('rr_full_abc'));
    assert.ok(ids.has('rr_partial_until1015'));

    rmSync(dir, { recursive: true, force: true });
    console.log('OK full then partial — full preserved; runs traceable');
}

function testInvalidDateRejected(): void {
    assert.equal(isValidTradeDate('2026-06-15'), true);
    assert.equal(isValidTradeDate('2026-13-40'), false);
    assert.equal(isValidTradeDate('06/15/2026'), false);
    assert.equal(isValidTradeDate('../etc/passwd'), false);
    assert.equal(isValidTradeDate('2026-06-15/../../x'), false);
    assert.equal(isValidTradeDate(''), false);

    const bad = resolveTradeDateParam('not-a-date');
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error, 'invalid_date');

    // Route contract: illegal date → HTTP 400 (never path composition)
    for (const raw of [
        'not-a-date',
        '2026-13-40',
        '../etc/passwd',
        '2026-06-15/../live',
        '2026/06/15',
    ]) {
        const gate = gateEarlyDailyReportDate(raw);
        assert.equal(gate.ok, false, raw);
        if (!gate.ok) {
            assert.equal(gate.httpStatus, 400, `illegal date must return 400: ${raw}`);
            assert.equal(gate.error, 'invalid_date');
        }
    }
    const okGate = gateEarlyDailyReportDate('2026-06-15');
    assert.equal(okGate.ok, true);
    if (okGate.ok) assert.equal(okGate.date, '2026-06-15');

    const pathy = resolveTradeDateParam('2026-06-15/../live');
    assert.equal(pathy.ok, false);

    const good = resolveTradeDateParam('2026-06-15');
    assert.equal(good.ok, true);
    if (good.ok) assert.equal(good.date, '2026-06-15');

    const dir = mkdtempSync(join(tmpdir(), 'early-bad-'));
    const store = new EarlyDailyReportStore(dir);
    assert.equal(store.listRuns('../etc').length, 0);
    assert.equal(store.loadLatestFull('2026-13-01', 'replay'), null);
    assert.throws(() =>
        buildEarlyDailyReport(summaryFrom([]), {
            ...meta({ run_id: 'x', source: 'replay' }),
            trade_date: 'nope',
        }),
    );
    // Tampered trade_date after build must not write outside the store tree.
    assert.throws(() => {
        store.save({
            ...buildEarlyDailyReport(
                summaryFrom([]),
                meta({ run_id: 'ok2', source: 'replay' }),
            ),
            trade_date: '../../tmp',
        });
    });

    rmSync(dir, { recursive: true, force: true });
    console.log('OK invalid dates rejected → HTTP 400; store path-safe');
}

function testLiveNotWiredNoRates(): void {
    assert.equal(LIVE_EARLY_DAILY_REPORT_WIRED, false);

    const dir = mkdtempSync(join(tmpdir(), 'early-live-'));
    const store = new EarlyDailyReportStore(dir);

    // Even if a live file is written (tests / manual), default API hides it.
    const live = buildEarlyDailyReport(
        summaryFrom([
            fakeOutcome({
                signal_id: 'l1',
                symbol: '2330',
                day_plus_3pct: {
                    verdict: 'SUCCESS',
                    first_hit_after_min: 1,
                    first_hit_bar_known_at_ms: 1,
                    time_precision: '1m_bar',
                },
            }),
        ]),
        meta({ run_id: 'live_manual', source: 'live' }),
    );
    store.save(live);

    const api = store.listForApi('2026-06-15');
    assert.equal(api.live_pipeline.wired, false);
    assert.equal(
        api.live_pipeline.message,
        LIVE_EARLY_DAILY_REPORT_MESSAGE,
    );
    assert.equal(api.reports.length, 0);
    assert.ok(!api.sources.includes('live'));
    assert.equal(store.loadLatestFull('2026-06-15', 'live'), null);
    assert.ok(api.note.includes(LIVE_EARLY_DAILY_REPORT_MESSAGE));

    // Explicit include still allows forensic load
    const forced = store.listRuns('2026-06-15', { includeLive: true });
    assert.equal(forced.length, 1);
    assert.equal(forced[0]!.source, 'live');

    rmSync(dir, { recursive: true, force: true });
    console.log('OK live not wired → no live success rates in default API');
}

testFormatRateInsufficient();
testAllUnknown();
testAllIncomplete();
testMultiSignalSameSymbol();
testSourcesNotMixed();
testSyntheticLabel();
testFullThenPartialPreserved();
testInvalidDateRejected();
testLiveNotWiredNoRates();
assert.ok(typeof EarlyBacktestSession === 'function');
console.log('\nAll early-daily-report tests passed');
