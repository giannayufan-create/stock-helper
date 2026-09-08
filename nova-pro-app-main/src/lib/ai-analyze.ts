// src/lib/ai-analyze.ts — call server AI analyze (Python → local+Gemini fallback)

import { apiGet, apiPost } from './api';

export interface AiBarPayload {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface AiAnalyzeResult {
    score: number;
    stance: '看漲' | '看跌' | '盤整';
    reasons: string[];
    entry?: number;
    stop?: number;
    take?: number;
    rr?: number;
    /** 上漲機率 0～100 */
    up_prob?: number;
    source?: string;
    coach?: string;
    at?: string;
    context_adj?: number;
    news?: {
        bias: string;
        summary: string;
        score_adj: number;
        headlines: Array<{
            title: string;
            source: string;
            sentiment: string;
        }>;
    };
    heat?: {
        session: string;
        label: string;
        score: number;
        score_adj: number;
        buy_vol_ratio: number;
        notes: string[];
    };
}

export interface AiStatus {
    python: boolean;
    analyzer_url: string | null;
    gemini: boolean;
}

export function fetchAiStatus() {
    return apiGet<AiStatus>('/api/v1/ai/status');
}

export function analyzeWithServer(input: {
    code: string;
    name?: string;
    bars: AiBarPayload[];
    withCoach?: boolean;
}) {
    return apiPost<AiAnalyzeResult>('/api/v1/ai/analyze', {
        code: input.code,
        name: input.name,
        bars: input.bars,
        stop_pct: 0.01,
        take_pct: 0.02,
        with_coach: input.withCoach !== false,
    });
}
