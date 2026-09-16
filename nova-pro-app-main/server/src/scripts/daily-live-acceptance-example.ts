// One-shot example report generator (observe only).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runOfflineGates } from '../lib/live-acceptance/assertions.ts';
import { assembleDailyReport } from '../lib/live-acceptance/daily-finalize.ts';
import type { SignalSampleRow } from '../lib/live-acceptance/daily-types.ts';

const day = '2026-09-16';
const dir = join(process.cwd(), 'reports', 'live');
mkdirSync(dir, { recursive: true });
const paths = {
    md: join(dir, `${day}-live-acceptance.md`),
    json: join(dir, `${day}-live-acceptance.json`),
    csv: join(dir, `${day}-signal-samples.csv`),
};

const row = (
    t: string,
    sym: string,
    extra: Partial<SignalSampleRow> = {},
): SignalSampleRow => ({
    timestamp: '2026-09-16T01:35:00.000Z',
    symbol: sym,
    name: sym,
    signal_type: t,
    price: 100,
    change_pct: 1.2,
    BP: 72,
    C_score: 88,
    rank: 3,
    rank_change: 5,
    VWAP: 0.4,
    RVOL: 3.1,
    taiwan_regime: 'NEUTRAL',
    sector: '17',
    sector_state: 'HOT',
    sector_rank: 2,
    capital_rotation: 0.2,
    event_state: null,
    corporate_action: null,
    context_alignment: 'ALIGNED',
    outcome_5m: 0.3,
    outcome_15m: 0.5,
    outcome_30m: null,
    outcome_60m: null,
    MFE: 1.2,
    MAE: -0.4,
    invalid: false,
    sample_tags: [],
    ...extra,
});

const all = [
    ...Array.from({ length: 10 }, (_, i) => row('EARLY_ENTER', `E${i}`)),
    ...Array.from({ length: 10 }, (_, i) =>
        row('BUY_SURGE', `B${i}`, { BP: 85 }),
    ),
    ...Array.from({ length: 5 }, (_, i) => row('BREAKOUT', `K${i}`)),
];

const a = assembleDailyReport({
    tradingDay: day,
    system: {
        server_started_at: '2026-09-16T00:00:00.000Z',
        uptime_sec: 3600,
        shioaji_or_market_provider: 'fugle',
        market_runtime_ok: true,
        data_health_note: 'DATA_HEALTHY',
        sse_clients: 2,
        cpu_pct_peak: 35,
        rss_mb_peak: 420,
        heap_mb_last: 180,
        event_loop_lag_p95_ms: 12,
        C_eval_latency: { avg_ms: 8, p95_ms: 15 },
        BP_eval_latency: { avg_ms: 6, p95_ms: 12 },
        Context_eval_latency: { avg_ms: 4, p95_ms: 9 },
        firestore_queue_depth_last: 0,
        firestore_queue_max: 2,
        firestore_write_latency_avg_ms: 20,
        firestore_write_failures: 0,
    },
    market: {
        broad_universe_size: 1800,
        market_coverage_pct: 92,
        sector_coverage_pct: 80,
        advancers: 700,
        decliners: 900,
        unchanged: 200,
        taiwan_regime: 'RISK_OFF_BROAD',
        sector_rotation_states: { HOT: 3, STABLE: 20 },
        corporate_action_count: 30,
        expiry_context: 'MONTHLY_EXPIRY',
    },
    notifications: {
        notification_count: 12,
        duplicate_count: 0,
        cooldown_suppressed_count: 4,
        HIGH: 5,
        MEDIUM: 7,
        INFO: 0,
    },
    firestore: {
        strategy_signal_count: 40,
        context_snapshot_count: 22,
        outcome_count: 30,
        missing_count: 10,
        duplicate_count: 0,
        conflict_count: 0,
        queue_max: 2,
        write_failure_count: 0,
        effective_mode: 'jsonl',
    },
    context: {
        context_coverage_pct: 65,
        context_confidence: 'MIXED',
        MARKET_ALIGNED: 8,
        SECTOR_ROTATING_IN: 3,
        EVENT_CONFIRMED: 1,
        CONTRARY: 2,
        INSUFFICIENT_DATA: 5,
    },
    allRows: all,
    integrity: [],
    liveGates: runOfflineGates(),
    paths,
    commitHash: 'example',
});

writeFileSync(paths.json, JSON.stringify(a.report, null, 2));
writeFileSync(paths.md, a.md);
writeFileSync(paths.csv, a.csv);
console.log('wrote', paths.md, 'overall=', a.report.overall);
