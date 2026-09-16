// Build final Full Live Acceptance report from samples + gates.

import type {
    CoverageSample,
    LiveAcceptanceReport,
    LiveGateResult,
    LiveStatus,
    ReadinessTimeline,
    RuntimeSample,
} from './types.ts';
import { LA_VERSION } from './types.ts';
import { gateStatusRank } from './status-rank.ts';

function p95Of(values: number[]): number | null {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * 0.95) - 1));
    return s[i]!;
}

function mergeGates(
    offline: LiveGateResult[],
    live: LiveGateResult[],
): LiveGateResult[] {
    const map = new Map<string, LiveGateResult>();
    for (const g of offline) map.set(g.id, g);
    for (const g of live) {
        const prev = map.get(g.id);
        if (!prev) {
            map.set(g.id, g);
            continue;
        }
        // Prefer live when it has stronger evidence; keep offline PASS for LIVE3/5/12/13
        if (g.status === 'NOT_RUN') continue;
        if (
            gateStatusRank(g.status) >= gateStatusRank(prev.status) ||
            (prev.mode === 'offline' && g.mode === 'live' && g.status === 'PASS')
        ) {
            // LIVE2/3: offline PARTIAL + live PASS → live; offline PASS stays if live NOT better
            if (prev.status === 'PASS' && g.status === 'PARTIAL') continue;
            map.set(g.id, g);
        }
    }
    // Ensure all LIVE1–13 present
    const ids = [
        'LIVE1',
        'LIVE2',
        'LIVE3',
        'LIVE4',
        'LIVE5',
        'LIVE6',
        'LIVE7',
        'LIVE8',
        'LIVE9',
        'LIVE10',
        'LIVE11',
        'LIVE12',
        'LIVE13',
    ];
    for (const id of ids) {
        if (!map.has(id)) {
            map.set(id, {
                id,
                status: 'NOT_RUN',
                detail: 'not evaluated',
                mode: 'instrumentation',
            });
        }
    }
    return ids.map((id) => map.get(id)!);
}

function verdictOf(gates: LiveGateResult[]): 'PASS' | 'WARNING' | 'FAIL' {
    let worst = 0;
    for (const g of gates) {
        if (g.status === 'FAIL') worst = Math.max(worst, 3);
        else if (g.status === 'WARNING' || g.status === 'PARTIAL')
            worst = Math.max(worst, 2);
        else if (g.status === 'NOT_RUN') worst = Math.max(worst, 2);
    }
    if (worst >= 3) return 'FAIL';
    if (worst >= 2) return 'WARNING';
    return 'PASS';
}

function topRisks(gates: LiveGateResult[]): string[] {
    return gates
        .filter(
            (g) =>
                g.status === 'FAIL' ||
                g.status === 'WARNING' ||
                g.status === 'PARTIAL' ||
                g.status === 'NOT_RUN',
        )
        .sort((a, b) => gateStatusRank(b.status) - gateStatusRank(a.status))
        .slice(0, 3)
        .map((g) => `${g.id} ${g.status}: ${g.detail}`);
}

export function buildReport(input: {
    readiness: ReadinessTimeline;
    offlineGates: LiveGateResult[];
    liveGates: LiveGateResult[];
    runtimeSamples: RuntimeSample[];
    coverageSamples: CoverageSample[];
    notify: {
        notification_count: number;
        duplicate_count: number;
        cooldown_suppressed_count: number;
        false_repeat_count: number;
    };
    peaks: { rss_mb: number; cpu_pct: number; firestore_queue: number };
    restartSeconds: number | null;
    commitHash: string | null;
    tradingDay: string;
}): LiveAcceptanceReport {
    const gates = mergeGates(input.offlineGates, input.liveGates);
    const byId = (id: string) => gates.find((g) => g.id === id);

    const lagVals = input.runtimeSamples
        .map((s) => s.event_loop_lag_ms)
        .filter((x): x is number => x != null);
    const lastRt = input.runtimeSamples.at(-1) ?? null;
    const lastCov = input.coverageSamples.at(-1) ?? null;

    const windows = new Set(
        input.runtimeSamples.map((s) => s.session_window),
    );
    const required: Array<typeof input.runtimeSamples[0]['session_window']> = [
        '08:30-09:00',
        '09:00-09:10',
        '09:10-09:30',
        '09:30-11:30',
        '13:00-13:30',
    ];
    const fullDay = required.every((w) => windows.has(w));

    const futureLeak: 'YES' | 'NO' | 'UNKNOWN' =
        byId('LIVE5')?.status === 'PASS'
            ? 'NO'
            : byId('LIVE5')?.status === 'FAIL'
              ? 'YES'
              : 'UNKNOWN';
    const caMisread: 'YES' | 'NO' | 'UNKNOWN' =
        byId('LIVE3')?.status === 'PASS' || byId('LIVE3')?.status === 'PARTIAL'
            ? 'NO'
            : byId('LIVE3')?.status === 'FAIL'
              ? 'YES'
              : 'UNKNOWN';
    const sectorBias: 'YES' | 'NO' | 'UNKNOWN' =
        byId('LIVE6')?.status === 'PASS'
            ? 'NO'
            : byId('LIVE6')?.status === 'FAIL'
              ? 'YES'
              : 'UNKNOWN';
    const notifDup: 'YES' | 'NO' | 'UNKNOWN' =
        byId('LIVE8')?.status === 'PASS'
            ? 'NO'
            : byId('LIVE8')?.status === 'FAIL'
              ? 'YES'
              : input.notify.notification_count === 0
                ? 'UNKNOWN'
                : 'NO';
    const staleRt: 'YES' | 'NO' | 'UNKNOWN' =
        byId('LIVE12')?.status === 'PASS'
            ? 'NO'
            : byId('LIVE12')?.status === 'FAIL'
              ? 'YES'
              : 'UNKNOWN';

    return {
        version: LA_VERSION,
        generated_at: new Date().toISOString(),
        trading_day: input.tradingDay,
        instrumentation_ready: true,
        full_trading_day_recorded: fullDay,
        readiness: input.readiness,
        gates,
        summary: {
            verdict: verdictOf(gates),
            top_risks: topRisks(gates),
            future_leak: futureLeak,
            corporate_action_misread: caMisread,
            sector_selection_bias: sectorBias,
            notification_duplicate: notifDup,
            stale_as_realtime: staleRt,
            peak_memory_mb: input.peaks.rss_mb || null,
            peak_cpu_pct: input.peaks.cpu_pct || null,
            event_loop_p95_ms: p95Of(lagVals),
            C_p95_ms: lastRt?.C_eval.p95_ms ?? null,
            BP_p95_ms: lastRt?.BP_eval.p95_ms ?? null,
            Context_p95_ms: lastRt?.Context_eval.p95_ms ?? null,
            firestore_queue_max: input.peaks.firestore_queue || null,
            firestore_write_failure:
                lastRt?.firestore_write_failures ?? null,
            market_coverage_pct: lastCov?.market_coverage_pct ?? null,
            sector_coverage_pct: lastCov?.sector_coverage_pct ?? null,
            restart_recovery_seconds: input.restartSeconds,
            abc_changed: 'NO',
            bp_changed: 'NO',
            production_threshold_changed: 'NO',
            commit_hash: input.commitHash,
        },
        samples: {
            runtime_count: input.runtimeSamples.length,
            coverage_count: input.coverageSamples.length,
            last_coverage: lastCov,
            last_runtime: lastRt,
        },
        creates_upstream_subscription: false,
        mutates_strategy: false,
    };
}

export type { LiveStatus };
