// LiveAcceptanceService — periodic sampling; observe-only.

import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { AppContext } from '../../context.ts';
import { EvalTimingRegistry } from './eval-timing.ts';
import { ReadinessTracker } from './readiness.ts';
import { runOfflineGates } from './assertions.ts';
import {
    JsonlSink,
    liveAcceptanceDataDir,
    sessionWindowAt,
    taipeiHm,
} from './sink.ts';
import type {
    CoverageSample,
    LiveAcceptanceReport,
    LiveGateResult,
    RuntimeSample,
} from './types.ts';
import { LA_VERSION } from './types.ts';
import { buildReport } from './report.ts';
import { assembleDailyReport } from './daily-finalize.ts';
import {
    buildContextSummary,
    buildFirestoreSummary,
    buildMarketSummary,
    buildNotificationSummary,
    buildSystemSummary,
    collectBpEventRows,
    collectIntegrityFindings,
    collectStrategyRows,
    reportPaths,
    todayYmd,
} from './daily-collect.ts';
import type { DailyLiveAcceptanceReport } from './daily-types.ts';
import type { StrategySignal } from '../strategy-signal/types.ts';
import { countSignalTypes } from './daily-sampler.ts';

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
    private notifyPriority = { HIGH: 0, MEDIUM: 0, INFO: 0 };
    private lastDailyReport: DailyLiveAcceptanceReport | null = null;
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
        priority?: 'HIGH' | 'MEDIUM' | 'INFO';
    }): void {
        if (opts.emitted) {
            this.notifyStats.notification_count += 1;
            if (opts.priority) this.notifyPriority[opts.priority] += 1;
        }
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
        // Soft BP event snapshot for daily samples (no ticks / bidask)
        try {
            const bpRows = collectBpEventRows(this.ctx);
            if (bpRows.length) {
                this.sink?.append({
                    kind: 'bp_events_snapshot',
                    at: broad.at,
                    count: bpRows.length,
                    // Cap payload — summary only
                    types: bpRows.reduce<Record<string, number>>((acc, r) => {
                        acc[r.signal_type] = (acc[r.signal_type] ?? 0) + 1;
                        return acc;
                    }, {}),
                });
            }
        } catch {
            /* soft */
        }
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
        notify: {
            notification_count: number;
            duplicate_count: number;
            cooldown_suppressed_count: number;
            false_repeat_count: number;
        };
        notify_priority: { HIGH: number; MEDIUM: number; INFO: number };
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
            notify_priority: { ...this.notifyPriority },
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

    /** Today summary for UI / GET .../today — no strategy mutation. */
    getTodaySummary(): {
        trading_day: string;
        overall: 'PASS' | 'WARNING' | 'FAIL' | 'PENDING';
        market_coverage_pct: number | null;
        runtime: { rss_mb_peak: number; cpu_pct_peak: number };
        firestore: DailyLiveAcceptanceReport['firestore'] | null;
        signals: DailyLiveAcceptanceReport['signals'] | null;
        notifications: DailyLiveAcceptanceReport['notifications'];
        anomalies_count: number;
        anomaly_kinds: string[];
        generated_at: string | null;
        finalized: boolean;
        mutates_strategy: false;
    } {
        const ymd = todayYmd();
        const last =
            this.lastDailyReport && this.lastDailyReport.trading_day === ymd
                ? this.lastDailyReport
                : null;
        const cov = this.coverageSamples.at(-1) ?? null;
        const firestore = buildFirestoreSummary(this.ctx, ymd, {
            firestore_queue: this.peakFsQueue,
        });
        const allRows = [
            ...collectStrategyRows(this.ctx, ymd),
            ...collectBpEventRows(this.ctx),
        ];
        const signals = last?.signals ?? countSignalTypes(allRows);
        const anomalies = last?.anomalies ?? [];
        const kindSet = Array.from(new Set(anomalies.map((a) => a.kind)));

        return {
            trading_day: ymd,
            overall: last?.overall ?? 'PENDING',
            market_coverage_pct: cov?.market_coverage_pct ?? null,
            runtime: {
                rss_mb_peak: this.peakRssMb,
                cpu_pct_peak: this.peakCpuPct,
            },
            firestore,
            signals,
            notifications: buildNotificationSummary({
                notify: this.notifyStats,
                priority: this.notifyPriority,
            }),
            anomalies_count: anomalies.length,
            anomaly_kinds: kindSet,
            generated_at: last?.generated_at ?? null,
            finalized: Boolean(last),
            mutates_strategy: false,
        };
    }

    /** Paths for today's finalized pack; null if not generated this process/day. */
    getFinalizedPaths(): {
        trading_day: string;
        generated_at: string;
        md: string;
        json: string;
        csv: string;
        zip_name: string;
    } | null {
        const ymd = todayYmd();
        const last = this.lastDailyReport;
        if (!last || last.trading_day !== ymd) return null;
        return {
            trading_day: ymd,
            generated_at: last.generated_at,
            md: last.paths.md,
            json: last.paths.json,
            csv: last.paths.csv,
            zip_name: `${ymd}-live-acceptance-pack.zip`,
        };
    }

    getDailySamples(): {
        trading_day: string;
        samples: DailyLiveAcceptanceReport['signal_samples'];
        anomalies: DailyLiveAcceptanceReport['anomalies'];
        mutates_strategy: false;
    } {
        const ymd = todayYmd();
        if (this.lastDailyReport && this.lastDailyReport.trading_day === ymd) {
            return {
                trading_day: ymd,
                samples: this.lastDailyReport.signal_samples,
                anomalies: this.lastDailyReport.anomalies,
                mutates_strategy: false,
            };
        }
        const assembled = this.buildDailyArtifacts(null);
        return {
            trading_day: ymd,
            samples: assembled.report.signal_samples,
            anomalies: assembled.report.anomalies,
            mutates_strategy: false,
        };
    }

    /**
     * Finalize: write MD/JSON/CSV under reports/live/.
     * Does NOT change strategy / thresholds / weights.
     */
    finalizeDailyReport(commitHash: string | null): DailyLiveAcceptanceReport {
        const assembled = this.buildDailyArtifacts(commitHash);
        const { report, md, csv } = assembled;
        mkdirSync(reportPaths(this.dataDir, report.trading_day).dir, {
            recursive: true,
        });
        writeFileSync(report.paths.json, JSON.stringify(report, null, 2), 'utf8');
        writeFileSync(report.paths.md, md, 'utf8');
        writeFileSync(report.paths.csv, csv, 'utf8');
        // Also keep legacy live-acceptance report json
        try {
            this.sink?.writeJson(this.reportPath, {
                daily: report,
                legacy: this.buildAcceptanceReport(commitHash),
            });
        } catch {
            /* soft */
        }
        this.lastDailyReport = report;
        this.sink?.append({
            kind: 'finalize',
            at: report.generated_at,
            overall: report.overall,
            paths: report.paths,
        });
        return report;
    }

    private buildDailyArtifacts(commitHash: string | null) {
        const ymd = todayYmd();
        const paths = reportPaths(this.dataDir, ymd);
        const offline = runOfflineGates();
        const liveGates = this.deriveLiveGates();
        // merge offline into live list for quality dims
        const byId = new Map<string, LiveGateResult>();
        for (const g of offline) byId.set(g.id, g);
        for (const g of liveGates) byId.set(g.id, g);
        const gates = [...byId.values()];

        const cov = this.coverageSamples.at(-1) ?? null;
        const system = buildSystemSummary({
            ctx: this.ctx,
            peaks: {
                rss_mb: this.peakRssMb,
                cpu_pct: this.peakCpuPct,
                firestore_queue: this.peakFsQueue,
            },
            runtimeSamples: this.runtimeSamples,
        });
        const market = buildMarketSummary(this.ctx, cov);
        const notifications = buildNotificationSummary({
            notify: this.notifyStats,
            priority: this.notifyPriority,
        });
        const firestore = buildFirestoreSummary(this.ctx, ymd, {
            firestore_queue: this.peakFsQueue,
        });
        let signals: StrategySignal[] = [];
        try {
            signals = this.ctx.researchRepos?.signals.listByDate(ymd) ?? [];
        } catch {
            signals = [];
        }
        const context = buildContextSummary(signals);
        const integrity = collectIntegrityFindings(signals, market, cov);
        const allRows = [
            ...collectStrategyRows(this.ctx, ymd),
            ...collectBpEventRows(this.ctx),
        ];
        return assembleDailyReport({
            tradingDay: ymd,
            system,
            market,
            notifications,
            firestore,
            context,
            allRows,
            integrity,
            liveGates: gates,
            paths: { md: paths.md, json: paths.json, csv: paths.csv },
            commitHash,
        });
    }
}
