// server/src/lib/today-decision/types.ts
// Today Decision Board — merge-only presentation layer.
// NEVER mutates A/B/C / BP / Heat / Rank / Radar / strategy thresholds.
// It only re-expresses existing layer outputs as one ranked Chinese answer.

export const TODAY_DECISION_VERSION = 'today_v1';

export type TodayMode =
    | 'PREOPEN'
    | 'OPENING'
    | 'INTRADAY'
    | 'CLOSING'
    | 'AFTER_HOURS';

/** Single merged verdict per symbol. */
export type TodayAction = 'ACTIONABLE' | 'WATCH' | 'WAIT' | 'AVOID';

export interface TodaySourceTrace {
    c_score: number | null;
    bp_score: number | null;
    heat_score: number | null;
    rank: number | null;
    focus_rank: number | null;
    decision_status: string | null;
    momentum_state: string | null;
    open_confirm: string | null;
    a_score: number | null;
}

export interface TodayDecisionItem {
    rank: number;
    symbol: string;
    name: string;
    last_price: number | null;
    change_pct: number | null;
    action: TodayAction;
    /** Chinese, user-facing. */
    action_label: string;
    /** One sentence: what to do right now. */
    action_hint: string;
    /** Presentation-only merged confidence 0–100 — not a strategy score. */
    conviction: number;
    why: string[];
    risk: string[];
    trap_flags: string[];
    trap_penalty: number;
    next_check: string | null;
    sources: TodaySourceTrace;
    data_confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface TodayOvernightBrief {
    available: boolean;
    session_date: string | null;
    created_at: string | null;
    us_overnight_bias: string | null;
    headline: string;
    source: 'live' | 'snapshot' | 'none';
    assets: Array<{
        id: string;
        name: string;
        change_pct: number | null;
    }>;
}

export interface TodayDecisionBoard {
    as_of: string;
    version: string;
    mode: TodayMode;
    mode_label: string;
    /** One sentence answering "what do I do today". */
    headline: string;
    market_note: string;
    items: TodayDecisionItem[];
    counts: {
        actionable: number;
        watch: number;
        wait: number;
        avoid: number;
    };
    overnight: TodayOvernightBrief | null;
    data_ready: boolean;
    not_ready_reason: string | null;
    mutates_strategy: false;
    disclaimer: string;
}

/** Flat read-only per-symbol input — never written back to any layer. */
export interface TodayInputItem {
    symbol: string;
    name: string;
    last_price: number | null;
    change_pct: number | null;

    // C layer (intraday rank)
    c_score: number | null;
    c_state: string | null;
    rank: number | null;
    rank_change: number | null;
    heat_score: number | null;
    chase_risk: string | null;
    vwap_pos_pct: number | null;
    rvol: number | null;
    breakout_type: string | null;
    pullback_state: string | null;
    events: string[];
    c_reasons: string[];
    c_risks: string[];
    trap_flags: string[];
    trap_penalty: number;
    data_blocked: boolean;
    data_health: string | null;
    score_coverage_pct: number | null;

    // BP layer
    bp_score: number | null;
    bp_state: string | null;
    bp_overheated: boolean;
    bp_stale: boolean;

    // Radar Quality layer
    momentum_state: string | null;
    eligibility: string | null;
    focus_rank: number | null;
    rq_reasons: string[];

    // Decision Summary layer
    decision_status: string | null;
    decision_confirmed: string[];
    decision_missing: string[];
    decision_risks: string[];
    decision_next: string[];

    // Open Gate (B) layer
    open_confirm: string | null;
    open_score: number | null;
    tradeable_candidate: boolean;

    // A layer
    a_score: number | null;
}

export interface TodayBoardInput {
    now: Date;
    mode: TodayMode;
    items: TodayInputItem[];
    taiwan_regime: string | null;
    market_breadth_advance_pct: number | null;
    overnight: TodayOvernightBrief | null;
    limit?: number;
}
