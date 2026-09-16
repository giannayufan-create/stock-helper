// Full Live Acceptance offline + instrumentation tests
// Run: npx tsx src/lib/live-acceptance/la.test.ts

import assert from 'node:assert/strict';
import { runOfflineGates } from './assertions.ts';
import { EvalTimingRegistry } from './eval-timing.ts';
import { ReadinessTracker } from './readiness.ts';
import { sessionWindowAt, taipeiHm } from './sink.ts';
import { buildReport } from './report.ts';
import { LA_VERSION } from './types.ts';
import {
    countSignalTypes,
    rowsToCsv,
    selectAnomalies,
    selectSignalSamples,
} from './daily-sampler.ts';
import { assembleDailyReport } from './daily-finalize.ts';
import { DAILY_LA_VERSION } from './daily-types.ts';
import type { SignalSampleRow } from './daily-types.ts';
import { buildZip } from './zip-pack.ts';

console.log('=== Live Acceptance instrumentation tests ===');

{
    ReadinessTracker._resetForTest();
    ReadinessTracker.markServerStarted('2026-09-16T00:00:00.000Z');
    ReadinessTracker.markCReady('2026-09-16T00:00:05.000Z');
    ReadinessTracker.markBPReady('2026-09-16T00:00:06.000Z');
    ReadinessTracker.markContextReady('2026-09-16T00:00:07.000Z');
    ReadinessTracker.markDataHealthy('2026-09-16T00:00:10.000Z');
    const s = ReadinessTracker.snapshot();
    assert.equal(s.time_to_data_healthy_ms, 10_000);
    assert.ok((s.time_to_radar_ready_ms ?? 0) >= 7000);
    console.log('PASS readiness timeline');
}

{
    EvalTimingRegistry.reset();
    EvalTimingRegistry.note('C', 10);
    EvalTimingRegistry.note('C', 20);
    EvalTimingRegistry.note('C', 30);
    const st = EvalTimingRegistry.stats('C');
    assert.equal(st.count, 3);
    assert.equal(st.max_ms, 30);
    assert.ok(st.avg_ms != null && st.avg_ms > 0);
    console.log('PASS eval timing registry');
}

{
    const gates = runOfflineGates();
    const ids = new Set(gates.map((g) => g.id));
    assert.ok(ids.has('LIVE3'));
    assert.ok(ids.has('LIVE5'));
    assert.ok(ids.has('LIVE13'));
    assert.equal(gates.find((g) => g.id === 'LIVE13')?.status, 'PASS');
    assert.equal(gates.find((g) => g.id === 'LIVE5')?.status, 'PASS');
    assert.equal(gates.find((g) => g.id === 'LIVE4')?.status, 'PASS');
    console.log('PASS offline gates LIVE3/4/5/13');
}

{
    const { ymd } = taipeiHm(new Date('2026-09-16T01:05:00+08:00'));
    assert.equal(ymd, '2026-09-16');
    const w = sessionWindowAt(new Date('2026-09-16T09:05:00+08:00'));
    assert.equal(w, '09:00-09:10');
    console.log('PASS session window helper');
}

{
    const report = buildReport({
        readiness: ReadinessTracker.snapshot(),
        offlineGates: runOfflineGates(),
        liveGates: [
            {
                id: 'LIVE1',
                status: 'WARNING',
                detail: 'no live DATA_HEALTHY',
                mode: 'instrumentation',
            },
            {
                id: 'LIVE11',
                status: 'NOT_RUN',
                detail: 'restart not run',
                mode: 'instrumentation',
            },
        ],
        runtimeSamples: [],
        coverageSamples: [],
        notify: {
            notification_count: 0,
            duplicate_count: 0,
            cooldown_suppressed_count: 0,
            false_repeat_count: 0,
        },
        peaks: { rss_mb: 0, cpu_pct: 0, firestore_queue: 0 },
        restartSeconds: null,
        commitHash: 'test',
        tradingDay: '2026-09-16',
    });
    assert.equal(report.version, LA_VERSION);
    assert.equal(report.mutates_strategy, false);
    assert.equal(report.summary.abc_changed, 'NO');
    assert.equal(report.summary.bp_changed, 'NO');
    assert.equal(report.summary.production_threshold_changed, 'NO');
    assert.equal(report.summary.future_leak, 'NO');
    assert.equal(report.summary.corporate_action_misread, 'NO');
    assert.ok(['WARNING', 'FAIL'].includes(report.summary.verdict));
    assert.equal(report.gates.length, 13);
    console.log('PASS report builder');
}

{
    const mk = (
        type: string,
        extra: Partial<SignalSampleRow> = {},
    ): SignalSampleRow => ({
        timestamp: '2026-09-16T01:30:00.000Z',
        symbol: extra.symbol ?? '2330',
        name: 'TSMC',
        signal_type: type,
        price: 100,
        change_pct: 1,
        BP: extra.BP ?? 60,
        C_score: 80,
        rank: 1,
        rank_change: extra.rank_change ?? 0,
        VWAP: 0.5,
        RVOL: 2,
        taiwan_regime: 'NEUTRAL',
        sector: 'semiconductor',
        sector_state: extra.sector_state ?? 'STABLE',
        sector_rank: 1,
        capital_rotation: 0.1,
        event_state: null,
        corporate_action: extra.corporate_action ?? null,
        context_alignment: extra.context_alignment ?? null,
        outcome_5m: null,
        outcome_15m: extra.outcome_15m ?? null,
        outcome_30m: null,
        outcome_60m: null,
        MFE: null,
        MAE: null,
        invalid: extra.invalid ?? null,
        sample_tags: extra.sample_tags ?? [],
        ...extra,
    });

    const pool = [
        ...Array.from({ length: 12 }, (_, i) =>
            mk('EARLY_ENTER', { symbol: `E${i}`, BP: 55 + i }),
        ),
        ...Array.from({ length: 12 }, (_, i) =>
            mk('BUY_SURGE', { symbol: `B${i}`, BP: 80 + (i % 5) }),
        ),
        ...Array.from({ length: 6 }, (_, i) =>
            mk('BREAKOUT', { symbol: `K${i}`, BP: 70 }),
        ),
        mk('RANK_JUMP', { symbol: 'RJ1', rank_change: 12 }),
        mk('SURGE', {
            symbol: 'REV1',
            BP: 90,
            outcome_15m: -2.5,
        }),
        mk('BUY_SURGE', {
            symbol: 'OUT1',
            BP: 85,
            sector_state: 'ROTATING_OUT',
        }),
        mk('EARLY_ENTER', { symbol: 'INV1', invalid: true }),
        mk('SURGE', {
            symbol: 'CA1',
            corporate_action: 'EX-DIV',
        }),
    ];

    const samples = selectSignalSamples(pool);
    assert.ok(samples.length <= 50);
    assert.ok(
        samples.filter((r) => r.signal_type === 'EARLY_ENTER').length >= 10,
    );
    assert.ok(
        samples.filter((r) => r.signal_type === 'BUY_SURGE').length >= 10,
    );
    assert.ok(
        samples.filter((r) => r.signal_type === 'BREAKOUT').length >= 5,
    );
    const anomalies = selectAnomalies(pool);
    assert.ok(anomalies.some((a) => a.kind === 'A_REVERSE_15M'));
    assert.ok(anomalies.some((a) => a.kind === 'B_BP_HIGH_SECTOR_OUT'));
    assert.ok(anomalies.some((a) => a.kind === 'C_EARLY_FAST_INVALID'));
    assert.ok(anomalies.some((a) => a.kind === 'E_CORPORATE_ACTION'));
    const csv = rowsToCsv(samples);
    assert.ok(csv.includes('signal_type'));
    assert.ok(csv.includes('EARLY_ENTER'));

    const assembled = assembleDailyReport({
        tradingDay: '2026-09-16',
        system: {
            server_started_at: '2026-09-16T00:00:00.000Z',
            uptime_sec: 100,
            shioaji_or_market_provider: 'mock',
            market_runtime_ok: true,
            data_health_note: 'ok',
            sse_clients: 1,
            cpu_pct_peak: 10,
            rss_mb_peak: 200,
            heap_mb_last: 100,
            event_loop_lag_p95_ms: 5,
            C_eval_latency: { avg_ms: 1, p95_ms: 2 },
            BP_eval_latency: { avg_ms: 1, p95_ms: 2 },
            Context_eval_latency: { avg_ms: 1, p95_ms: 2 },
            firestore_queue_depth_last: 0,
            firestore_queue_max: 0,
            firestore_write_latency_avg_ms: 1,
            firestore_write_failures: 0,
        },
        market: {
            broad_universe_size: 1800,
            market_coverage_pct: 90,
            sector_coverage_pct: 80,
            advancers: 500,
            decliners: 400,
            unchanged: 100,
            taiwan_regime: 'NEUTRAL',
            sector_rotation_states: { HOT: 2 },
            corporate_action_count: 1,
            expiry_context: 'T-3',
        },
        notifications: {
            notification_count: 3,
            duplicate_count: 0,
            cooldown_suppressed_count: 1,
            HIGH: 1,
            MEDIUM: 2,
            INFO: 0,
        },
        firestore: {
            strategy_signal_count: 10,
            context_snapshot_count: 5,
            outcome_count: 8,
            missing_count: 2,
            duplicate_count: 0,
            conflict_count: 0,
            queue_max: 0,
            write_failure_count: 0,
            effective_mode: 'jsonl',
        },
        context: {
            context_coverage_pct: 70,
            context_confidence: 'HIGH',
            MARKET_ALIGNED: 2,
            SECTOR_ROTATING_IN: 1,
            EVENT_CONFIRMED: 0,
            CONTRARY: 1,
            INSUFFICIENT_DATA: 3,
        },
        allRows: pool,
        integrity: [],
        liveGates: runOfflineGates(),
        paths: {
            md: '/tmp/x.md',
            json: '/tmp/x.json',
            csv: '/tmp/x.csv',
        },
        commitHash: 'test',
    });
    assert.equal(assembled.report.version, DAILY_LA_VERSION);
    assert.equal(assembled.report.mutates_strategy, false);
    assert.ok(assembled.md.includes('Daily Live Acceptance'));
    assert.ok(countSignalTypes(pool).EARLY_ENTER >= 12);
    console.log('PASS daily sampler / finalize');
}

{
    const zip = buildZip([
        { name: 'a.md', data: '# hi\n' },
        { name: 'b.json', data: '{"ok":true}' },
        { name: 'c.csv', data: 'a,b\n1,2\n' },
    ]);
    assert.ok(zip.length > 40);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    console.log('PASS zip pack');
}

console.log('\nAll Live Acceptance instrumentation tests PASSED');
