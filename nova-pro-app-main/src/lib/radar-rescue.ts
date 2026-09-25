// src/lib/radar-rescue.ts — Simple Radar API client (rescue mode)

import { apiGet, apiPost } from './api';

export type RescueRadarState =
    | 'EARLY'
    | 'PRE_ATTACK'
    | 'ACTIVE'
    | 'PULLBACK'
    | 'WATCH'
    | 'INACTIVE'
    | 'INVALID'
    | 'INSUFFICIENT_DATA'
    | 'EARLY_FAILED'
    | 'WEAKENING'
    | 'NEAR_LIMIT'
    | 'LIMIT_UP'
    | 'STALLING'
    | 'FAKE_BREAKOUT'
    | 'DATA_STALE'
    | 'DATA_INCOMPLETE';

export type ChaseRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

export interface RescueCardDto {
    symbol: string;
    name: string;
    last_price: number | null;
    change_pct: number | null;
    radar_state: RescueRadarState;
    opportunity_score: number;
    chase_risk: ChaseRiskLevel;
    trigger_score: number;
    c_score: number | null;
    bp_score: number | null;
    rank: number | null;
    rank_prev: number | null;
    rank_change: number | null;
    bp_trend: number | null;
    news_state: string;
    news_confidence: number | null;
    reasons: string[];
    layers: {
        stock: boolean;
        sector: boolean;
        market: boolean;
        news: boolean;
    };
    early_evidence: string[];
    data_confidence: string;
    focus_score: number;
    lanes: string[];
    late_detection: boolean;
    pre_plus3?: boolean;
    state_label?: string;
    true_ask_eating?: boolean;
    ask_eating_quality?: number;
    push_efficiency?: number;
    attack_score?: number;
    data_stale?: boolean;
    last_valid_state?: RescueRadarState | null;
    suggested_buy_price?: number | null;
    suggested_buy_zone_low?: number | null;
    suggested_buy_zone_high?: number | null;
    suggested_buy_note?: string | null;
}

export interface RescueBatchDto {
    as_of: string;
    version: string;
    mode: string;
    market_status?: string | null;
    data_status: string;
    focus: { early: RescueCardDto[]; confirmed: RescueCardDto[] };
    early: RescueCardDto[];
    active: RescueCardDto[];
    pullback: RescueCardDto[];
    watch: RescueCardDto[];
    insufficient: RescueCardDto[];
    count: {
        early: number;
        active: number;
        pullback: number;
        watch: number;
        insufficient: number;
    };
}

export interface DailyRecallDto {
    trade_date: string;
    plus_3_count: number;
    scanner: string;
    discovery: string;
    active: string;
    c: string;
    early: string;
    active_state: string;
    focus: string;
    ui: string;
    largest_recall_loss_stage: string;
    missed: Array<{
        symbol: string;
        name: string;
        max_return_pct: number;
        first_drop_stage: string;
        first_drop_reason: string;
    }>;
}

export function fetchRadarRescue() {
    return apiGet<RescueBatchDto>('/api/v1/data/radar-rescue', 20_000);
}

export function fetchRadarRescueRecall() {
    return apiGet<DailyRecallDto | { error: string }>(
        '/api/v1/data/radar-rescue/recall',
        15_000,
    );
}

export function runRadarRescueEod() {
    return apiPost<{ ok: boolean; recall: DailyRecallDto }>(
        '/api/v1/data/radar-rescue/eod-truth/run',
        {},
    );
}

export type EarlyReportSource = 'replay' | 'synthetic' | 'live';
export type EarlyReportCoverage = 'full' | 'partial';

export interface EarlyMetricBucketDto {
    success: number;
    fail: number;
    incomplete: number;
    unknown: number;
    denominator: number;
    rate: number | null;
    rate_label: string;
}

export interface EarlySignalReportRowDto {
    signal_id: string;
    symbol: string;
    triggered_at: string;
    trigger_price: number;
    day_reference_price: number | null;
    day_plus_3pct: {
        verdict: string;
        first_hit_after_min: number | null;
    };
    day_plus_5pct: { verdict: string; first_hit_after_min: number | null };
    post_trigger_plus_3pct: {
        verdict: string;
        first_hit_after_min: number | null;
    };
    post_trigger_plus_5pct: {
        verdict: string;
        first_hit_after_min: number | null;
    };
    active_upgrade: {
        verdict: string;
        first_hit_after_min: number | null;
        reached: boolean;
    };
    max_price: number | null;
    tracking_to_close: boolean;
    terminal_state: string;
}

export interface EarlyDailyReportDto {
    trade_date: string;
    source: EarlyReportSource;
    source_label: string;
    run_id: string;
    coverage: EarlyReportCoverage;
    evaluable: boolean;
    observation_cutoff_ms: number;
    observation_cutoff_iso: string;
    until_label: string | null;
    symbols: string[];
    created_at: string;
    signal_count: number;
    unique_symbol_count: number;
    data_completeness_rate: number | null;
    data_completeness_label: string;
    day_plus_3pct: EarlyMetricBucketDto;
    day_plus_5pct: EarlyMetricBucketDto;
    post_trigger_plus_3pct: EarlyMetricBucketDto;
    post_trigger_plus_5pct: EarlyMetricBucketDto;
    active_upgrade: EarlyMetricBucketDto & {
        kind: 'state_upgrade_rate';
        label: string;
    };
    signals: EarlySignalReportRowDto[];
    note: string;
}

export interface EarlyDailyReportListDto {
    date: string;
    sources: EarlyReportSource[];
    reports: EarlyDailyReportDto[];
    partial_reports: EarlyDailyReportDto[];
    live_pipeline: {
        wired: boolean;
        message: string | null;
    };
    note: string;
}

export function fetchEarlyDailyReportList(date?: string) {
    const qs = date ? `?date=${encodeURIComponent(date)}` : '';
    return apiGet<EarlyDailyReportListDto>(
        `/api/v1/data/radar-rescue/early/daily-report${qs}`,
        15_000,
    );
}

export function fetchEarlyDailyReport(
    date: string,
    source: EarlyReportSource,
) {
    const qs = new URLSearchParams({ date, source });
    return apiGet<EarlyDailyReportDto>(
        `/api/v1/data/radar-rescue/early/daily-report?${qs}`,
        15_000,
    );
}

/** Frontend feature flag — default rescue; set VITE_RADAR_MODE=legacy to rollback. */
export function getRadarUiMode(): 'rescue' | 'legacy' {
    const v = (
        (import.meta.env.VITE_RADAR_MODE as string | undefined) ?? 'rescue'
    )
        .trim()
        .toLowerCase();
    return v === 'legacy' ? 'legacy' : 'rescue';
}
