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
    chips?: {
        available: boolean;
        bias: string;
        label: string;
        summary: string;
        score_adj: number;
        as_of?: string;
        foreign_net: number;
        trust_net: number;
        dealer_net: number;
        inst_net: number;
        margin_delta: number;
        short_delta: number;
        notes: string[];
    };
    overnight?: {
        code: string;
        samples: number;
        win_rate: number;
        avg_gap_pct: number;
        expectancy_pct: number;
        max_drawdown_pct: number;
        last_signal: boolean;
        label: string;
        summary: string;
        note: string;
        score_adj: number;
        strength_boost: number;
    } | null;
    us_market?: {
        summary: string;
        score_adj: number;
        quotes: Array<{
            symbol: string;
            label: string;
            change_rate: number;
        }>;
    };
    market_regime?: {
        bias: string;
        label: string;
        summary: string;
        score_adj: number;
        tw_change_rate: number | null;
        us_summary: string;
        drivers: string[];
        note: string;
    } | null;
    inst_intent?: {
        intent: string;
        playbook: string;
        label: string;
        summary: string;
        score_adj: number;
        conf: string;
        drivers: string[];
        day_change_pct: number;
        as_of?: string;
        available: boolean;
        note: string;
    };
    verdict?: {
        state: '可做' | '可觀察' | '勿追';
        headline: string;
        session: string;
        session_note: string;
        traps: string[];
        align?: string;
        risk: {
            stopPct: number;
            takePct: number;
            rr: number;
            sizeHint: string;
            riskNote: string;
        };
        micro_backtest: {
            samples: number;
            winRate: number;
            avgRr: number;
            maxDrawdownPct: number;
            note: string;
        };
        fail_exit: {
            action: '賣出了結' | '可轉隔夜' | '減碼再看';
            reason: string;
        };
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
    screenerStrength?: number | null;
    screenerMode?: 'intraday' | 'overnight' | null;
    screenerOvernightWinRate?: number | null;
    regulatory?: 'punish' | 'attention' | null;
}) {
    return apiPost<AiAnalyzeResult>(
        '/api/v1/ai/analyze',
        {
            code: input.code,
            name: input.name,
            bars: input.bars,
            stop_pct: 0.01,
            take_pct: 0.02,
            with_coach: input.withCoach !== false,
            screener_strength: input.screenerStrength ?? undefined,
            screener_mode: input.screenerMode ?? undefined,
            screener_overnight_winrate: input.screenerOvernightWinRate ?? undefined,
            regulatory: input.regulatory ?? undefined,
        },
        45_000,
    );
}
