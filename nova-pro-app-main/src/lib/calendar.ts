// src/lib/calendar.ts — Market Calendar client

import { apiGet } from './api';

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

export interface CorporateActionDto {
    symbol: string;
    name: string;
    action_date: string;
    action_type: CorporateActionType;
    market: string;
    cash_dividend: number | null;
    ex_reference_price: number | null;
    previous_close: number | null;
    confidence: string;
    source: string;
}

export interface CalendarTodayDto {
    date: string;
    trading_day: {
        is_trading_day: boolean;
        is_holiday: boolean;
        holiday_name: string | null;
    };
    monthly_expiry: {
        date: string;
        contract_month: string;
        is_monthly_expiry_day: boolean;
        days_to_monthly_expiry: number;
        expiry_phase: ExpiryPhase;
        institutional_roll_sensitive: boolean;
        source: string;
        confidence: string;
    };
    corporate_actions_today: CorporateActionDto[];
    corporate_action_count: number;
    major_event_count: number;
    calendar_context: {
        monthly_expiry_label: string;
        expiry_phase: ExpiryPhase;
        days_to_monthly_expiry: number;
        institutional_roll_sensitive: boolean;
    };
}

export interface CorporateActionSymbolDto {
    symbol: string;
    as_of: string;
    corporate_action_context: {
        has_action_today: boolean;
        action_type: CorporateActionType | null;
        days_to_action: number | null;
        cash_dividend: number | null;
        ex_reference_price: number | null;
        raw_previous_close: number | null;
        adjusted_reference_price: number | null;
    };
    upcoming: CorporateActionDto[];
}

export const ACTION_TYPE_LABEL: Record<CorporateActionType, string> = {
    EX_DIVIDEND: '除息',
    EX_RIGHT: '除權',
    EX_RIGHT_DIVIDEND: '除權息',
};

export const EXPIRY_PHASE_LABEL: Record<ExpiryPhase, string> = {
    NORMAL: '平常日',
    T_MINUS_3: '結算前 3 日',
    T_MINUS_2: '結算前 2 日',
    T_MINUS_1: '結算前 1 日',
    EXPIRY_DAY: '月結算日',
    POST_EXPIRY: '結算後',
};

export function fetchCalendarToday(date?: string) {
    const q = date ? `?date=${encodeURIComponent(date)}` : '';
    return apiGet<CalendarTodayDto>(`/api/v1/calendar/today${q}`);
}

export function fetchCalendarExpiry(date?: string) {
    const q = date ? `?date=${encodeURIComponent(date)}` : '';
    return apiGet<{
        monthly_expiry: CalendarTodayDto['monthly_expiry'];
        calendar_context: {
            label: string;
            phase: ExpiryPhase;
            days_to_monthly_expiry: number;
            institutional_roll_sensitive: boolean;
            note: string;
        };
    }>(`/api/v1/calendar/expiry${q}`);
}

export function fetchCorporateActions(opts?: {
    from?: string;
    to?: string;
    symbol?: string;
}) {
    const q = new URLSearchParams();
    if (opts?.from) q.set('from', opts.from);
    if (opts?.to) q.set('to', opts.to);
    if (opts?.symbol) q.set('symbol', opts.symbol);
    const qs = q.toString();
    return apiGet<{ count: number; items: CorporateActionDto[] }>(
        `/api/v1/calendar/corporate-actions${qs ? `?${qs}` : ''}`,
    );
}

export function fetchCorporateActionSymbol(symbol: string, date?: string) {
    const q = date ? `?date=${encodeURIComponent(date)}` : '';
    return apiGet<CorporateActionSymbolDto>(
        `/api/v1/calendar/corporate-actions/${encodeURIComponent(symbol)}${q}`,
    );
}
