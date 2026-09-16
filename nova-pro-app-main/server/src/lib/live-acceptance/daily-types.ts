// Daily Live Acceptance Report v1 — observe / report only; NEVER mutates strategy.

import type { LiveStatus } from './types.ts';

export const DAILY_LA_VERSION = 'daily_live_acceptance_v1';

export type QualityVerdict = 'PASS' | 'WARNING' | 'FAIL' | 'PARTIAL';

export type SignalSampleType =
    | 'OPEN_PASS'
    | 'STRONG_ENTER'
    | 'EARLY_ENTER'
    | 'BUY_SURGE'
    | 'SURGE'
    | 'BREAKOUT'
    | 'REBREAK'
    | 'RANK_JUMP'
    | 'PULLBACK_READY'
    | 'ASK_EATING';

export interface SignalTypeCounts {
    OPEN_PASS: number;
    STRONG_ENTER: number;
    EARLY_ENTER: number;
    BUY_SURGE: number;
    SURGE: number;
    BREAKOUT: number;
    REBREAK: number;
    RANK_JUMP: number;
    PULLBACK_READY: number;
    ASK_EATING: number;
}

export function emptySignalTypeCounts(): SignalTypeCounts {
    return {
        OPEN_PASS: 0,
        STRONG_ENTER: 0,
        EARLY_ENTER: 0,
        BUY_SURGE: 0,
        SURGE: 0,
        BREAKOUT: 0,
        REBREAK: 0,
        RANK_JUMP: 0,
        PULLBACK_READY: 0,
        ASK_EATING: 0,
    };
}

export interface DailySystemSummary {
    server_started_at: string | null;
    uptime_sec: number | null;
    shioaji_or_market_provider: string | null;
    market_runtime_ok: boolean | null;
    data_health_note: string | null;
    sse_clients: number | null;
    cpu_pct_peak: number | null;
    rss_mb_peak: number | null;
    heap_mb_last: number | null;
    event_loop_lag_p95_ms: number | null;
    C_eval_latency: { avg_ms: number | null; p95_ms: number | null };
    BP_eval_latency: { avg_ms: number | null; p95_ms: number | null };
    Context_eval_latency: { avg_ms: number | null; p95_ms: number | null };
    firestore_queue_depth_last: number | null;
    firestore_queue_max: number | null;
    firestore_write_latency_avg_ms: number | null;
    firestore_write_failures: number | null;
}

export interface DailyMarketSummary {
    broad_universe_size: number | null;
    market_coverage_pct: number | null;
    sector_coverage_pct: number | null;
    advancers: number | null;
    decliners: number | null;
    unchanged: number | null;
    taiwan_regime: string | null;
    sector_rotation_states: Record<string, number>;
    corporate_action_count: number | null;
    expiry_context: string | null;
}

export interface DailyNotificationSummary {
    notification_count: number;
    duplicate_count: number;
    cooldown_suppressed_count: number;
    HIGH: number;
    MEDIUM: number;
    INFO: number;
}

export interface DailyFirestoreSummary {
    strategy_signal_count: number;
    context_snapshot_count: number;
    outcome_count: number;
    missing_count: number;
    duplicate_count: number;
    conflict_count: number;
    queue_max: number | null;
    write_failure_count: number | null;
    effective_mode: string | null;
}

export interface DailyContextSummary {
    context_coverage_pct: number | null;
    context_confidence: string | null;
    MARKET_ALIGNED: number;
    SECTOR_ROTATING_IN: number;
    EVENT_CONFIRMED: number;
    CONTRARY: number;
    INSUFFICIENT_DATA: number;
}

export interface SignalSampleRow {
    timestamp: string;
    symbol: string;
    name: string | null;
    signal_type: string;
    price: number | null;
    change_pct: number | null;
    BP: number | null;
    C_score: number | null;
    rank: number | null;
    rank_change: number | null;
    VWAP: number | null;
    RVOL: number | null;
    taiwan_regime: string | null;
    sector: string | null;
    sector_state: string | null;
    sector_rank: number | null;
    capital_rotation: number | null;
    event_state: string | null;
    corporate_action: string | null;
    context_alignment: string | null;
    outcome_5m: number | null;
    outcome_15m: number | null;
    outcome_30m: number | null;
    outcome_60m: number | null;
    MFE: number | null;
    MAE: number | null;
    invalid: boolean | null;
    sample_tags: string[];
}

export type AnomalyKind =
    | 'A_REVERSE_15M'
    | 'B_BP_HIGH_SECTOR_OUT'
    | 'C_EARLY_FAST_INVALID'
    | 'D_HOT_LOW_BREADTH'
    | 'E_CORPORATE_ACTION'
    | 'F_STALE_LOW_CONF'
    | 'G_NOTIFY_ANOMALY';

export interface AnomalySample {
    kind: AnomalyKind;
    reason: string;
    row: SignalSampleRow;
}

export interface IntegrityFinding {
    id: string;
    severity: 'CRITICAL' | 'WARNING' | 'INFO';
    detail: string;
}

export interface QualityDimension {
    id: string;
    label: string;
    status: QualityVerdict;
    detail: string;
}

export interface DailyLiveAcceptanceReport {
    version: string;
    generated_at: string;
    trading_day: string;
    mutates_strategy: false;
    creates_upstream_subscription: false;
    overall: 'PASS' | 'WARNING' | 'FAIL';
    system: DailySystemSummary;
    market: DailyMarketSummary;
    signals: SignalTypeCounts;
    notifications: DailyNotificationSummary;
    firestore: DailyFirestoreSummary;
    context: DailyContextSummary;
    signal_samples: SignalSampleRow[];
    anomalies: AnomalySample[];
    integrity: IntegrityFinding[];
    quality: QualityDimension[];
    paths: {
        md: string;
        json: string;
        csv: string;
    };
    live_gates?: Array<{ id: string; status: LiveStatus; detail: string }>;
    commit_hash: string | null;
}
