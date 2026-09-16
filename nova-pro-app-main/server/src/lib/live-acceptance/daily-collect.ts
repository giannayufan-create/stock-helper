// Collect day summaries + candidate rows from live ctx — observe only.

import { join } from 'node:path';
import type { AppContext } from '../../context.ts';
import type { StrategySignal } from '../strategy-signal/types.ts';
import type { SignalOutcome } from '../signal-outcome/types.ts';
import type {
    DailyContextSummary,
    DailyFirestoreSummary,
    DailyMarketSummary,
    DailyNotificationSummary,
    DailySystemSummary,
    IntegrityFinding,
    SignalSampleRow,
} from './daily-types.ts';
import type { CoverageSample, RuntimeSample } from './types.ts';
import { liveReportsDir, taipeiHm } from './sink.ts';
import { ReadinessTracker } from './readiness.ts';

function p95(values: number[]): number | null {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1);
    return s[i]!;
}

export function reportPaths(dataDir: string, ymd: string) {
    const dir = liveReportsDir(dataDir);
    return {
        dir,
        md: join(dir, `${ymd}-live-acceptance.md`),
        json: join(dir, `${ymd}-live-acceptance.json`),
        csv: join(dir, `${ymd}-signal-samples.csv`),
    };
}

export function buildSystemSummary(opts: {
    ctx: AppContext;
    peaks: { rss_mb: number; cpu_pct: number; firestore_queue: number };
    runtimeSamples: RuntimeSample[];
}): DailySystemSummary {
    const readiness = ReadinessTracker.snapshot();
    const last = opts.runtimeSamples.at(-1) ?? null;
    const lagVals = opts.runtimeSamples
        .map((s) => s.event_loop_lag_ms)
        .filter((x): x is number => x != null);
    let provider: string | null = null;
    try {
        provider = opts.ctx.market.name();
    } catch {
        provider = null;
    }
    let sse: number | null = null;
    try {
        sse = opts.ctx.hub.clientCount();
    } catch {
        sse = null;
    }
    return {
        server_started_at: readiness.server_started_at,
        uptime_sec: Math.round((Date.now() - opts.ctx.startedAt) / 1000),
        shioaji_or_market_provider: provider,
        market_runtime_ok: Boolean(readiness.market_runtime_ready_at),
        data_health_note: readiness.DATA_HEALTHY_at
            ? 'DATA_HEALTHY'
            : 'not yet DATA_HEALTHY',
        sse_clients: sse,
        cpu_pct_peak: opts.peaks.cpu_pct || null,
        rss_mb_peak: opts.peaks.rss_mb || null,
        heap_mb_last: last?.heap_mb ?? null,
        event_loop_lag_p95_ms: p95(lagVals),
        C_eval_latency: {
            avg_ms: last?.C_eval.avg_ms ?? null,
            p95_ms: last?.C_eval.p95_ms ?? null,
        },
        BP_eval_latency: {
            avg_ms: last?.BP_eval.avg_ms ?? null,
            p95_ms: last?.BP_eval.p95_ms ?? null,
        },
        Context_eval_latency: {
            avg_ms: last?.Context_eval.avg_ms ?? null,
            p95_ms: last?.Context_eval.p95_ms ?? null,
        },
        firestore_queue_depth_last: last?.firestore_queue_depth ?? null,
        firestore_queue_max: opts.peaks.firestore_queue || null,
        firestore_write_latency_avg_ms:
            last?.firestore_write_latency_avg_ms ?? null,
        firestore_write_failures: last?.firestore_write_failures ?? null,
    };
}

export function buildMarketSummary(
    ctx: AppContext,
    coverage: CoverageSample | null,
): DailyMarketSummary {
    const rotation: Record<string, number> = {};
    let regime: string | null = null;
    try {
        const ov = ctx.marketContext?.getOverview();
        regime = ov?.taiwan_regime?.state ?? null;
        for (const row of ctx.marketContext?.getSectors() ?? []) {
            const st = String(row.state ?? 'UNKNOWN');
            rotation[st] = (rotation[st] ?? 0) + 1;
        }
    } catch {
        /* soft */
    }
    let caCount: number | null = null;
    let expiry: string | null = null;
    try {
        const today = ctx.marketCalendar?.getToday?.();
        if (today) {
            caCount = today.corporate_action_count ?? null;
            const ex = today.monthly_expiry;
            if (ex) {
                expiry = ex.is_monthly_expiry_day
                    ? `MONTHLY_EXPIRY ${ex.expiry_phase}`
                    : `${ex.expiry_phase} T-${ex.days_to_monthly_expiry}`;
            }
        }
    } catch {
        /* soft */
    }
    return {
        broad_universe_size: coverage?.broad_universe_size ?? null,
        market_coverage_pct: coverage?.market_coverage_pct ?? null,
        sector_coverage_pct: coverage?.sector_coverage_pct ?? null,
        advancers: coverage?.advancers ?? null,
        decliners: coverage?.decliners ?? null,
        unchanged: coverage?.unchanged ?? null,
        taiwan_regime: regime,
        sector_rotation_states: rotation,
        corporate_action_count: caCount,
        expiry_context: expiry,
    };
}

export function buildNotificationSummary(opts: {
    notify: {
        notification_count: number;
        duplicate_count: number;
        cooldown_suppressed_count: number;
    };
    priority: { HIGH: number; MEDIUM: number; INFO: number };
}): DailyNotificationSummary {
    return {
        notification_count: opts.notify.notification_count,
        duplicate_count: opts.notify.duplicate_count,
        cooldown_suppressed_count: opts.notify.cooldown_suppressed_count,
        HIGH: opts.priority.HIGH,
        MEDIUM: opts.priority.MEDIUM,
        INFO: opts.priority.INFO,
    };
}

export function buildFirestoreSummary(
    ctx: AppContext,
    ymd: string,
    peaks: { firestore_queue: number },
): DailyFirestoreSummary {
    const rp = ctx.researchRepos;
    const health = rp?.getHealth?.() as
        | {
              effective_mode?: string;
              write_failure_count?: number;
              conflict_count?: number;
              max_queue_depth?: number;
          }
        | null
        | undefined;
    let signals: StrategySignal[] = [];
    let outcomes: SignalOutcome[] = [];
    try {
        signals = rp?.signals.listByDate(ymd) ?? [];
    } catch {
        signals = [];
    }
    try {
        outcomes = rp?.outcomes.listByDate(ymd) ?? [];
    } catch {
        outcomes = [];
    }
    const outcomeIds = new Set(outcomes.map((o) => o.signal_id));
    let missing = 0;
    for (const s of signals) {
        if (!outcomeIds.has(s.signal_id)) missing += 1;
    }
    // duplicate signal_ids
    const seen = new Set<string>();
    let dup = 0;
    for (const s of signals) {
        if (seen.has(s.signal_id)) dup += 1;
        else seen.add(s.signal_id);
    }
    const withCtx = signals.filter((s) => s.context_snapshot != null).length;
    return {
        strategy_signal_count: signals.length,
        context_snapshot_count: withCtx,
        outcome_count: outcomes.length,
        missing_count: missing,
        duplicate_count: dup,
        conflict_count: health?.conflict_count ?? 0,
        queue_max: peaks.firestore_queue || health?.max_queue_depth || null,
        write_failure_count: health?.write_failure_count ?? null,
        effective_mode: health?.effective_mode ?? null,
    };
}

export function buildContextSummary(
    signals: StrategySignal[],
): DailyContextSummary {
    let coverageSum = 0;
    let coverageN = 0;
    let confHigh = 0;
    const counts = {
        MARKET_ALIGNED: 0,
        SECTOR_ROTATING_IN: 0,
        EVENT_CONFIRMED: 0,
        CONTRARY: 0,
        INSUFFICIENT_DATA: 0,
    };
    for (const s of signals) {
        const snap = s.context_snapshot;
        if (snap?.context_coverage_pct != null) {
            coverageSum += snap.context_coverage_pct;
            coverageN += 1;
        }
        if (snap?.context_confidence === 'HIGH') confHigh += 1;
        const tags = s.context_tags ?? [];
        if (tags.includes('MARKET_RISK_ON') || s.context_alignment === 'ALIGNED')
            counts.MARKET_ALIGNED += 1;
        if (tags.includes('SECTOR_ROTATING_IN')) counts.SECTOR_ROTATING_IN += 1;
        if (tags.includes('EVENT_CONFIRMED')) counts.EVENT_CONFIRMED += 1;
        if (s.context_alignment === 'CONTRARY') counts.CONTRARY += 1;
        if (s.context_alignment === 'INSUFFICIENT_DATA')
            counts.INSUFFICIENT_DATA += 1;
    }
    return {
        context_coverage_pct:
            coverageN > 0 ? Math.round((coverageSum / coverageN) * 10) / 10 : null,
        context_confidence:
            coverageN === 0
                ? null
                : confHigh / Math.max(1, coverageN) >= 0.5
                  ? 'HIGH'
                  : 'MIXED',
        ...counts,
    };
}

export function collectIntegrityFindings(
    signals: StrategySignal[],
    market: DailyMarketSummary,
    coverage: CoverageSample | null,
): IntegrityFinding[] {
    const findings: IntegrityFinding[] = [];
    for (const s of signals) {
        const observed =
            s.context_snapshot?.captured_at ??
            (s.context_snapshot as { observed_at?: string } | undefined)
                ?.observed_at;
        if (observed && s.signal_time) {
            const o = Date.parse(observed);
            const t = Date.parse(s.signal_time);
            if (Number.isFinite(o) && Number.isFinite(t) && o > t + 1000) {
                findings.push({
                    id: 'FUTURE_LEAK',
                    severity: 'CRITICAL',
                    detail: `${s.signal_id} context.observed/captured_at ${observed} > signal_time ${s.signal_time}`,
                });
            }
        }
        const inst = s.context_snapshot?.institutional_eod_context;
        if (
            inst &&
            (inst as { realtime_level?: string }).realtime_level === 'REALTIME'
        ) {
            findings.push({
                id: 'FOREIGN_AS_REALTIME',
                severity: 'CRITICAL',
                detail: `${s.signal_id} institutional PREVIOUS_DAY labeled REALTIME`,
            });
        }
    }
    if (
        coverage?.uses_active_watch_pool === true &&
        (coverage.broad_universe_size ?? 0) > 0 &&
        (coverage.broad_universe_size ?? 0) <= 100
    ) {
        findings.push({
            id: 'SECTOR_ACTIVE80_DENOM',
            severity: 'CRITICAL',
            detail: `broad_universe_size=${coverage.broad_universe_size} with uses_active_watch_pool=true — active pool must not be whole-market denominator`,
        });
    }
    if ((market.corporate_action_count ?? 0) > 0) {
        findings.push({
            id: 'CA_PRESENT',
            severity: 'INFO',
            detail: `corporate_action_count=${market.corporate_action_count} — verify Adj vs Raw in UI`,
        });
    }
    return findings;
}

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function signalToRow(
    s: StrategySignal,
    outcome: SignalOutcome | null,
    extras?: Partial<SignalSampleRow>,
): SignalSampleRow {
    const fs = s.feature_snapshot ?? {};
    const snap = s.context_snapshot;
    const tags: string[] = [];
    if (s.context_alignment === 'ALIGNED') tags.push('context_aligned');
    if (s.context_alignment === 'CONTRARY') tags.push('context_contrary');
    if (s.score_confidence === 'low') tags.push('low_confidence');
    if (snap && (snap.sector_breadth ?? 1) < 0.15 && snap.sector_rotation_state === 'HOT') {
        tags.push('low_breadth');
    }
    const ca =
        (fs.corporate_action_badge as string | undefined) ??
        (snap ? null : null);
    return {
        timestamp: s.signal_time,
        symbol: s.symbol,
        name: s.name ?? null,
        signal_type: s.signal_type,
        price: s.reference_price,
        change_pct: num(fs.change_pct),
        BP: num(fs.buy_pressure_score) ?? num(fs.bp_score),
        C_score: s.score ?? num(fs.intraday_score),
        rank: num(fs.rank),
        rank_change: num(fs.rank_change),
        VWAP: num(fs.vwap_pos_pct) ?? num(fs.distance_from_vwap_pct),
        RVOL: num(fs.rvol) ?? num(fs.rvol_same_time),
        taiwan_regime: snap?.taiwan_regime ?? s.market_regime ?? null,
        sector: snap?.sector ?? null,
        sector_state: snap?.sector_rotation_state ?? null,
        sector_rank: snap?.sector_rank ?? null,
        capital_rotation: snap?.capital_rotation_score ?? null,
        event_state: snap?.event_confirmation_state ?? null,
        corporate_action: ca,
        context_alignment: s.context_alignment ?? null,
        outcome_5m: outcome?.forward_return_5m ?? null,
        outcome_15m: outcome?.forward_return_15m ?? null,
        outcome_30m: outcome?.forward_return_30m ?? null,
        outcome_60m: outcome?.forward_return_60m ?? null,
        MFE: outcome?.mfe_15m ?? outcome?.mfe_5m ?? null,
        MAE: outcome?.mae_15m ?? outcome?.mae_5m ?? null,
        invalid: outcome?.invalid_hit ?? null,
        sample_tags: tags,
        ...extras,
    };
}

/** Map live BP batch events into sample rows (EARLY / BUY_SURGE / ASK_EATING…). */
export function collectBpEventRows(ctx: AppContext): SignalSampleRow[] {
    const rows: SignalSampleRow[] = [];
    try {
        const batch = ctx.buyPressure?.getLastBatch?.();
        if (!batch?.items?.length) return rows;
        let regime: string | null = null;
        try {
            regime =
                ctx.marketContext?.getOverview()?.taiwan_regime?.state ?? null;
        } catch {
            /* soft */
        }
        for (const item of batch.items) {
            const sectorHint = (() => {
                try {
                    const sectors = ctx.marketContext?.getSectors?.() ?? [];
                    // soft: no per-symbol sector in BP item — leave null
                    void sectors;
                } catch {
                    /* soft */
                }
                return null;
            })();
            void sectorHint;
            const events = item.events ?? [];
            for (const ev of events) {
                const type = String(ev.event_type ?? '');
                if (
                    ![
                        'EARLY_ENTER',
                        'BUY_SURGE',
                        'ASK_EATING',
                        'VOLUME_BREAKOUT',
                        'RANK_ACCELERATION',
                    ].includes(type)
                ) {
                    continue;
                }
                const tags: string[] = [];
                if (item.data_stale) tags.push('stale');
                rows.push({
                    timestamp: ev.timestamp || batch.as_of || new Date().toISOString(),
                    symbol: item.symbol,
                    name: item.name ?? null,
                    signal_type:
                        type === 'VOLUME_BREAKOUT'
                            ? 'BREAKOUT'
                            : type === 'RANK_ACCELERATION'
                              ? 'RANK_JUMP'
                              : type,
                    price: item.last_price,
                    change_pct: item.change_pct,
                    BP: item.buy_pressure_score,
                    C_score: item.c_score,
                    rank: item.rank,
                    rank_change:
                        item.rank != null && item.rank_prev != null
                            ? item.rank_prev - item.rank
                            : null,
                    VWAP: item.distance_from_vwap_pct ?? null,
                    RVOL: item.rvol ?? null,
                    taiwan_regime: regime,
                    sector: null,
                    sector_state: null,
                    sector_rank: null,
                    capital_rotation: null,
                    event_state: null,
                    corporate_action: null,
                    context_alignment: null,
                    outcome_5m: null,
                    outcome_15m: null,
                    outcome_30m: null,
                    outcome_60m: null,
                    MFE: null,
                    MAE: null,
                    invalid: null,
                    sample_tags: tags,
                });
            }
        }
    } catch {
        /* soft */
    }
    return rows;
}

export function collectStrategyRows(
    ctx: AppContext,
    ymd: string,
): SignalSampleRow[] {
    const rp = ctx.researchRepos;
    if (!rp) return [];
    let signals: StrategySignal[] = [];
    try {
        signals = rp.signals.listByDate(ymd);
    } catch {
        return [];
    }
    const rows: SignalSampleRow[] = [];
    for (const s of signals) {
        let outcome: SignalOutcome | null = null;
        try {
            outcome = rp.outcomes.findBySignalId(s.signal_id);
        } catch {
            outcome = null;
        }
        rows.push(signalToRow(s, outcome));
    }
    return rows;
}

export function todayYmd(): string {
    return taipeiHm().ymd;
}
