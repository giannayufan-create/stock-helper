// server/src/lib/today-decision/today.test.ts
// Run: npx tsx src/lib/today-decision/today.test.ts

import assert from 'node:assert/strict';
import { buildTodayBoard } from './engine.ts';
import { summarizeUsOvernightBias } from '../session-autonomy/overnight-snapshot.ts';
import type { GlobalAssetQuote } from '../market-intelligence/types.ts';
import type { TodayInputItem } from './types.ts';

let passed = 0;
function pass(name: string) {
    passed++;
    console.log(`PASS ${name}`);
}

function item(p: Partial<TodayInputItem> & { symbol: string }): TodayInputItem {
    return {
        symbol: p.symbol,
        name: p.name ?? `名稱${p.symbol}`,
        last_price: p.last_price ?? 100,
        change_pct: p.change_pct ?? 2,
        // `?? default` would swallow an explicit null, which several cases need.
        c_score: p.c_score !== undefined ? p.c_score : 60,
        c_state: p.c_state !== undefined ? p.c_state : 'HEATING',
        rank: p.rank ?? 5,
        rank_change: p.rank_change ?? 1,
        heat_score: p.heat_score ?? 50,
        chase_risk: p.chase_risk !== undefined ? p.chase_risk : 'LOW',
        vwap_pos_pct: p.vwap_pos_pct ?? 1,
        rvol: p.rvol ?? 2,
        breakout_type: p.breakout_type ?? 'none',
        pullback_state: p.pullback_state ?? 'none',
        events: p.events ?? [],
        c_reasons: p.c_reasons ?? ['量能放大'],
        c_risks: p.c_risks ?? [],
        trap_flags: p.trap_flags ?? [],
        trap_penalty: p.trap_penalty ?? 0,
        data_blocked: p.data_blocked ?? false,
        data_health: p.data_health ?? 'ok',
        score_coverage_pct: p.score_coverage_pct ?? 90,
        bp_score: p.bp_score !== undefined ? p.bp_score : 55,
        bp_state: p.bp_state ?? 'EARLY',
        bp_overheated: p.bp_overheated ?? false,
        bp_stale: p.bp_stale ?? false,
        momentum_state:
            p.momentum_state !== undefined ? p.momentum_state : 'WATCH',
        eligibility: p.eligibility ?? 'ELIGIBLE',
        focus_rank: p.focus_rank ?? null,
        rq_reasons: p.rq_reasons ?? [],
        decision_status:
            p.decision_status !== undefined ? p.decision_status : 'NOT_READY',
        decision_confirmed: p.decision_confirmed ?? [],
        decision_missing: p.decision_missing ?? [],
        decision_risks: p.decision_risks ?? [],
        decision_next: p.decision_next ?? [],
        open_confirm: p.open_confirm ?? null,
        open_score: p.open_score ?? null,
        tradeable_candidate: p.tradeable_candidate ?? false,
        a_score: p.a_score ?? null,
    };
}

const now = new Date('2026-09-17T02:00:00.000Z'); // 10:00 Taipei

function board(items: TodayInputItem[], mode: 'INTRADAY' | 'PREOPEN' = 'INTRADAY') {
    return buildTodayBoard({
        now,
        mode,
        items,
        taiwan_regime: 'RISK_ON_BROAD',
        market_breadth_advance_pct: 62,
        overnight: null,
    });
}

// ---- T1 confirmed strength + active momentum → ACTIONABLE ----
{
    const b = board([
        item({
            symbol: '2330',
            c_score: 85,
            bp_score: 78,
            decision_status: 'CONFIRMED_STRENGTH',
            momentum_state: 'ACTIVE',
            chase_risk: 'LOW',
            decision_confirmed: ['站上均價且量能放大'],
        }),
    ]);
    assert.equal(b.items[0]!.action, 'ACTIONABLE');
    assert.equal(b.items[0]!.action_label, '可考慮進場');
    assert.ok(b.items[0]!.why.length >= 1);
    assert.ok(b.headline.includes('2330'));
    pass('T1 — 條件齊全 → 可考慮進場');
}

// ---- T2 confirmed but extreme chase → AVOID ----
{
    const b = board([
        item({
            symbol: '3661',
            c_score: 92,
            bp_score: 88,
            decision_status: 'CONFIRMED_STRENGTH',
            momentum_state: 'ACTIVE',
            chase_risk: 'EXTREME',
        }),
    ]);
    assert.equal(b.items[0]!.action, 'AVOID');
    assert.ok(b.items[0]!.risk.includes('追高風險極高'));
    pass('T2 — 追高風險極高 → 不要追');
}

// ---- T3 EXTENDED never actionable ----
{
    const b = board([
        item({
            symbol: '2317',
            decision_status: 'EXTENDED',
            momentum_state: 'ACTIVE',
            c_score: 90,
            bp_score: 85,
        }),
    ]);
    assert.equal(b.items[0]!.action, 'AVOID');
    pass('T3 — 漲幅延伸 → 不要追');
}

// ---- T4 pullback → WATCH ----
{
    const b = board([
        item({
            symbol: '2454',
            momentum_state: 'PULLBACK',
            decision_status: 'WATCH',
            decision_missing: ['尚未站回均價'],
        }),
    ]);
    assert.equal(b.items[0]!.action, 'WATCH');
    assert.ok(b.items[0]!.action_hint.length > 0);
    pass('T4 — 回踩 → 再等一個確認');
}

// ---- T5 ordering: actionable before watch before wait before avoid ----
{
    const b = board([
        item({ symbol: 'AVD', decision_status: 'EXTENDED', momentum_state: 'ACTIVE' }),
        item({ symbol: 'WAI', c_score: 20, bp_score: 10 }),
        item({
            symbol: 'ACT',
            c_score: 88,
            bp_score: 80,
            decision_status: 'CONFIRMED_STRENGTH',
            momentum_state: 'ACTIVE',
        }),
        item({ symbol: 'WCH', decision_status: 'WATCH' }),
    ]);
    assert.deepEqual(
        b.items.map((i) => i.symbol),
        ['ACT', 'WCH', 'WAI', 'AVD'],
    );
    assert.deepEqual(
        b.items.map((i) => i.rank),
        [1, 2, 3, 4],
    );
    assert.equal(b.counts.actionable, 1);
    assert.equal(b.counts.avoid, 1);
    pass('T5 — 排序：可進場 → 觀察 → 未成形 → 不要追');
}

// ---- T6 data blocked never actionable ----
{
    const b = board([
        item({
            symbol: '6488',
            data_blocked: true,
            decision_status: 'CONFIRMED_STRENGTH',
            momentum_state: 'ACTIVE',
            c_score: 95,
        }),
    ]);
    assert.equal(b.items[0]!.action, 'WAIT');
    assert.equal(b.items[0]!.data_confidence, 'LOW');
    pass('T6 — 資料不完整 → 不給進場結論');
}

// ---- T7 preopen never claims actionable ----
{
    const b = board(
        [
            item({
                symbol: '2603',
                decision_status: 'CONFIRMED_STRENGTH',
                momentum_state: 'ACTIVE',
                c_score: 90,
            }),
        ],
        'PREOPEN',
    );
    assert.equal(b.mode, 'PREOPEN');
    assert.equal(b.items[0]!.action, 'WAIT');
    assert.ok(b.items[0]!.action_hint.includes('09:00'));
    pass('T7 — 盤前不宣稱可進場（開盤確認 09:00 才存在）');
}

// ---- T8 empty board is explicit, not silently fine ----
{
    const b = board([]);
    assert.equal(b.data_ready, false);
    assert.ok(b.not_ready_reason);
    assert.ok(b.headline.includes('空手'));
    pass('T8 — 沒有標的時明確說空手');
}

// ---- T9 merge layer never claims to mutate strategy ----
{
    const b = board([item({ symbol: '1101' })]);
    assert.equal(b.mutates_strategy, false);
    assert.ok(b.disclaimer.includes('非投資建議'));
    const src = b.items[0]!.sources;
    assert.ok('c_score' in src && 'bp_score' in src && 'decision_status' in src);
    pass('T9 — 合併層不改策略且保留來源可追溯');
}

// ---- T10 overnight US bias no longer hardcoded null ----
{
    const assets: GlobalAssetQuote[] = [
        {
            id: 'nasdaq',
            name: 'NASDAQ',
            value: 1,
            change: 1,
            change_pct: 1.4,
            timestamp: null,
            source: 'yahoo',
            freshness: 'FRESH',
            status: 'HEALTHY',
        },
        {
            id: 'sox',
            name: 'SOX',
            value: 1,
            change: 1,
            change_pct: 2.2,
            timestamp: null,
            source: 'yahoo',
            freshness: 'FRESH',
            status: 'HEALTHY',
        },
    ];
    const label = summarizeUsOvernightBias(assets);
    assert.ok(label && label.includes('美股'));
    assert.ok(label.includes('SOX'));
    assert.equal(summarizeUsOvernightBias([]), null);
    pass('T10 — 夜盤美股偏向有實際內容（不再固定 null）');
}

// ---- T11 preopen keeps A-pool order when no C score exists ----
{
    const b = board(
        [
            item({ symbol: 'LOW', c_score: null, a_score: 40 }),
            item({ symbol: 'TOP', c_score: null, a_score: 95 }),
            item({ symbol: 'MID', c_score: null, a_score: 70 }),
        ],
        'PREOPEN',
    );
    assert.deepEqual(
        b.items.map((i) => i.symbol),
        ['TOP', 'MID', 'LOW'],
    );
    assert.ok(b.items[0]!.why.some((w) => w.includes('前一日選股分數')));
    pass('T11 — 盤前用 A 分數排序，不會全部同分');
}

// ---- T12 開高走低 / 假突破 → AVOID ----
{
    const fade = board([
        item({
            symbol: '6505',
            c_score: 88,
            bp_score: 80,
            decision_status: 'CONFIRMED_STRENGTH',
            momentum_state: 'ACTIVE',
            trap_flags: ['FADE_FROM_HIGH'],
        }),
    ]);
    assert.equal(fade.items[0]!.action, 'AVOID');
    assert.ok(fade.items[0]!.action_hint.includes('開高走低') || fade.items[0]!.action_hint.includes('假突破'));
    pass('T12 — 開高走低 → 不要追');

    const brk = board([
        item({
            symbol: '2609',
            c_score: 88,
            bp_score: 80,
            decision_status: 'CONFIRMED_STRENGTH',
            momentum_state: 'ACTIVE',
            trap_flags: ['FAILED_BREAKOUT'],
        }),
    ]);
    assert.equal(brk.items[0]!.action, 'AVOID');
    pass('T12b — 假突破 → 不要追');
}

// ---- T13 處置股 → AVOID ----
{
    const b = board([
        item({
            symbol: '2618',
            c_score: 90,
            bp_score: 85,
            decision_status: 'CONFIRMED_STRENGTH',
            momentum_state: 'ACTIVE',
            c_risks: ['處置股'],
        }),
    ]);
    assert.equal(b.items[0]!.action, 'AVOID');
    pass('T13 — 處置股 → 不要當沖');
}

// ---- T14 注意股 cannot be ACTIONABLE ----
{
    const b = board([
        item({
            symbol: '2408',
            c_score: 88,
            bp_score: 80,
            decision_status: 'CONFIRMED_STRENGTH',
            momentum_state: 'ACTIVE',
            chase_risk: 'LOW',
            c_risks: ['注意股'],
        }),
    ]);
    assert.notEqual(b.items[0]!.action, 'ACTIONABLE');
    assert.equal(b.items[0]!.action, 'WATCH');
    pass('T14 — 注意股最多觀察，不能當正式進場');
}

console.log(`\ntoday.test.ts ${passed} passed`);
