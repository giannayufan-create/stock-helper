// Market Calendar + Corporate Actions v1 — read-only context.
// NEVER mutates A/B/C / BP / Heat weights — only reference-price semantics.

export const MCAL_VERSION = 'mcal_v1';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export type ExpiryPhase =
    | 'NORMAL'
    | 'T_MINUS_3'
    | 'T_MINUS_2'
    | 'T_MINUS_1'
    | 'EXPIRY_DAY'
    | 'POST_EXPIRY';

export type CorporateActionType =
    | 'EX_DIVIDEND'
    | 'EX_RIGHT'
    | 'EX_RIGHT_DIVIDEND';

export type GapAdjustmentReason = 'CORPORATE_ACTION' | 'NONE';

export interface CalendarDataMeta {
    source: string;
    published_at: string | null;
    fetched_at: string;
    observed_at: string;
    freshness: string;
    confidence: ConfidenceLevel;
    available: boolean;
}

export interface TradingDayInfo {
    date: string;
    is_trading_day: boolean;
    is_weekend: boolean;
    is_holiday: boolean;
    holiday_name: string | null;
    source: string;
    confidence: ConfidenceLevel;
}

export interface MonthlyExpiryInfo {
    date: string;
    contract_month: string;
    is_monthly_expiry_day: boolean;
    days_to_monthly_expiry: number;
    expiry_phase: ExpiryPhase;
    source: string;
    confidence: ConfidenceLevel;
    /** Optional soft label — never a directional prediction. */
    institutional_roll_sensitive: boolean;
}

export interface CorporateAction {
    symbol: string;
    name: string;
    action_date: string;
    action_type: CorporateActionType;
    market: 'TWSE' | 'TPEx' | 'UNKNOWN';
    cash_dividend: number | null;
    stock_dividend: number | null;
    free_share_ratio: number | null;
    cash_capital_ratio: number | null;
    subscription_price: number | null;
    previous_close: number | null;
    previous_close_available: boolean;
    ex_reference_price: number | null;
    ex_reference_price_available: boolean;
    opening_reference_price: number | null;
    opening_reference_price_available: boolean;
    source: string;
    published_at: string | null;
    fetched_at: string;
    confidence: ConfidenceLevel;
}

export interface CorporateActionContext {
    has_action_today: boolean;
    action_type: CorporateActionType | null;
    days_to_action: number | null;
    cash_dividend: number | null;
    ex_reference_price: number | null;
    raw_previous_close: number | null;
    adjusted_reference_price: number | null;
    action: CorporateAction | null;
    available: boolean;
    confidence: ConfidenceLevel;
}

export interface GapNormalization {
    raw_gap_pct: number | null;
    adjusted_gap_pct: number | null;
    /** Strategy / score path uses this. */
    strategy_gap_pct: number | null;
    raw_change_pct: number | null;
    adjusted_change_pct: number | null;
    strategy_change_pct: number | null;
    reference_price_used: number | null;
    raw_previous_close: number | null;
    gap_adjustment_reason: GapAdjustmentReason;
    corporate_action: boolean;
    available: boolean;
    confidence: ConfidenceLevel;
}

export interface BreakoutCaGuard {
    available: boolean;
    reason: string | null;
    scale_factor: number | null;
    adjusted_prev_close: number | null;
}

export interface CalendarTodaySnapshot {
    date: string;
    trading_day: TradingDayInfo;
    monthly_expiry: MonthlyExpiryInfo;
    corporate_actions_today: CorporateAction[];
    corporate_action_count: number;
    corporate_actions_this_month: CorporateAction[];
    corporate_actions_next_month: CorporateAction[];
    this_month: string;
    next_month: string;
    major_event_count: number;
    calendar_context: {
        monthly_expiry_label: string;
        expiry_phase: ExpiryPhase;
        days_to_monthly_expiry: number;
        institutional_roll_sensitive: boolean;
    };
    meta: CalendarDataMeta;
    creates_upstream_subscription: false;
    mutates_strategy: false;
}

export interface MarketCalendarHealth {
    enabled: true;
    status: 'OK' | 'DEGRADED' | 'UNAVAILABLE';
    version: string;
    trading_day_available: boolean;
    expiry_available: boolean;
    twse_actions_available: boolean;
    tpex_actions_available: boolean;
    last_refresh_at: string | null;
    action_count: number;
    creates_upstream_subscription: false;
    mutates_strategy: false;
}
