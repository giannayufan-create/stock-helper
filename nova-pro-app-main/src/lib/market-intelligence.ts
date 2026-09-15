// src/lib/market-intelligence.ts — read-only MI client (cached server snapshot)

import { apiGet } from './api';

export interface MiOverview {
    market_intelligence_available: boolean;
    ready?: boolean;
    generated_at?: string;
    version?: string;
    market_context?: {
        risk_environment: string;
        market_regime: string | null;
        market_score: number | null;
        semiconductor_context: string;
        tech_context: string;
        asia_context: string;
        fx_context: string;
        summary: string;
    };
    global_markets?: Array<{
        id: string;
        name: string;
        value: number | null;
        change_pct: number | null;
        status: string;
    }>;
    top_sectors?: Array<{
        rank?: number | null;
        sector: string;
        heat_score: number | null;
        heat_delta_5m: number | null;
        confidence: string;
        strong_count: number;
        heating_count: number;
        leaders: Array<{ symbol: string; name: string }>;
        eligible_for_ranking: boolean;
    }>;
    top_themes?: Array<{
        rank?: number | null;
        theme_id: string;
        theme: string;
        heat_score: number | null;
        heat_delta_5m: number | null;
        confidence: string;
        eligible_for_ranking: boolean;
    }>;
    top_news?: Array<{
        id: string;
        title: string;
        source: string;
        sentiment: string;
    }>;
    ai_summary?: {
        available: boolean;
        market_summary: string | null;
        risk_environment: string | null;
        hot_sectors: Array<{ name: string; reason: string }>;
        hot_themes: Array<{ name: string; reason: string }>;
        error: string | null;
    };
    data_health?: {
        overall: string;
        global_market: { status: string };
        sector: { status: string };
        theme: { status: string };
        news: { status: string };
        ai_summary: { status: string };
    };
    material_info_available?: boolean;
    material_info_coverage?: string;
}

export interface SymbolIntelligenceDto {
    symbol: string;
    name: string | null;
    sector: {
        name: string | null;
        heat: number | null;
        rank: number | null;
        trend: string | null;
        confidence: string | null;
    } | null;
    themes: Array<{
        theme_id: string;
        name: string;
        heat: number | null;
        rank: number | null;
    }>;
    news: Array<{ title: string; sentiment: string; source: string }>;
    company_events: Array<{ title: string; event_type: string }>;
    chips_context: {
        available: boolean;
        summary: string | null;
        freshness: string;
        note: string;
    };
    market_context: { summary: string; risk_environment: string };
    radar_context: {
        c_score: number | null;
        stock_heat: number | null;
        rank: number | null;
        events: string[];
    } | null;
}

export function fetchMiOverview() {
    return apiGet<MiOverview>('/api/v1/market-intelligence/overview');
}

export function fetchMiSymbol(symbol: string) {
    return apiGet<SymbolIntelligenceDto>(
        `/api/v1/market-intelligence/symbol/${encodeURIComponent(symbol)}`,
    );
}

export function fetchMiSectors() {
    return apiGet<{ items: MiOverview['top_sectors'] }>(
        '/api/v1/market-intelligence/sectors',
    );
}

export function fetchMiThemes() {
    return apiGet<{ items: MiOverview['top_themes'] }>(
        '/api/v1/market-intelligence/themes',
    );
}

export function fetchMiNews() {
    return apiGet<{ items: NonNullable<MiOverview['top_news']> }>(
        '/api/v1/market-intelligence/news?limit=30',
    );
}

export function fetchMiGlobal() {
    return apiGet<{
        assets: NonNullable<MiOverview['global_markets']>;
        market_context: MiOverview['market_context'];
    }>('/api/v1/market-intelligence/global');
}

export function deltaLabel(d: number | null | undefined): string {
    if (d == null) return '→';
    if (d >= 5) return `↑ +${Math.round(d)}`;
    if (d <= -5) return `↓ ${Math.round(d)}`;
    return '→';
}
