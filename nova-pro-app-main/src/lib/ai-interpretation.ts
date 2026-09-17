// Client for AI Interpretation System v1 — Decision Support only.

import { apiGet, apiPost } from './api';
import type { DecisionStatus } from './decision-summary';

export type InterpretationConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface StockAIInterpretationDto {
    symbol: string;
    name: string;
    score: number;
    score_band: string;
    status: DecisionStatus;
    confidence: InterpretationConfidence;
    headline: string;
    positive_factors: string[];
    limiting_factors: string[];
    missing_confirmations: string[];
    risk_flags: string[];
    data_quality_summary: string;
    snapshot_id: string;
    snapshot_at: string;
    generated_at: string;
    cash_session_closed?: boolean;
    last_updated_at?: string | null;
    narrative?: string | null;
    llm_available?: boolean;
    llm_error?: string | null;
    narrative_source?: 'gemini' | 'rules';
    narrative_generated_at?: string;
    note?: string;
    mutates_strategy?: false;
    research_persistence?: 'NOT_ENABLED';
}

export interface RadarAIInterpretationDto {
    snapshot_id: string;
    score: number;
    score_band: string;
    confidence: InterpretationConfidence;
    matched_count: number;
    filter_summary: string;
    headline: string;
    market_summary: string;
    sector_summary: string;
    group_structure: string;
    common_strengths: string[];
    missing_confirmations: string[];
    divergence_flags: string[];
    risk_flags: string[];
    notable_groups: string[];
    data_quality_summary: string;
    aggregate?: {
        status_distribution: Record<string, number>;
    };
    snapshot_at: string;
    generated_at: string;
    narrative?: string | null;
    llm_available?: boolean;
    llm_error?: string | null;
    narrative_source?: 'gemini' | 'rules';
    narrative_generated_at?: string;
    note?: string;
}

export async function fetchStockInterpretationScore(
    symbol: string,
): Promise<StockAIInterpretationDto | null> {
    try {
        return await apiGet<StockAIInterpretationDto>(
            `/api/v1/interpretation/stock/${encodeURIComponent(symbol)}`,
        );
    } catch {
        return null;
    }
}

export async function requestStockInterpretation(opts: {
    symbol: string;
    snapshot_id?: string;
    with_llm?: boolean;
}): Promise<StockAIInterpretationDto | null> {
    try {
        return await apiPost<StockAIInterpretationDto>(
            '/api/v1/ai/stock-interpretation',
            opts,
        );
    } catch {
        return null;
    }
}

export async function fetchRadarInterpretationScore(body: {
    filter?: Record<string, unknown>;
    symbols?: string[];
    snapshot_id?: string;
}): Promise<RadarAIInterpretationDto | null> {
    try {
        return await apiPost<RadarAIInterpretationDto>(
            '/api/v1/interpretation/radar',
            body,
        );
    } catch {
        return null;
    }
}

export async function requestRadarInterpretation(body: {
    filter?: Record<string, unknown>;
    symbols?: string[];
    snapshot_id?: string;
    with_llm?: boolean;
}): Promise<RadarAIInterpretationDto | null> {
    try {
        return await apiPost<RadarAIInterpretationDto>(
            '/api/v1/ai/radar-interpretation',
            body,
        );
    } catch {
        return null;
    }
}
