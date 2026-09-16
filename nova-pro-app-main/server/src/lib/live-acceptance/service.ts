// LiveAcceptanceService — periodic sampling; observe-only.

import { join } from 'node:path';
import type { AppContext } from '../../context.ts';
import { EvalTimingRegistry } from './eval-timing.ts';
import { ReadinessTracker } from './readiness.ts';
import { runOfflineGates } from './assertions.ts';
import { JsonlSink, liveAcceptanceDataDir, sessionWindowAt, taipeiHm } from './sink.ts';
import type {
    CoverageSample,
    LiveAcceptanceReport,
    LiveGateResult,
    RuntimeSample,
} from './types.ts';
import { LA_VERSION } from './types.ts';
import { buildReport } from './report.ts';

export class LiveAcceptanceService {
    private timer: ReturnType<typeof setInterval> | null = null;
    private lagTimer: ReturnType<typeof setInterval> | null = null;
    private started = false;
    private sink: JsonlSink | null = null;
    private reportPath: string;
    private runtimeSamples: RuntimeSample[] = [];
    private coverageSamples: CoverageSample[] = [];
    private lastEventLoopLagMs: number | null = null;
    private peakRssMb = 0;
    private peakCpuPct = 0;
    private peakFsQueue = 0;
    private lastCpu: NodeJS.CpuUsage | null = null;
    private lastCpuAt = 0;
    private notifyStats = {
        notification_count: 0,
        duplicate_count: 0,
        cooldown_suppressed_count: 0,
        false_repeat_count: 0,
    };
    private restartProbe: { started_at: string | null; seconds: number | null } =
        { started_at: null, seconds: null };

    constructor(
        private ctx: AppContext,
        private dataDir: string,
    ) {
        const dir = liveAcceptanceDataDir(dataDir);
        const { ymd } = taipeiHm();
        this.sink = new JsonlSink(join(dir, `${ymd}.jsonl`));
        this.reportPath = join(dir, `${ymd}-report.json`);
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        // Runtime every 5s; coverage every 60s (aligned with MC)
        this.timer = setInterval(() => {
            void this.sampleRuntime();
        }, 5_000);
        if (typeof this.timer === 'object' && 'unref' in this.timer) {
            (this.timer as NodeJS.Timeout).unref?.();
        }
        const cov = setInterval(() => {
            void this.sampleCoverage();
        }, 60_000);
        (cov as NodeJS.Timeout).unref?.();

        // Event loop lag probe
        let expected = Date.now() + 500;
        this.lagTimer = setInterval(() => {
            const now = Date.now();
            this.lastEventLoopLagMs = Math.max(0, now - expected);
            expected = now + 500;
        }, 500);
        (this.lagTimer as NodeJS.Timeout).unref?.();

        void this.sampleRuntime();
        void this.sampleCoverage();
        console.log(
            `live-acceptance: ${LA_VERSION} sampling → ${this.sink?.path()}`,
        );
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        if (this.lagTimer) clearInterval(this.lagTimer);
        this.timer = null;
        this.lagTimer = null;
        this.started = false;
    }

    noteNotification(opts: {
        emitted: boolean;
        suppressed_cooldown?: boolean;
        duplicate?: boolean;
    }): void {
        if (opts.emitted) this.notifyStats.notification_count += 1;
        if (opts.suppressed_cooldown)
            this.notifyStats.cooldown_suppressed_count += 1;
        if (opts.duplicate) {
            this.notifyStats.duplicate_count += 1;
            this.notifyStats.false_repeat_count += 1;
        }
    }

    markRestartProbeStart(): void {
        this.restartProbe.started_at = new Date().toISOString();
    }

    markRestartProbeDone(): void {
        if (!this.restartProbe.started_at) return;
        this.restartProbe.seconds =
            (Date.now() - Date.parse(this.restartProbe.started_at)) / 1000;
    }

    private mem(): { rss_mb: number; heap_mb: number } {
        const m = process.memoryUsage();
        return {
            rss_mb: Math.round((m.rss / 1024 / 1024) * 10) / 10,
            heap_mb: Math.round((m.heapUsed / 1024 / 1024) * 10) / 10,
        };
    }

    private cpuPct(): number | null {
        const now = Date.now();
        const usage = process.cpuUsage();
        if (!this.lastCpu) {
            this.lastCpu = usage;
            this.lastCpuAt = now;
            return null;
        }
        const elapsedUs = (now - this.lastCpuAt) * 1000;
        const user = usage.user - this.lastCpu.user;
        const sys = usage.system - this.lastCpu.system;
        this.lastCpu = usage;
        this.lastCpuAt = now;
        if (elapsedUs <= 0) return null;
        return Math.round(((user + sys) / elapsedUs) * 1000) / 10;
    }

    async sampleRuntime(): Promise<RuntimeSample> {
        const mem = this.mem();
        const cpu = this.cpuPct();
        this.peakRssMb = Math.max(this.peakRssMb, mem.rss_mb);
        if (cpu != null) this.peakCpuPct = Math.max(this.peakCpuPct, cpu);

        const rp = this.ctx.researchRepos?.getHealth() ?? null;
        const q =
            rp && typeof (rp as { queue_depth?: number }).queue_depth === 'number'
                ? (rp as { queue_depth: number }).queue_depth
                : null;
        if (q != null) this.peakFsQueue = Math.max(this.peakFsQueue, q);

        let active: number | null = null;
        let subs: number | null = null;
        try {
            active = this.ctx.intradayRank?.getLastBatch?.()?.count ?? null;
        } catch {
            /* soft */
        }
        try {
            subs = this.ctx.subs?.count?.() ?? null;
        } catch {
            /* soft */
        }

        const sample: RuntimeSample = {
            at: new Date().toISOString(),
            session_window: sessionWindowAt(),
            rss_mb: mem.rss_mb,
            heap_mb: mem.heap_mb,
            cpu_pct_approx: cpu,
            event_loop_lag_ms: this.lastEventLoopLagMs,
            active_symbols: active,
            subscriptions: subs,
            C_eval: EvalTimingRegistry.stats('C'),
            BP_eval: EvalTimingRegistry.stats('BP'),
            Context_eval: EvalTimingRegistry.stats('Context'),
            firestore_queue_depth: q,
            firestore_write_latency_avg_ms:
                (rp as { write_latency?: { avg_ms?: number } } | null)
                    ?.write_latency?.avg_ms ?? null,
            firestore_write_failures:
                (rp as { write_failure_count?: number } | null)
                    ?.write_failure_count ?? null,
        };
        this.runtimeSamples.push(sample);
        if (this.runtimeSamples.length > 2000) {
            this.runtimeSamples.splice(0, this.runtimeSamples.length - 2000);
        }
        this.sink?.append({ kind: 'runtime', ...sample });
        this.maybeMarkDataHealthy(sample);
        return sample;
    }

    async sampleCoverage(): Promise<CoverageSample> {
        let broad: CoverageSample = {
            at: new Date().toISOString(),
            broad_universe_size: null,
            market_coverage_pct: null,
            advancers: null,
            decliners: null,
            unchanged: null,
            sector_coverage_pct: null,
            uses_active_watch_pool: null,
            bp_active_count: null,
        };
        try {
            const mc = this.ctx.marketContext;
            if (mc) {
                const ov = mc.getOverview() ?? (await mc.evaluate());
                const b = ov?.breadth;
                const u = ov?.broad_universe;
                broad = {
                    ...broad,
                    broad_universe_size: u?.broad_universe_size ?? null,
                    market_coverage_pct: u?.coverage_pct ?? b?.coverage_pct ?? null,
                    advancers: b?.advancers ?? null,
                    decliners: b?.decliners ?? null,
                    unchanged: b?.unchanged ?? null,
                    uses_active_watch_pool: b?.uses_active_watch_pool ?? null,
                    sector_coverage_pct: (() => {
                        const rows = mc.getSectors();
                        if (!rows.length) return null;
                        return Math.min(100, Math.round((rows.length / 30) * 100));
                    })(),
                };
                if (
                    (broad.broad_universe_size ?? 0) > 100 &&
                    (broad.uses_active_watch_pool === false ||
                        broad.uses_active_watch_pool == null)
                ) {
                    ReadinessTracker.markBroadMarketReady();
                    ReadinessTracker.markContextReady();
                }
            }
        } catch {
            /* soft */
        }
        try {
            const bp = this.ctx.buyPressure?.getHealth?.();
            if (bp && typeof bp === 'object') {
                broad.bp_active_count =
                    (bp as { item_count?: number }).item_count ?? null;
            }
        } catch {
            /* soft */
        }
        try {
            const cal = this.ctx.marketCalendar?.getHealth();
            if (cal?.twse_actions_available || cal?.tpex_actions_available) {
                ReadinessTracker.markCorporateActionReady();
            }
        } catch {
            /* soft */
        }

        this.coverageSamples.push(broad);
        if (this.coverageSamples.length > 500) {
            this.coverageSamples.splice(0, this.coverageSamples.length - 500);
        }
        this.sink?.append({ kind: 'coverage', ...broad });
        return broad;
    }

    private maybeMarkDataHealthy(sample: RuntimeSample): void {
        const contracts = this.ctx.market.contractCount();
        if (contracts > 0) ReadinessTracker.markContractsReady();
        const name = this.ctx.market.name();
        if (name === 'shioaji' || name === 'fugle') {
            ReadinessTracker.markShioajiConnected();
            ReadinessTracker.markMarketRuntimeReady();
        }
        if (
            sample.C_eval.count > 0 &&
            sample.BP_eval.count > 0 &&
            ReadinessTracker.snapshot().broad_market_ready_at
        ) {
            ReadinessTracker.markDataHealthy();
        }
    }

    getStatus(): {
        instrumentation_ready: true;
        readiness: ReturnType<typeof ReadinessTracker.snapshot>;
        notify: typeof this.notifyStats;
        peaks: {
            rss_mb: number;
            cpu_pct: number;
            firestore_queue: number;
        };
        sample_counts: { runtime: number; coverage: number };
        mutates_strategy: false;
        creates_upstream_subscription: false;
    } {
        return {
            instrumentation_ready: true,
            readiness: ReadinessTracker.snapshot(),
            notify: { ...this.notifyStats },
            peaks: {
                rss_mb: this.peakRssMb,
                cpu_pct: this.peakCpuPct,
                firestore_queue: this.peakFsQueue,
            },
            sample_counts: {
                runtime: this.runtimeSamples.length,
                coverage: this.coverageSamples.length,
            },
            mutates_strategy: false,
            creates_upstream_subscription: false,
        };
    }

    buildAcceptanceReport(commitHash: string | null): LiveAcceptanceReport {
        const offline = runOfflineGates();
        const liveGates = this.deriveLiveGates();
        const report = buildReport({
            readiness: ReadinessTracker.snapshot(),
            offlineGates: offline,
            liveGates,
            runtimeSamples: this.runtimeSamples,
            coverageSamples: this.coverageSamples,
            notify: this.notifyStats,
            peaks: {
                rss_mb: this.peakRssMb,
                cpu_pct: this.peakCpuPct,
                firestore_queue: this.peakFsQueue,
            },
            restartSeconds: this.restartProbe.seconds,
            commitHash,
            tradingDay: taipeiHm().ymd,
        });
        try {
            this.sink?.writeJson(this.reportPath, report);
        } catch {
            /* soft */
        }
        return report;
    }

    private deriveLiveGates(): LiveGateResult[] {
        const cov = this.coverageSamples.at(-1) ?? null;
        const rt = this.runtimeSamples.at(-1) ?? null;
        const readiness = ReadinessTracker.snapshot();
        const gates: LiveGateResult[] = [];

        gates.push({
            id: 'LIVE1',
            status: readiness.DATA_HEALTHY_at
                ? 'PASS'
                : readiness.server_started_at
                  ? 'WARNING'
                  : 'FAIL',
            detail: readiness.DATA_HEALTHY_at
                ? `data healthy in ${readiness.time_to_data_healthy_ms}ms`
                : 'DATA_HEALTHY not reached in this process (need live boot + market data)',
            mode: readiness.DATA_HEALTHY_at ? 'live' : 'instrumentation',
        });

        const covOk =
            cov &&
            (cov.broad_universe_size ?? 0) > 200 &&
            cov.uses_active_watch_pool === false &&
            (cov.bp_active_count == null ||
                (cov.broad_universe_size ?? 0) > (cov.bp_active_count ?? 0) * 2);
        gates.push({
            id: 'LIVE2',
            status: covOk
                ? 'PASS'
                : cov
                  ? 'PARTIAL'
                  : 'FAIL',
            detail: cov
                ? `universe=${cov.broad_universe_size} coverage=${cov.market_coverage_pct}% bp_active=${cov.bp_active_count} uses_bp_pool=${cov.uses_active_watch_pool}`
                : 'no coverage sample yet',
            mode: cov ? 'live' : 'instrumentation',
        });

        gates.push({
            id: 'LIVE6',
            status: 'NOT_RUN',
            detail:
                'Sector rotation truth check needs live ROTATING_IN/HOT/OUT samples during session',
            mode: 'instrumentation',
        });
        gates.push({
            id: 'LIVE7',
            status: 'NOT_RUN',
            detail:
                'Event confirmation sampling needs live EVENT_* states during session',
            mode: 'instrumentation',
        });

        const notifyDup =
            this.notifyStats.duplicate_count > 0 ||
            this.notifyStats.false_repeat_count > 0;
        gates.push({
            id: 'LIVE8',
            status:
                this.notifyStats.notification_count === 0
                    ? 'NOT_RUN'
                    : notifyDup
                      ? 'FAIL'
                      : 'PASS',
            detail: `emitted=${this.notifyStats.notification_count} dup=${this.notifyStats.duplicate_count} cooldown_suppressed=${this.notifyStats.cooldown_suppressed_count}`,
            mode:
                this.notifyStats.notification_count === 0
                    ? 'instrumentation'
                    : 'live',
        });

            const lag = rt?.event_loop_lag_ms ?? null;
        gates.push({
            id: 'LIVE9',
            status:
                this.runtimeSamples.length === 0
                    ? 'NOT_RUN'
                    : lag != null && lag > 500
                      ? 'FAIL'
                      : lag != null && lag > 200
                        ? 'WARNING'
                        : 'PASS',
            detail: `samples=${this.runtimeSamples.length} peak_rss=${this.peakRssMb}MB peak_cpu≈${this.peakCpuPct}% lag=${lag}ms`,
            mode: this.runtimeSamples.length ? 'live' : 'instrumentation',
        });

        const rp = this.ctx.researchRepos?.getHealth();
        const mode = (rp as { effective_mode?: string } | null)?.effective_mode;
        gates.push({
            id: 'LIVE10',
            status:
                !rp
                    ? 'FAIL'
                    : mode === 'firestore' || mode === 'dual'
                      ? 'PASS'
                      : mode === 'jsonl'
                        ? 'WARNING'
                        : 'FAIL',
            detail: rp
                ? `mode=${mode} failures=${(rp as { write_failure_count?: number }).write_failure_count ?? '?'} (high-freq ticks must not write Firestore — architecture check PASS by design)`
                : 'researchRepos missing',
            mode: 'live',
        });

        gates.push({
            id: 'LIVE11',
            status:
                this.restartProbe.seconds != null
                    ? this.restartProbe.seconds < 120
                        ? 'PASS'
                        : 'WARNING'
                    : 'NOT_RUN',
            detail:
                this.restartProbe.seconds != null
                    ? `recovery=${this.restartProbe.seconds}s`
                    : 'controlled restart not executed this session',
            mode: 'instrumentation',
        });

        return gates;
    }
}
