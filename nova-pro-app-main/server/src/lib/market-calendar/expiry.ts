// TX monthly / weekly expiry — official calendar preferred; rule estimate as fallback.
// NEVER hardcode "3rd Wednesday" without holiday / official adjustment.

import type { ConfidenceLevel, ExpiryPhase, MonthlyExpiryInfo } from './types.ts';
import {
    addCalendarDays,
    isTradingDay,
    parseYmd,
    tradingDaysBetween,
    weekdayTaipei,
    type HolidayOverrides,
} from './trading-day.ts';

export interface OfficialExpiryEntry {
    date: string; // YYYY-MM-DD last trading / settlement day
    contract_month: string; // YYYYMM
    product?: string; // TX default
    source: string;
}

/**
 * Rule estimate (TAIFEX TX monthly): third Wednesday of contract month.
 * If that day is not a trading day → previous trading day (standard TAIFEX adjustment).
 * Official entries ALWAYS win over this estimate.
 */
export function estimateThirdWednesday(
    year: number,
    month: number, // 1-12
    overrides: HolidayOverrides,
): string {
    // Find first day weekday, then 3rd Wednesday
    const firstYmd = `${year}-${String(month).padStart(2, '0')}-01`;
    const firstWd = weekdayTaipei(firstYmd); // 0 Sun … 6 Sat
    // Wednesday = 3
    let offset = (3 - firstWd + 7) % 7;
    // first Wednesday
    let wed = addCalendarDays(firstYmd, offset);
    // third Wednesday = first + 14 days
    wed = addCalendarDays(wed, 14);
    // Adjust for holidays / weekends
    let guard = 10;
    while (!isTradingDay(wed, overrides) && guard-- > 0) {
        wed = addCalendarDays(wed, -1);
    }
    return wed;
}

export function expiryPhase(
    daysTo: number,
    isExpiryDay: boolean,
): ExpiryPhase {
    if (isExpiryDay || daysTo === 0) return 'EXPIRY_DAY';
    if (daysTo < 0) return 'POST_EXPIRY';
    if (daysTo === 1) return 'T_MINUS_1';
    if (daysTo === 2) return 'T_MINUS_2';
    if (daysTo === 3) return 'T_MINUS_3';
    return 'NORMAL';
}

export function resolveMonthlyExpiry(opts: {
    asOfYmd: string;
    overrides: HolidayOverrides;
    official: OfficialExpiryEntry[];
}): MonthlyExpiryInfo {
    const { asOfYmd, overrides, official } = opts;
    const { y, m } = parseYmd(asOfYmd);

    // Prefer official entries for current + next month window
    const officialFor = (contractMonth: string) =>
        official.find(
            (e) =>
                e.contract_month === contractMonth &&
                (e.product == null || e.product === 'TX'),
        );

    const cmThis = `${y}${String(m).padStart(2, '0')}`;
    let nextY = y;
    let nextM = m + 1;
    if (nextM > 12) {
        nextM = 1;
        nextY += 1;
    }
    const cmNext = `${nextY}${String(nextM).padStart(2, '0')}`;

    let chosen: OfficialExpiryEntry | null = null;
    let source = 'rule_third_wednesday_adjusted';
    let confidence: ConfidenceLevel = 'MEDIUM';

    const offThis = officialFor(cmThis);
    const offNext = officialFor(cmNext);

    const estThis = estimateThirdWednesday(y, m, overrides);
    const estNext = estimateThirdWednesday(nextY, nextM, overrides);

    // Pick nearest upcoming (or today) expiry
    const candidates: Array<{
        date: string;
        contract_month: string;
        source: string;
        confidence: ConfidenceLevel;
    }> = [];

    if (offThis) {
        candidates.push({
            date: offThis.date,
            contract_month: offThis.contract_month,
            source: offThis.source,
            confidence: 'HIGH',
        });
    } else {
        candidates.push({
            date: estThis,
            contract_month: cmThis,
            source,
            confidence,
        });
    }
    if (offNext) {
        candidates.push({
            date: offNext.date,
            contract_month: offNext.contract_month,
            source: offNext.source,
            confidence: 'HIGH',
        });
    } else {
        candidates.push({
            date: estNext,
            contract_month: cmNext,
            source,
            confidence,
        });
    }

    // If asOf is after this month's expiry, use next; else this month if still upcoming/today
    candidates.sort((a, b) => a.date.localeCompare(b.date));
    chosen =
        candidates.find((c) => c.date >= asOfYmd) ??
        candidates[candidates.length - 1]!;

    // If we used estimate but official exists for that month with different date — already preferred above.
    // TEST B: when official present, never stick to bare hardcode.
    const days = tradingDaysBetween(asOfYmd, chosen.date, overrides);
    // tradingDaysBetween from asOf exclusive to target inclusive:
    // same day → 0; next trading day → 1. Good for days_to.
    const isDay = chosen.date === asOfYmd;
    const daysTo = isDay ? 0 : days;
    const phase = expiryPhase(daysTo, isDay);

    return {
        date: chosen.date,
        contract_month: chosen.contract_month,
        is_monthly_expiry_day: isDay,
        days_to_monthly_expiry: daysTo,
        expiry_phase: phase,
        source: chosen.source,
        confidence: chosen.confidence,
        institutional_roll_sensitive:
            phase === 'T_MINUS_3' ||
            phase === 'T_MINUS_2' ||
            phase === 'T_MINUS_1' ||
            phase === 'EXPIRY_DAY',
    };
}

/** Weekly TXO / weekly TX — Wednesdays that are not monthly (estimate). */
export function resolveWeeklyExpiryHint(
    asOfYmd: string,
    monthly: MonthlyExpiryInfo,
    overrides: HolidayOverrides,
): { date: string; is_weekly_expiry_day: boolean; source: string } {
    // Find nearest Wednesday trading day (including today)
    let cur = asOfYmd;
    for (let i = 0; i < 8; i++) {
        if (weekdayTaipei(cur) === 3 && isTradingDay(cur, overrides)) {
            const isWeekly =
                cur !== monthly.date || !monthly.is_monthly_expiry_day
                    ? cur === asOfYmd
                    : false;
            // On monthly expiry Wednesday, it's monthly not weekly
            if (cur === monthly.date) {
                return {
                    date: cur,
                    is_weekly_expiry_day: false,
                    source: 'taifex_weekly_estimate',
                };
            }
            return {
                date: cur,
                is_weekly_expiry_day: isWeekly || cur === asOfYmd,
                source: 'taifex_weekly_estimate',
            };
        }
        cur = addCalendarDays(cur, 1);
    }
    return {
        date: asOfYmd,
        is_weekly_expiry_day: false,
        source: 'taifex_weekly_estimate',
    };
}
