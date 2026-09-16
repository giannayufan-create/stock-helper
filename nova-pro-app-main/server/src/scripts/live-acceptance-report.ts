// CLI: produce Full Live Acceptance report (offline gates + optional local status).
// Run: npx tsx src/scripts/live-acceptance-report.ts
// Does NOT mutate strategy. Does NOT require live market if only offline.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { runOfflineGates } from '../lib/live-acceptance/assertions.ts';
import { buildReport } from '../lib/live-acceptance/report.ts';
import { ReadinessTracker } from '../lib/live-acceptance/readiness.ts';
import { taipeiHm } from '../lib/live-acceptance/sink.ts';

function commitHash(): string | null {
    try {
        return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch {
        return process.env.RENDER_GIT_COMMIT ?? null;
    }
}

const offline = runOfflineGates();
const { ymd } = taipeiHm();
ReadinessTracker.markServerStarted();

const report = buildReport({
    readiness: ReadinessTracker.snapshot(),
    offlineGates: offline,
    liveGates: [
        {
            id: 'LIVE1',
            status: 'NOT_RUN',
            detail:
                'Full trading-day readiness timeline requires production process with LiveAcceptanceService.start()',
            mode: 'instrumentation',
        },
        {
            id: 'LIVE6',
            status: 'NOT_RUN',
            detail: 'Needs live sector rotation samples',
            mode: 'instrumentation',
        },
        {
            id: 'LIVE7',
            status: 'NOT_RUN',
            detail: 'Needs live event confirmation samples',
            mode: 'instrumentation',
        },
        {
            id: 'LIVE8',
            status: 'NOT_RUN',
            detail: 'Needs live notifications',
            mode: 'instrumentation',
        },
        {
            id: 'LIVE9',
            status: 'NOT_RUN',
            detail: 'Needs runtime sampling in server process',
            mode: 'instrumentation',
        },
        {
            id: 'LIVE10',
            status: 'NOT_RUN',
            detail: 'Needs running researchRepos health',
            mode: 'instrumentation',
        },
        {
            id: 'LIVE11',
            status: 'NOT_RUN',
            detail: 'Controlled restart not executed',
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
    commitHash: commitHash(),
    tradingDay: ymd,
});

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', '..', 'data', 'live-acceptance');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${ymd}-report.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

console.log(JSON.stringify({
    Full_Live_Acceptance: report.summary.verdict,
    top_risks: report.summary.top_risks,
    future_leak: report.summary.future_leak,
    corporate_action_misread: report.summary.corporate_action_misread,
    sector_selection_bias: report.summary.sector_selection_bias,
    notification_duplicate: report.summary.notification_duplicate,
    stale_as_realtime: report.summary.stale_as_realtime,
    peak_memory: report.summary.peak_memory_mb,
    peak_cpu: report.summary.peak_cpu_pct,
    event_loop_p95: report.summary.event_loop_p95_ms,
    C_p95: report.summary.C_p95_ms,
    BP_p95: report.summary.BP_p95_ms,
    Context_p95: report.summary.Context_p95_ms,
    firestore_queue_max: report.summary.firestore_queue_max,
    firestore_write_failure: report.summary.firestore_write_failure,
    market_coverage_pct: report.summary.market_coverage_pct,
    sector_coverage_pct: report.summary.sector_coverage_pct,
    restart_recovery_seconds: report.summary.restart_recovery_seconds,
    abc_changed: report.summary.abc_changed,
    bp_changed: report.summary.bp_changed,
    production_threshold_changed: report.summary.production_threshold_changed,
    commit_hash: report.summary.commit_hash,
    gates: report.gates.map((g) => `${g.id}=${g.status}`),
    report_path: outPath,
    instrumentation_ready: report.instrumentation_ready,
    full_trading_day_recorded: report.full_trading_day_recorded,
}, null, 2));
