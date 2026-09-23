// src/lib/today.ts — Today Decision Board client (merged single answer)

import { apiGet } from './api';

export type TodayAction = 'ACTIONABLE' | 'WATCH' | 'WAIT' | 'AVOID';

export type TodayMode =
    | 'PREOPEN'
    | 'OPENING'
    | 'INTRADAY'
    | 'CLOSING'
    | 'AFTER_HOURS';

export interface TodayDecisionItemDto {
    rank: number;
    symbol: string;
    name: string;
    last_price: number | null;
    change_pct: number | null;
    action: TodayAction;
    action_label: string;
    action_hint: string;
    suggested_buy_price?: number | null;
    suggested_buy_zone_low?: number | null;
    suggested_buy_zone_high?: number | null;
    suggested_buy_note?: string | null;
    conviction: number;
    why: string[];
    risk: string[];
    trap_flags?: string[];
    trap_penalty?: number;
    next_check: string | null;
    sources: {
        c_score: number | null;
        bp_score: number | null;
        heat_score: number | null;
        rank: number | null;
        focus_rank: number | null;
        decision_status: string | null;
        momentum_state: string | null;
        open_confirm: string | null;
        a_score: number | null;
    };
    data_confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface TodayOvernightBriefDto {
    available: boolean;
    session_date: string | null;
    created_at: string | null;
    us_overnight_bias: string | null;
    headline: string;
    source?: 'live' | 'snapshot' | 'none';
    assets: Array<{
        id: string;
        name?: string;
        change_pct: number | null;
    }>;
}

export interface TodayDecisionBoardDto {
    as_of: string;
    version: string;
    mode: TodayMode;
    mode_label: string;
    headline: string;
    market_note: string;
    items: TodayDecisionItemDto[];
    counts: {
        actionable: number;
        watch: number;
        wait: number;
        avoid: number;
    };
    overnight: TodayOvernightBriefDto | null;
    data_ready: boolean;
    not_ready_reason: string | null;
    disclaimer: string;
}

/**
 * Deliberately not the up/down palette — TW colour convention would make a
 * green "可進場" chip read as 下跌.
 */
export const TODAY_ACTION_COLOR: Record<TodayAction, string> = {
    ACTIONABLE: '#2563eb',
    WATCH: '#d97706',
    WAIT: '#64748b',
    AVOID: '#dc2626',
};

export function fetchTodayDecision(
    limit = 80,
): Promise<TodayDecisionBoardDto> {
    return apiGet<TodayDecisionBoardDto>(
        `/api/v1/today/decision?limit=${limit}`,
        15_000,
    );
}
