// Full Live Acceptance & Data Quality v1 — observe only; NEVER mutates strategy.

export const LA_VERSION = 'live_acceptance_v1';

export type LiveStatus = 'PASS' | 'PARTIAL' | 'WARNING' | 'FAIL' | 'NOT_RUN';

export type SessionWindow =
    | '08:30-09:00'
    | '09:00-09:10'
    | '09:10-09:30'
    | '09:30-11:30'
    | '13:00-13:30'
    | 'OTHER';

export interface ReadinessTimeline {
    server_started_at: string | null;
    firebase_ready_at: string | null;
    shioaji_connected_at: string | null;
    contracts_ready_at: string | null;
    market_runtime_ready_at: string | null;
    index_ready_at: string | null;
    broad_market_ready_at: string | null;
    corporate_action_ready_at: string | null;
    context_ready_at: string | null;
    C_ready_at: string | null;
    BP_ready_at: string | null;
    DATA_HEALTHY_at: string | null;
    time_to_data_healthy_ms: number | null;
    time_to_radar_ready_ms: number | null;
}

export interface EvalLatencyStats {
    count: number;
    avg_ms: number | null;
    p95_ms: number | null;
    max_ms: number | null;
}

export interface RuntimeSample {
    at: string;
    session_window: SessionWindow;
    rss_mb: number;
    heap_mb: number;
    /** process.cpuUsage delta / elapsed — approximate % of one core */
    cpu_pct_approx: number | null;
    event_loop_lag_ms: number | null;
    active_symbols: number | null;
    subscriptions: number | null;
    C_eval: EvalLatencyStats;
    BP_eval: EvalLatencyStats;
    Context_eval: EvalLatencyStats;
    firestore_queue_depth: number | null;
    firestore_write_latency_avg_ms: number | null;
    firestore_write_failures: number | null;
}

export interface CoverageSample {
    at: string;
    broad_universe_size: number | null;
    market_coverage_pct: number | null;
    advancers: number | null;
    decliners: number | null;
    unchanged: number | null;
    sector_coverage_pct: number | null;
    uses_active_watch_pool: boolean | null;
    bp_active_count: number | null;
}

export interface LiveGateResult {
    id: string;
    status: LiveStatus;
    detail: string;
    mode: 'offline' | 'live' | 'instrumentation';
}

export interface LiveAcceptanceReport {
    version: string;
    generated_at: string;
    trading_day: string | null;
    instrumentation_ready: boolean;
    full_trading_day_recorded: boolean;
    readiness: ReadinessTimeline;
    gates: LiveGateResult[];
    summary: {
        verdict: 'PASS' | 'WARNING' | 'FAIL';
        top_risks: string[];
        future_leak: 'YES' | 'NO' | 'UNKNOWN';
        corporate_action_misread: 'YES' | 'NO' | 'UNKNOWN';
        sector_selection_bias: 'YES' | 'NO' | 'UNKNOWN';
        notification_duplicate: 'YES' | 'NO' | 'UNKNOWN';
        stale_as_realtime: 'YES' | 'NO' | 'UNKNOWN';
        peak_memory_mb: number | null;
        peak_cpu_pct: number | null;
        event_loop_p95_ms: number | null;
        C_p95_ms: number | null;
        BP_p95_ms: number | null;
        Context_p95_ms: number | null;
        firestore_queue_max: number | null;
        firestore_write_failure: number | null;
        market_coverage_pct: number | null;
        sector_coverage_pct: number | null;
        restart_recovery_seconds: number | null;
        abc_changed: 'NO';
        bp_changed: 'NO';
        production_threshold_changed: 'NO';
        commit_hash: string | null;
    };
    samples: {
        runtime_count: number;
        coverage_count: number;
        last_coverage: CoverageSample | null;
        last_runtime: RuntimeSample | null;
    };
    creates_upstream_subscription: false;
    mutates_strategy: false;
}
