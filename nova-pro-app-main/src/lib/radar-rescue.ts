// src/lib/radar-rescue.ts — Simple Radar API client (rescue mode)

import { apiGet, apiPost } from './api';

export type RescueRadarState =
    | 'EARLY'
    | 'ACTIVE'
    | 'PULLBACK'
    | 'WATCH'
    | 'INACTIVE'
    | 'INVALID'
    | 'INSUFFICIENT_DATA';

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

/** Frontend feature flag — default rescue; set VITE_RADAR_MODE=legacy to rollback. */
export function getRadarUiMode(): 'rescue' | 'legacy' {
    const v = (
        (import.meta.env.VITE_RADAR_MODE as string | undefined) ?? 'rescue'
    )
        .trim()
        .toLowerCase();
    return v === 'legacy' ? 'legacy' : 'rescue';
}
