// src/lib/buy-pressure.ts — read-only Buy Pressure Radar client

import { apiGet } from './api';

export type BuyPressureState =
    | 'EARLY'
    | 'BUY_SURGE'
    | 'ASK_EATING'
    | 'VOLUME_BREAKOUT'
    | 'LARGE_BID'
    | 'OVERHEATED'
    | 'COOLING';

export interface BuyPressureItemDto {
    symbol: string;
    name: string;
    last_price: number | null;
    change_pct: number | null;
    buy_pressure_score: number;
    radar_rank_score: number;
    primary_state: BuyPressureState;
    states: BuyPressureState[];
    c_score: number | null;
    heat_score: number | null;
    rank: number | null;
    rank_prev: number | null;
    rank_velocity: number | null;
    volume_acceleration: number | null;
    rvol: number | null;
    trade_aggression: number | null;
    bidask_imbalance: number | null;
    momentum_acceleration: number | null;
    vwap_bucket: string | null;
    distance_from_vwap_pct: number | null;
    chase_penalty: number;
    overheated: boolean;
    ask_eating_note: string | null;
    large_bid_note: string | null;
    data_stale: boolean;
    data_health: string;
    updated_at: string;
    last_updated: string;
    events: Array<{
        event_type: string;
        timestamp: string;
        note: string | null;
        notification_candidate: boolean;
    }>;
    score_coverage_pct: number;
}

export interface BuyPressureBatchDto {
    as_of: string;
    version: string;
    count: number;
    items: BuyPressureItemDto[];
    evaluate_interval_sec: number;
    default_price_filter: 'ALL';
    warnings: string[];
    data_stale_global: boolean;
}

export interface BuyPressureQuery {
    min_price?: number;
    max_price?: number;
    min_score?: number;
    state?: BuyPressureState | 'ALL';
    market?: 'ALL' | 'TSE' | 'OTC' | 'ESM';
    overheated?: boolean;
    limit?: number;
}

export function fetchBuyPressure(query: BuyPressureQuery = {}) {
    const qs = new URLSearchParams();
    if (query.min_price != null) qs.set('min_price', String(query.min_price));
    if (query.max_price != null) qs.set('max_price', String(query.max_price));
    if (query.min_score != null) qs.set('min_score', String(query.min_score));
    if (query.state && query.state !== 'ALL') qs.set('state', query.state);
    if (query.market && query.market !== 'ALL') qs.set('market', query.market);
    if (query.overheated != null) qs.set('overheated', String(query.overheated));
    if (query.limit != null) qs.set('limit', String(query.limit));
    const suffix = qs.toString() ? `?${qs}` : '';
    return apiGet<BuyPressureBatchDto>(`/api/v1/data/buy-pressure${suffix}`);
}

export function fetchBuyPressureSymbol(symbol: string) {
    return apiGet<BuyPressureItemDto>(
        `/api/v1/data/buy-pressure/${encodeURIComponent(symbol)}`,
    );
}
