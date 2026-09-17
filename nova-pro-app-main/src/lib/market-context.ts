// src/lib/market-context.ts — Market Context Phase 1 client

import { apiGet } from './api';

export type TaiwanRegimeState =
    | 'RISK_ON_BROAD'
    | 'RISK_ON_NARROW'
    | 'NEUTRAL'
    | 'RISK_OFF_NARROW'
    | 'RISK_OFF_BROAD'
    | 'UNKNOWN';

export type SectorRotationState =
    | 'ROTATING_IN'
    | 'HOT'
    | 'STABLE'
    | 'ROTATING_OUT'
    | 'COLD'
    | 'INSUFFICIENT_COVERAGE';

export interface ContextMetaDto {
    source: string;
    freshness: string;
    realtime_level: string;
    coverage_pct: number | null;
    confidence: string;
    available: boolean;
    age_ms: number | null;
}

export interface MarketContextOverviewDto {
    as_of: string;
    version: string;
    global_regime: {
        state: string;
        summary: string | null;
        meta: ContextMetaDto;
    };
    taiwan_regime: {
        state: TaiwanRegimeState;
        taiex_change_pct: number | null;
        tpex_change_pct: number | null;
        taiex_direction: string;
        tpex_direction: string;
        market_breadth_advance_pct: number | null;
        turnover_acceleration: string;
        score: number | null;
        reasons: string[];
        meta: ContextMetaDto;
    };
    breadth: {
        advancers: number;
        decliners: number;
        unchanged: number;
        advance_pct: number | null;
        coverage_pct: number;
        confidence: string;
        universe_size: number;
        uses_active_watch_pool: false;
        meta: ContextMetaDto;
    };
    broad_universe: {
        broad_universe_size: number;
        coverage_pct: number;
        source: string;
        update_frequency: string;
        realtime_level: string;
    };
    top_rotating: Array<{
        sector: string;
        sector_rank: number | null;
        sector_rank_prev: number | null;
        sector_rank_change: number | null;
        turnover_share: number;
        turnover_share_prev: number | null;
        turnover_share_delta: number | null;
        breadth: number | null;
        capital_rotation_score: number | null;
        attention_flow_score: number | null;
        high_concentration: boolean;
        state: SectorRotationState;
        tags: string[];
        leaders?: Array<{
            symbol: string;
            name: string;
            turnover: number;
            change_pct: number;
        }>;
        meta: ContextMetaDto;
    }>;
    institutional_eod: {
        label: 'INSTITUTIONAL_EOD';
        realtime_level: 'PREVIOUS_DAY';
        note: string;
    };
    gap_layers?: {
        asia_regime?: { data?: { state?: string; vs_taiwan?: string }; available?: boolean };
        index_concentration?: { data?: { state?: string }; proxy?: boolean; available?: boolean };
        futures_lead?: { data?: { state?: string }; available?: boolean };
        crowding?: { data?: { state?: string }; available?: boolean };
        macro_event_calendar?: {
            data?: { nearest?: { event_type?: string; phase?: string } | null };
            available?: boolean;
        };
        passive_flow_calendar?: { data?: { passive_flow_event?: boolean } };
        preopen_auction?: { data?: { state?: string; window?: string }; available?: boolean };
        derivatives_positioning?: { available?: boolean; data?: { state?: string } };
        overseas_company?: { data?: { mapped_count?: number }; available?: boolean };
        industry_drivers?: {
            data?: { drivers?: Array<{ driver: string; available: boolean }> };
        };
    } | null;
    warnings: string[];
}

export function fetchMarketContextOverview() {
    return apiGet<MarketContextOverviewDto>(
        '/api/v1/market-context/overview',
        8000,
    );
}

export function fetchMarketContextSectors() {
    return apiGet<{
        items: MarketContextOverviewDto['top_rotating'];
        count: number;
    }>('/api/v1/market-context/sectors');
}

export function fetchMarketContextGapLayers() {
    return apiGet<Record<string, unknown>>('/api/v1/market-context/gap-layers');
}

export const TW_REGIME_LABEL: Record<TaiwanRegimeState, string> = {
    RISK_ON_BROAD: '偏多（廣）',
    RISK_ON_NARROW: '偏多（窄）',
    NEUTRAL: '中性',
    RISK_OFF_NARROW: '偏空（窄）',
    RISK_OFF_BROAD: '偏空（廣）',
    UNKNOWN: '未知',
};

export const ROTATION_LABEL: Record<SectorRotationState, string> = {
    ROTATING_IN: '輪動進入',
    HOT: '熱區',
    STABLE: '穩',
    ROTATING_OUT: '輪動離開',
    COLD: '冷',
    INSUFFICIENT_COVERAGE: '覆蓋不足',
};
