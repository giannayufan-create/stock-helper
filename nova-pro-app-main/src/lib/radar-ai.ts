// Client for POST /api/v1/ai/analyze-symbol — radar Detail only.

import { apiPost } from './api';

export type RadarAiVerdict =
    | '偏強'
    | '可關注'
    | '等待確認'
    | '偏熱勿追'
    | '轉弱'
    | '資料不足';

export interface SymbolAnalyzePayload {
    symbol: string;
    name?: string;
    a_score?: number | null;
    b_open_score?: number | null;
    b_status?: string | null;
    open_score?: number | null;
    c_score?: number | null;
    heat?: number | null;
    rank?: number | null;
    rank_velocity?: number | null;
    rvol?: number | null;
    vwap_pos_pct?: number | null;
    momentum?: number | null;
    relative_strength?: number | null;
    breakout_type?: string | null;
    pullback_state?: string | null;
    chase_risk?: string | null;
    invalid_reference?: number | null;
    market_regime?: string | null;
    recent_events?: string[];
    reasons?: string[];
    risks?: string[];
    data_health?: string | null;
    score_coverage_pct?: number | null;
    feature_hash?: string;
}

export interface SymbolAnalyzeResult {
    verdict: RadarAiVerdict;
    confidence: number;
    summary: string;
    reasons: string[];
    risks: string[];
    watch_for: string[];
    analyzed_at: string;
    cached?: boolean;
    feature_hash?: string;
    error?: string;
    message?: string;
}

export function analyzeSymbolWithServer(payload: SymbolAnalyzePayload) {
    return apiPost<SymbolAnalyzeResult>(
        '/api/v1/ai/analyze-symbol',
        payload,
    );
}
