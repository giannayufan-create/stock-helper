// Full Live Acceptance offline + instrumentation tests
// Run: npx tsx src/lib/live-acceptance/la.test.ts

import assert from 'node:assert/strict';
import { runOfflineGates } from './assertions.ts';
import { EvalTimingRegistry } from './eval-timing.ts';
import { ReadinessTracker } from './readiness.ts';
import { sessionWindowAt, taipeiHm } from './sink.ts';
import { buildReport } from './report.ts';
import { LA_VERSION } from './types.ts';

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

console.log('\nAll Live Acceptance instrumentation tests PASSED');
