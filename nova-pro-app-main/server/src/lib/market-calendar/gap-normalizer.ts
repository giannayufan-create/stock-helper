// Gap / change normalization — reference semantics only; no weight changes.

import { deriveCashOnlyExRef } from './corporate-actions.ts';
import type {
    BreakoutCaGuard,
    CorporateAction,
    CorporateActionContext,
    GapNormalization,
} from './types.ts';
import { tradingDaysBetween, type HolidayOverrides } from './trading-day.ts';

function pct(now: number, ref: number): number | null {
    if (!(ref > 0) || !Number.isFinite(now)) return null;
    return Math.round(((now - ref) / ref) * 10000) / 100;
}

export function buildCorporateActionContext(opts: {
    symbol: string;
    asOfYmd: string;
    actions: CorporateAction[];
    overrides: HolidayOverrides;
}): CorporateActionContext {
    const sym = opts.symbol.trim();
    const forSym = opts.actions
        .filter((a) => a.symbol === sym)
        .sort((a, b) => a.action_date.localeCompare(b.action_date));

    const today = forSym.find((a) => a.action_date === opts.asOfYmd) ?? null;
    const upcoming =
        forSym.find((a) => a.action_date >= opts.asOfYmd) ?? today;

    if (!upcoming) {
        return {
            has_action_today: false,
            action_type: null,
            days_to_action: null,
            cash_dividend: null,
            ex_reference_price: null,
            raw_previous_close: null,
            adjusted_reference_price: null,
            action: null,
            available: true,
            confidence: 'HIGH',
        };
    }

    const days =
        upcoming.action_date === opts.asOfYmd
            ? 0
            : tradingDaysBetween(
                  opts.asOfYmd,
                  upcoming.action_date,
                  opts.overrides,
              );

    const exRef =
        upcoming.ex_reference_price ??
        deriveCashOnlyExRef(upcoming) ??
        upcoming.opening_reference_price;

    return {
        has_action_today: today != null,
        action_type: upcoming.action_type,
        days_to_action: days,
        cash_dividend: upcoming.cash_dividend,
        ex_reference_price: exRef,
        raw_previous_close: upcoming.previous_close,
        adjusted_reference_price: exRef,
        action: upcoming,
        available: true,
        confidence: today?.confidence ?? upcoming.confidence,
    };
}

/**
 * Strategy gap uses adjusted_gap when CA today + official/derived ex_ref.
 * Non-CA stocks: raw === adjusted (identical to legacy).
 */
export function normalizeGap(opts: {
    todayPrice: number;
    openPrice?: number | null;
    vendorPrevClose: number | null;
    ctx: CorporateActionContext;
}): GapNormalization {
    const open = opts.openPrice != null && opts.openPrice > 0
        ? opts.openPrice
        : opts.todayPrice;
    const vendor = opts.vendorPrevClose != null && opts.vendorPrevClose > 0
        ? opts.vendorPrevClose
        : null;

    if (!opts.ctx.has_action_today) {
        const g = vendor != null ? pct(open, vendor) : null;
        const c = vendor != null ? pct(opts.todayPrice, vendor) : null;
        return {
            raw_gap_pct: g,
            adjusted_gap_pct: g,
            strategy_gap_pct: g,
            raw_change_pct: c,
            adjusted_change_pct: c,
            strategy_change_pct: c,
            reference_price_used: vendor,
            raw_previous_close: vendor,
            gap_adjustment_reason: 'NONE',
            corporate_action: false,
            available: vendor != null,
            confidence: vendor != null ? 'HIGH' : 'NONE',
        };
    }

    const rawPrev =
        opts.ctx.raw_previous_close != null && opts.ctx.raw_previous_close > 0
            ? opts.ctx.raw_previous_close
            : vendor;
    const adj =
        opts.ctx.adjusted_reference_price != null &&
        opts.ctx.adjusted_reference_price > 0
            ? opts.ctx.adjusted_reference_price
            : opts.ctx.ex_reference_price;

    // If we cannot confirm adjusted reference — degrade confidence; do not invent.
    if (adj == null || !(adj > 0)) {
        const g = vendor != null ? pct(open, vendor) : null;
        const c = vendor != null ? pct(opts.todayPrice, vendor) : null;
        return {
            raw_gap_pct: rawPrev != null ? pct(open, rawPrev) : g,
            adjusted_gap_pct: null,
            strategy_gap_pct: g,
            raw_change_pct: rawPrev != null ? pct(opts.todayPrice, rawPrev) : c,
            adjusted_change_pct: null,
            strategy_change_pct: c,
            reference_price_used: vendor,
            raw_previous_close: rawPrev,
            gap_adjustment_reason: 'CORPORATE_ACTION',
            corporate_action: true,
            available: false,
            confidence: 'LOW',
        };
    }

    const rawGap = rawPrev != null ? pct(open, rawPrev) : null;
    const adjGap = pct(open, adj);
    const rawChg = rawPrev != null ? pct(opts.todayPrice, rawPrev) : null;
    const adjChg = pct(opts.todayPrice, adj);

    return {
        raw_gap_pct: rawGap,
        adjusted_gap_pct: adjGap,
        strategy_gap_pct: adjGap,
        raw_change_pct: rawChg,
        adjusted_change_pct: adjChg,
        strategy_change_pct: adjChg,
        reference_price_used: adj,
        raw_previous_close: rawPrev,
        gap_adjustment_reason: 'CORPORATE_ACTION',
        corporate_action: true,
        available: true,
        confidence: opts.ctx.confidence,
    };
}

/**
 * Breakout prior-level guard. Scale prior prices by ex_ref/prev_close when both known.
 * Otherwise available=false — never use unadjusted prior high as breakout ref on CA day.
 */
export function breakoutCorporateActionGuard(
    ctx: CorporateActionContext,
): BreakoutCaGuard {
    if (!ctx.has_action_today) {
        return {
            available: true,
            reason: null,
            scale_factor: null,
            adjusted_prev_close: null,
        };
    }
    const prev = ctx.raw_previous_close;
    const ex = ctx.ex_reference_price ?? ctx.adjusted_reference_price;
    if (prev != null && prev > 0 && ex != null && ex > 0) {
        return {
            available: true,
            reason: null,
            scale_factor: ex / prev,
            adjusted_prev_close: ex,
        };
    }
    // Cash-only: can adjust by subtracting cash from levels if prev known via vendor? Still need scale.
    if (
        ctx.action_type === 'EX_DIVIDEND' &&
        ctx.cash_dividend != null &&
        prev != null &&
        prev > 0
    ) {
        const adj = prev - ctx.cash_dividend;
        if (adj > 0) {
            return {
                available: true,
                reason: null,
                scale_factor: adj / prev,
                adjusted_prev_close: adj,
            };
        }
    }
    return {
        available: false,
        reason: 'corporate_action_unadjusted_breakout_ref',
        scale_factor: null,
        adjusted_prev_close: null,
    };
}

/** True if [fromYmd, toYmd] crosses a corporate action date for symbol (exclusive of same-session). */
export function crossesCorporateAction(opts: {
    symbol: string;
    fromYmd: string;
    toYmd: string;
    actions: CorporateAction[];
}): boolean {
    if (opts.fromYmd >= opts.toYmd) return false;
    return opts.actions.some(
        (a) =>
            a.symbol === opts.symbol &&
            a.action_date > opts.fromYmd &&
            a.action_date <= opts.toYmd,
    );
}
