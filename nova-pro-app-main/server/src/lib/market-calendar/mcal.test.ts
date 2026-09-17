// Market Calendar + Corporate Actions v1 tests (A–H)
// Run: npx tsx src/lib/market-calendar/mcal.test.ts

import assert from 'node:assert/strict';
import {
    breakoutCorporateActionGuard,
    buildCorporateActionContext,
    emptyOverrides,
    estimateThirdWednesday,
    expiryPhase,
    mapActionType,
    MarketCalendarService,
    mergeOfficialHolidays,
    normalizeActionDate,
    normalizeGap,
    resolveMonthlyExpiry,
    taipeiYmd,
} from './index.ts';
import type { CorporateAction } from './types.ts';
import { loadOpenGateConfig } from '../open-gate-v2/config.ts';
import { loadIntradayRankConfig } from '../intraday-rank/config.ts';
import { loadBuyPressureConfig } from '../buy-pressure/config.ts';

function ca(partial: Partial<CorporateAction> & Pick<CorporateAction, 'symbol' | 'action_date' | 'action_type'>): CorporateAction {
    return {
        name: partial.name ?? 'TEST',
        market: partial.market ?? 'TWSE',
        cash_dividend: partial.cash_dividend ?? null,
        stock_dividend: null,
        free_share_ratio: partial.free_share_ratio ?? null,
        cash_capital_ratio: null,
        subscription_price: null,
        previous_close: partial.previous_close ?? null,
        previous_close_available: partial.previous_close != null,
        ex_reference_price: partial.ex_reference_price ?? null,
        ex_reference_price_available: partial.ex_reference_price != null,
        opening_reference_price: partial.opening_reference_price ?? null,
        opening_reference_price_available: false,
        source: partial.source ?? 'test',
        published_at: null,
        fetched_at: new Date().toISOString(),
        confidence: 'HIGH',
        ...partial,
    };
}

console.log('=== Market Calendar Tests A–H ===');

// TEST A — third Wednesday marked EXPIRY_DAY (2026-09-16)
{
    const overrides = emptyOverrides();
    const est = estimateThirdWednesday(2026, 9, overrides);
    assert.equal(est, '2026-09-16', `expected 3rd Wed 2026-09-16 got ${est}`);
    const monthly = resolveMonthlyExpiry({
        asOfYmd: '2026-09-16',
        overrides,
        official: [
            {
                date: '2026-09-16',
                contract_month: '202609',
                product: 'TX',
                source: 'TAIFEX:seed',
            },
        ],
    });
    assert.equal(monthly.is_monthly_expiry_day, true);
    assert.equal(monthly.expiry_phase, 'EXPIRY_DAY');
    assert.equal(monthly.days_to_monthly_expiry, 0);
    assert.equal(expiryPhase(0, true), 'EXPIRY_DAY');
    console.log('PASS TEST A monthly third Wednesday EXPIRY_DAY');
}

// TEST B — official calendar wins over bare hardcode
{
    const overrides = emptyOverrides();
    const rule = estimateThirdWednesday(2026, 2, overrides);
    // Official adjusted (holiday) differs from raw rule
    const officialDate = '2026-02-25';
    assert.notEqual(
        rule,
        officialDate,
        'fixture requires official ≠ raw third-Wednesday for Feb 2026',
    );
    const monthly = resolveMonthlyExpiry({
        asOfYmd: '2026-02-25',
        overrides,
        official: [
            {
                date: officialDate,
                contract_month: '202602',
                product: 'TX',
                source: 'TAIFEX:official',
            },
        ],
    });
    assert.equal(monthly.date, officialDate);
    assert.equal(monthly.source, 'TAIFEX:official');
    assert.equal(monthly.is_monthly_expiry_day, true);
    assert.equal(monthly.confidence, 'HIGH');

    // Holiday closed day must not be treated as trading expiry without override
    const withHoliday = mergeOfficialHolidays(
        emptyOverrides(),
        [{ date: '2026-09-16', name: '假日測試' }],
        'official_holiday',
    );
    const adj = estimateThirdWednesday(2026, 9, withHoliday);
    assert.notEqual(adj, '2026-09-16');
    console.log('PASS TEST B official calendar preferred over hardcode');
}

// TEST C — ex-div gap normalization
{
    const action = ca({
        symbol: '2330',
        name: '台積電',
        action_date: '2026-09-16',
        action_type: 'EX_DIVIDEND',
        cash_dividend: 5,
        previous_close: 100,
        ex_reference_price: 95,
    });
    const ctx = buildCorporateActionContext({
        symbol: '2330',
        asOfYmd: '2026-09-16',
        actions: [action],
        overrides: emptyOverrides(),
    });
    assert.equal(ctx.has_action_today, true);
    const g = normalizeGap({
        todayPrice: 95,
        openPrice: 95,
        vendorPrevClose: 100, // if vendor still shows raw
        ctx,
    });
    assert.ok(g.raw_gap_pct != null);
    assert.ok(Math.abs(g.raw_gap_pct! - -5) < 0.05, `raw_gap=${g.raw_gap_pct}`);
    assert.ok(g.adjusted_gap_pct != null);
    assert.ok(
        Math.abs(g.adjusted_gap_pct!) < 0.05,
        `adjusted_gap=${g.adjusted_gap_pct}`,
    );
    assert.equal(g.gap_adjustment_reason, 'CORPORATE_ACTION');
    assert.equal(g.strategy_gap_pct, g.adjusted_gap_pct);
    console.log('PASS TEST C raw≈-5% adjusted≈0%');
}

// TEST D — C/BP must not treat ex-div as fake bearish via strategy gap
{
    const action = ca({
        symbol: '2330',
        action_date: '2026-09-16',
        action_type: 'EX_DIVIDEND',
        cash_dividend: 5,
        previous_close: 100,
        ex_reference_price: 95,
    });
    const svc = new MarketCalendarService();
    svc.seedForTest({ actions: [action], twseOk: true });
    const g = svc.getGapNormalization({
        symbol: '2330',
        todayPrice: 95,
        openPrice: 95,
        vendorPrevClose: 100,
        asOfYmd: '2026-09-16',
    });
    // Strategy path near flat — not a large down gap for risk/chase
    assert.ok(Math.abs(g.strategy_gap_pct ?? 99) < 0.5);
    assert.ok(Math.abs(g.strategy_change_pct ?? 99) < 0.5);
    console.log('PASS TEST D strategy gap not falsely bearish');
}

// TEST E — Radar badge EX_DIVIDEND → EX-DIV
{
    const action = ca({
        symbol: '2330',
        action_date: '2026-09-16',
        action_type: 'EX_DIVIDEND',
        cash_dividend: 7,
        previous_close: 1000,
        ex_reference_price: 993,
    });
    const svc = new MarketCalendarService();
    svc.seedForTest({ actions: [action], twseOk: true });
    const ctx = svc.getCorporateActionContext('2330', '2026-09-16');
    assert.equal(ctx.has_action_today, true);
    assert.equal(ctx.action_type, 'EX_DIVIDEND');
    const actionType: string | null = ctx.action_type;
    const badge =
        actionType === 'EX_RIGHT'
            ? 'EX-RIGHT'
            : actionType === 'EX_RIGHT_DIVIDEND'
              ? 'EX-RIGHT-DIV'
              : 'EX-DIV';
    assert.equal(badge, 'EX-DIV');
    assert.equal(mapActionType('息'), 'EX_DIVIDEND');
    assert.equal(mapActionType('權'), 'EX_RIGHT');
    assert.equal(mapActionType('權息'), 'EX_RIGHT_DIVIDEND');
    console.log('PASS TEST E EX-DIV badge mapping');
}

// TEST F — non-CA stock identical to legacy
{
    const ctx = buildCorporateActionContext({
        symbol: '2317',
        asOfYmd: '2026-09-16',
        actions: [],
        overrides: emptyOverrides(),
    });
    const g = normalizeGap({
        todayPrice: 105,
        openPrice: 102,
        vendorPrevClose: 100,
        ctx,
    });
    assert.equal(g.gap_adjustment_reason, 'NONE');
    assert.equal(g.raw_gap_pct, 2);
    assert.equal(g.adjusted_gap_pct, 2);
    assert.equal(g.strategy_gap_pct, 2);
    assert.equal(g.raw_change_pct, 5);
    assert.equal(g.strategy_change_pct, 5);
    console.log('PASS TEST F non-CA identical');
}

// TEST G — calendar unavailable soft-fail (no crash; confidence down)
{
    const svc = new MarketCalendarService();
    // no seed / no network — still returns trading day + expiry
    const today = svc.getToday('2026-09-16');
    assert.equal(today.mutates_strategy, false);
    assert.equal(today.creates_upstream_subscription, false);
    assert.ok(today.monthly_expiry);
    const g = svc.getGapNormalization({
        symbol: '9999',
        todayPrice: 10,
        openPrice: 10,
        vendorPrevClose: 10,
        asOfYmd: '2026-09-16',
    });
    assert.equal(g.gap_adjustment_reason, 'NONE');
    const br = breakoutCorporateActionGuard({
        has_action_today: true,
        action_type: 'EX_RIGHT_DIVIDEND',
        days_to_action: 0,
        cash_dividend: null,
        ex_reference_price: null,
        raw_previous_close: null,
        adjusted_reference_price: null,
        action: null,
        available: false,
        confidence: 'NONE',
    });
    assert.equal(br.available, false);
    console.log('PASS TEST G soft-fail / unavailable breakout guard');
}

// TEST H — no Shioaji subscription flag; weights unchanged fingerprint
{
    const snap = new MarketCalendarService().getToday('2026-09-16');
    assert.equal(snap.creates_upstream_subscription, false);
    assert.equal(snap.mutates_strategy, false);
    const health = new MarketCalendarService().getHealth();
    assert.equal(health.creates_upstream_subscription, false);
    assert.equal(health.mutates_strategy, false);

    // Weights must equal defaults (no strategy weight mutation in this phase)
    const og = loadOpenGateConfig();
    const ir = loadIntradayRankConfig();
    const bp = loadBuyPressureConfig();
    assert.equal(og.score_weights.gap, 5);
    assert.equal(og.score_weights.momentum, 15);
    assert.equal(ir.weights.breakout, 10);
    assert.equal(ir.weights.momentum, 20);
    assert.ok(bp);
    assert.ok(typeof bp.evaluate_interval_sec === 'number' || bp.overheated);
    console.log('PASS TEST H no new Shioaji sub; strategy weights untouched');
}

// Extra: date parse + ROC
{
    assert.equal(normalizeActionDate('1150916'), '2026-09-16');
    assert.equal(normalizeActionDate('2026/09/16'), '2026-09-16');
    assert.ok(taipeiYmd().match(/^\d{4}-\d{2}-\d{2}$/));
    console.log('PASS date normalize helpers');
}

console.log('\nAll Market Calendar Tests A–H PASSED');
