import { apiGet, apiPost } from './api';
import { getApiBase } from './runtime';

export type LiveAcceptanceOverall =
    | 'PASS'
    | 'WARNING'
    | 'FAIL'
    | 'PENDING';

export interface LiveAcceptanceTodayDto {
    trading_day: string;
    overall: LiveAcceptanceOverall;
    market_coverage_pct: number | null;
    runtime: { rss_mb_peak: number; cpu_pct_peak: number };
    firestore: {
        strategy_signal_count: number;
        outcome_count: number;
        write_failure_count: number | null;
        effective_mode: string | null;
    } | null;
    signals: Record<string, number> | null;
    notifications: {
        notification_count: number;
        duplicate_count: number;
        cooldown_suppressed_count: number;
        HIGH: number;
        MEDIUM: number;
        INFO: number;
    };
    anomalies_count: number;
    anomaly_kinds: string[];
    generated_at: string | null;
    finalized: boolean;
    mutates_strategy: false;
}

export interface LiveAcceptanceFinalizeDto {
    ok: boolean;
    overall: 'PASS' | 'WARNING' | 'FAIL';
    trading_day: string;
    generated_at: string;
    paths: { md: string; json: string; csv: string };
    quality: Array<{ id: string; label: string; status: string; detail: string }>;
    anomalies_count: number;
    mutates_strategy: false;
}

export function fetchLiveAcceptanceToday() {
    return apiGet<LiveAcceptanceTodayDto>(
        '/api/v1/system/live-acceptance/today',
    );
}

export function finalizeLiveAcceptance() {
    return apiPost<LiveAcceptanceFinalizeDto>(
        '/api/v1/system/live-acceptance/finalize',
        {},
    );
}

export function liveAcceptanceZipUrl(): string {
    return `${getApiBase()}/api/v1/system/live-acceptance/download/zip`;
}
