// src/lib/radar-quality.ts — Radar Quality Upgrade v1 client

import { apiGet } from './api';

export type RadarMomentumState =
    | 'ACTIVE'
    | 'PULLBACK'
    | 'WATCH'
    | 'INACTIVE'
    | 'INVALID';

export type InstitutionalContinuation =
    | 'WAITING_CONFIRMATION'
    | 'CONFIRMED_CONTINUATION'
    | 'PARTIAL_CONTINUATION'
    | 'DIVERGENCE'
    | 'REJECTED'
    | 'INSUFFICIENT_DATA';

export interface InstitutionalSnapshotDto {
    foreign_net_buy_shares: number | null;
    investment_trust_net_buy: number | null;
    dealer_net_buy: number | null;
    foreign_net_buy_1d: number | null;
    foreign_net_buy_3d: number | null;
    foreign_net_buy_5d: number | null;
    institutional_net_buy_3d: number | null;
    foreign_buy_streak_days: number | null;
    foreign_net_buy_rank: number | null;
    source_trade_date: string | null;
    freshness: 'PREVIOUS_DAY';
    background: string;
    continuation: InstitutionalContinuation;
    note: string;
}

export interface RadarQualityItemDto {
    symbol: string;
    name: string;
    eligibility: string;
    momentum_state: RadarMomentumState;
    momentum_reason: string;
    active_confirmations: string[];
    missing_confirmations: string[];
    focus_score: number;
    focus_rank: number | null;
    is_focus: boolean;
    focus_reasons: string[];
    raw_rank: number | null;
    raw_rank_change: number | null;
    institutional: InstitutionalSnapshotDto;
    decision_status: string | null;
    data_confidence: string;
    updated_at: string;
    mutates_strategy: false;
}

export interface FocusSlotDto {
    focus_rank: 1 | 2 | 3;
    symbol: string;
    name: string;
    momentum_state: RadarMomentumState;
    focus_score: number;
    raw_rank: number | null;
    reasons: string[];
    held_since: string;
}

export interface RadarQualityBatchDto {
    as_of: string;
    version: string;
    count: number;
    items: RadarQualityItemDto[];
    focus_top3: FocusSlotDto[];
    counts: {
        eligible: number;
        active: number;
        pullback: number;
        watch: number;
        inactive: number;
        invalid: number;
    };
    evaluate_interval_sec: number;
    mutates_strategy: false;
    note: string;
    intraday_foreign_identity: 'NOT_AVAILABLE';
}

export function fetchRadarQuality(opts?: {
    limit?: number;
    momentum?: string;
}) {
    const q = new URLSearchParams();
    q.set('limit', String(opts?.limit ?? 80));
    if (opts?.momentum) q.set('momentum', opts.momentum);
    return apiGet<RadarQualityBatchDto>(
        `/api/v1/data/radar-quality?${q.toString()}`,
    );
}

export function momentumLabel(state: string | null | undefined): string {
    switch ((state ?? '').toUpperCase()) {
        case 'ACTIVE':
            return '正在發動';
        case 'PULLBACK':
            return '回踩觀察';
        case 'WATCH':
            return '等待確認';
        case 'INACTIVE':
            return '動能不足';
        case 'INVALID':
            return '失效';
        default:
            return state || '—';
    }
}

export function continuationShort(c: string | null | undefined): string {
    switch ((c ?? '').toUpperCase()) {
        case 'CONFIRMED_CONTINUATION':
            return '今日續強確認';
        case 'PARTIAL_CONTINUATION':
            return '部分確認';
        case 'DIVERGENCE':
            return '法人背離';
        case 'REJECTED':
            return '續強未確認';
        case 'WAITING_CONFIRMATION':
            return '等待確認';
        default:
            return '法人資料不足';
    }
}
