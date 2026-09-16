// src/lib/events.ts — Event Intelligence Phase 2 client (context only)

import { apiGet } from './api';

export type EventType =
    | 'GEOPOLITICAL'
    | 'WAR_CONFLICT'
    | 'SANCTION'
    | 'EPIDEMIC'
    | 'EARTHQUAKE'
    | 'NATURAL_DISASTER'
    | 'SHIPPING_DISRUPTION'
    | 'SUPPLY_CHAIN'
    | 'COMMODITY'
    | 'ENERGY'
    | 'SEMICONDUCTOR'
    | 'EXPORT_CONTROL'
    | 'REGULATION'
    | 'COMPANY_MATERIAL_INFO'
    | 'EARNINGS'
    | 'CAPEX'
    | 'ORDER_WIN'
    | 'PRODUCT_EVENT'
    | 'OTHER';

export type ConfirmationStatus =
    | 'EVENT_UNCONFIRMED'
    | 'EVENT_WATCH'
    | 'EVENT_PARTIAL_CONFIRMED'
    | 'EVENT_MARKET_CONFIRMED'
    | 'EVENT_REJECTED'
    | 'EVENT_STALE';

export interface MarketEventDto {
    event_id: string;
    cluster_id: string;
    event_type: EventType;
    title: string;
    summary: string | null;
    source: string;
    source_type: string;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    freshness: 'FRESH' | 'RECENT' | 'STALE' | 'ARCHIVED';
    severity: number;
    sources_count: number;
    source_list: string[];
    event_relevance: number;
    taiwan_relevance: number;
    priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    notification_candidate: boolean;
    published_at: string | null;
    latest_update_at: string;
    status: string;
}

export interface SectorHypothesisDto {
    sector_or_theme: string;
    direction: 'POSITIVE' | 'NEGATIVE' | 'MIXED' | 'UNKNOWN';
    relevance: number;
    rationale: string;
    channels: string[];
}

export interface EventImpactDto {
    event_id: string;
    sector_hypotheses: SectorHypothesisDto[];
    overall_direction: string;
    note: string;
}

export interface EventConfirmationDto {
    event_id: string;
    status: ConfirmationStatus;
    market_confirmation_score: number;
    event_relevance: number;
    sector_focus: string | null;
    sector_rank: number | null;
    sector_rank_prev: number | null;
    turnover_share: number | null;
    turnover_share_prev: number | null;
    breadth: number | null;
    c_strong_count: number;
    bp_strong_count: number;
    reasons: string[];
}

export interface EventSummaryDto {
    active_count: number;
    confirmed_count: number;
    watch_count: number;
    top_events: MarketEventDto[];
    creates_upstream_subscription: false;
    mutates_strategy: false;
}

export interface CompanyExposureDto {
    symbol: string;
    company_name: string;
    industry: string | null;
    products: string[];
    exposures: Array<{
        event_type: string;
        channel: string;
        direction: string;
        confidence: string;
        evidence_type: string;
        evidence_source: string;
    }>;
    revenue_exposure_available: false;
    overall_confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    note?: string;
}

export function fetchEventSummary() {
    return apiGet<EventSummaryDto>('/api/v1/market-context/event-summary');
}

export function fetchActiveEvents() {
    return apiGet<{ items: MarketEventDto[]; count: number }>(
        '/api/v1/events/active',
    );
}

export function fetchEventDetail(eventId: string) {
    return apiGet<{
        event: MarketEventDto;
        confirmation: EventConfirmationDto | null;
        impact: EventImpactDto | null;
    }>(`/api/v1/events/${encodeURIComponent(eventId)}`);
}

export function fetchCompanyExposures(symbol: string, eventType?: string) {
    const q = eventType
        ? `?event_type=${encodeURIComponent(eventType)}`
        : '';
    return apiGet<CompanyExposureDto>(
        `/api/v1/companies/${encodeURIComponent(symbol)}/exposures${q}`,
    );
}

export const EVENT_TYPE_LABEL: Record<string, string> = {
    GEOPOLITICAL: '🌍 地緣政治',
    WAR_CONFLICT: '🌍 地緣／衝突',
    SANCTION: '制裁',
    EPIDEMIC: '🦠 疫情',
    EARTHQUAKE: '地震',
    NATURAL_DISASTER: '天災',
    SHIPPING_DISRUPTION: '🚢 航運中斷',
    SUPPLY_CHAIN: '供應鏈',
    COMMODITY: '商品',
    ENERGY: '🛢 能源',
    SEMICONDUCTOR: '半導體',
    EXPORT_CONTROL: '出口管制',
    OTHER: '其他',
};

export const CONFIRM_LABEL: Record<ConfirmationStatus, string> = {
    EVENT_MARKET_CONFIRMED: '✅ 市場已確認反應',
    EVENT_PARTIAL_CONFIRMED: '部分確認',
    EVENT_WATCH: '觀察中',
    EVENT_UNCONFIRMED: '尚未確認',
    EVENT_REJECTED: '市場未反應／拒絕',
    EVENT_STALE: '已過時',
};
