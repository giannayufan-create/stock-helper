// server/src/lib/radar-rescue/attack-state.test.ts
// Scenarios A–K + persistence / FAKE / quality guards.

import { DEFAULT_RESCUE_CONFIG } from './config.ts';
import {
    buildAttackFeatures,
    computeAskEatingQuality,
    countDistinctBreakoutPrints,
    isBreakoutPersistent,
    isTrueAskEating,
    resolveAttackState,
    type AttackFeatures,
    type EarlyTrack,
} from './attack-state.ts';

function assert(cond: boolean, msg: string): void {
    if (!cond) throw new Error(`FAIL: ${msg}`);
    console.log(`PASS: ${msg}`);
}

function threeDistinctPrints(bo = 101) {
    return [
        { trade_key: 't1', ts_ms: 1_000, price: bo + 0.5 },
        { trade_key: 't2', ts_ms: 2_000, price: bo + 0.8 },
        { trade_key: 't3', ts_ms: 3_500, price: bo + 1.0 },
    ];
}

function baseFeatures(over: Partial<AttackFeatures> = {}): AttackFeatures {
    return {
        change_pct: 1.0,
        last_price: 100,
        vwap_pos_pct: 0.3,
        prev_vwap_pos_pct: 0.2,
        volume_accel: 18,
        rank_velocity: 8,
        bp_slope: 0.1,
        buy_surge: false,
        ask_eating_raw: false,
        trade_aggression: 40,
        trade_aggression_available: true,
        return_30s: 0.15,
        return_1m: 0.25,
        return_3m: 0.1,
        breakout_type: 'attempt',
        trigger: 45,
        near_limit: false,
        limit_up: false,
        last_trade_age_sec: 2,
        quote_age_sec: 2,
        orderbook_age_sec: 2,
        volume_age_sec: 2,
        breakout_price: null,
        prints_above_breakout: 0,
        breakout_print_samples: [],
        breakout_hold_sec: null,
        breakout_hold_has_fresh_trades: false,
        last_trade_key: null,
        last_trade_ts_ms: null,
        last_trade_seq: null,
        best_bid_lift: false,
        sell_aggression_up: false,
        ask_replenish_heavy: false,
        ...over,
    };
}

function freshTrack(
    over: Partial<EarlyTrack> &
        Pick<EarlyTrack, 'triggered_at_ms' | 'trigger_price' | 'state'>,
): EarlyTrack {
    return {
        symbol: 'TEST',
        trigger_change_pct: 1.0,
        peak_price: over.trigger_price,
        high_since_trigger: over.trigger_price,
        last_ask_eating: true,
        last_valid_state: over.state,
        cooldown_until_ms: 0,
        stalling_since_ms: null,
        breakout_price: null,
        breakout_at_ms: null,
        breakout_event_valid: false,
        breakout_confirmed_active: false,
        prints_above_breakout: 0,
        distinct_print_keys: [],
        last_trade_key: null,
        last_fresh_trade_ms: null,
        attack_score_at_fail: 0,
        failed_at_ms: null,
        ...over,
    };
}

function decide(
    f: AttackFeatures,
    opts?: {
        cashSession?: boolean;
        prev?: EarlyTrack | null;
        nowMs?: number;
        stale?: boolean;
    },
) {
    return resolveAttackState(DEFAULT_RESCUE_CONFIG, f, {
        symbol: 'TEST',
        cashSession: opts?.cashSession ?? true,
        stale: opts?.stale ?? false,
        dataBlocked: false,
        prev: opts?.prev ?? null,
        nowMs: opts?.nowMs ?? Date.now(),
    });
}

console.log('\n=== A: 漲1%，量價同步加速 → EARLY ===');
{
    const input = baseFeatures({
        change_pct: 1.0,
        volume_accel: 18,
        rank_velocity: 8,
        return_1m: 0.3,
        return_30s: 0.2,
        vwap_pos_pct: 0.4,
        trigger: 48,
    });
    const r = decide(input);
    console.log('expected EARLY 實際', r.state, r.label);
    assert(r.state === 'EARLY', 'A → EARLY');
    assert(r.pre_plus3 === true, 'A pre_plus3');
    assert(r.price_confirm.length >= 1, 'A has price confirm');
    assert(r.accel_evidence.length >= 2, 'A accel >= 2');
}

console.log('\n=== B: 漲1%，只有委買很厚但價格不動 → 不得 EARLY ===');
{
    const input = baseFeatures({
        change_pct: 1.0,
        volume_accel: 5,
        rank_velocity: 2,
        bp_slope: 0,
        ask_eating_raw: true,
        trade_aggression: 20,
        return_30s: 0,
        return_1m: 0,
        return_3m: 0,
        vwap_pos_pct: -0.5,
        prev_vwap_pos_pct: -0.4,
        breakout_type: 'none',
        trigger: 30,
    });
    const r = decide(input);
    assert(isTrueAskEating(input) === false, 'B true ASK_EATING false');
    assert(r.state !== 'EARLY', 'B not EARLY');
    assert(r.state !== 'PRE_ATTACK', 'B not PRE_ATTACK');
    assert(r.state !== 'ACTIVE', 'B not ACTIVE');
}

console.log('\n=== C: EARLY 後 90 秒吃不動 → EARLY_FAILED ===');
{
    const t0 = Date.now() - 90_000;
    const track = freshTrack({
        triggered_at_ms: t0,
        trigger_price: 100,
        state: 'EARLY',
        peak_price: 100.1,
        high_since_trigger: 100.1,
    });
    const input = baseFeatures({
        change_pct: 1.05,
        last_price: 100.15,
        volume_accel: 10,
        rank_velocity: 3,
        return_30s: 0,
        return_1m: 0,
        ask_eating_raw: false,
        trade_aggression: 40,
        vwap_pos_pct: 0.1,
    });
    const r = decide(input, { prev: track, nowMs: Date.now() });
    assert(r.state === 'EARLY_FAILED', 'C → EARLY_FAILED');
    assert(r.label === '吃單無效', 'C label 吃單無效');
}

console.log('\n=== D: 漲 2.5% 後突破並放量（持續確認）→ ACTIVE ===');
{
    const samples = threeDistinctPrints(101);
    const input = baseFeatures({
        change_pct: 2.5,
        last_price: 102,
        volume_accel: 22,
        return_30s: 0.2,
        return_1m: 0.5,
        breakout_type: 'breakout',
        breakout_price: 101,
        vwap_pos_pct: 0.8,
        trigger: 55,
        breakout_hold_sec: 20,
        breakout_hold_has_fresh_trades: true,
        breakout_print_samples: samples,
        last_trade_age_sec: 2,
        last_trade_key: 't3',
        last_trade_ts_ms: 3_500,
    });
    const r = decide(input);
    console.log('expected ACTIVE 實際', r.state, r.label);
    assert(r.state === 'ACTIVE', 'D → ACTIVE');
    assert(r.label === '正在急攻', 'D label 正在急攻');
}

console.log('\n=== E: 已漲 5% 再次量價急攻 → ACTIVE ===');
{
    const input = baseFeatures({
        change_pct: 5.0,
        last_price: 106,
        volume_accel: 25,
        return_30s: 0.25,
        return_1m: 0.45,
        breakout_type: 'rebreak',
        breakout_price: 104,
        vwap_pos_pct: 1.2,
        trigger: 60,
        breakout_hold_sec: 18,
        breakout_hold_has_fresh_trades: true,
        breakout_print_samples: threeDistinctPrints(104),
        last_trade_age_sec: 1,
    });
    const r = decide(input);
    assert(r.state === 'ACTIVE', 'E → ACTIVE despite +5%');
}

console.log('\n=== Off-hours: 不得顯示 ACTIVE ===');
{
    const input = baseFeatures({
        change_pct: 5.0,
        volume_accel: 25,
        return_30s: 0.25,
        return_1m: 0.45,
        breakout_type: 'breakout',
        breakout_hold_sec: 20,
        breakout_hold_has_fresh_trades: true,
        breakout_print_samples: threeDistinctPrints(),
    });
    const r = decide(input, { cashSession: false });
    assert(r.state === 'WATCH', 'off-hours → WATCH');
    assert(r.state !== 'ACTIVE', 'off-hours not ACTIVE');
}

console.log('\n=== Trigger alone cannot create EARLY ===');
{
    const r = decide(
        baseFeatures({
            volume_accel: 0,
            rank_velocity: 0,
            bp_slope: 0,
            return_30s: 0,
            return_1m: 0,
            trade_aggression: 10,
            trigger: 80,
            vwap_pos_pct: 0.5,
        }),
    );
    assert(r.state !== 'EARLY', 'Trigger alone ≠ EARLY');
}

{
    const f = buildAttackFeatures({
        c: null,
        bp: null,
        trigger: Number.NaN,
        changePct: Number.NaN,
        prevVwapPos: null,
    });
    assert(f.change_pct === null, 'NaN change → null');
}

console.log('\n=== F: ACTIVE 後 stale → WATCH／資料過舊（歷史欄位保留）===');
{
    const now = Date.now();
    const track = freshTrack({
        triggered_at_ms: now - 120_000,
        trigger_price: 100,
        state: 'ACTIVE',
        peak_price: 105,
        high_since_trigger: 105,
        last_valid_state: 'ACTIVE',
        breakout_confirmed_active: true,
        breakout_event_valid: true,
    });
    const input = baseFeatures({
        change_pct: 5,
        last_price: 105,
        volume_accel: 25,
        return_30s: 0.2,
        return_1m: 0.4,
        breakout_type: 'breakout',
        last_trade_age_sec: 30,
        quote_age_sec: 30,
        orderbook_age_sec: 30,
        volume_age_sec: 30,
    });
    const r = decide(input, { prev: track, nowMs: now });
    console.log('F →', r.state, r.label, 'last_valid=', r.last_valid_state);
    assert(r.state === 'WATCH', 'F → WATCH');
    assert(r.label === '資料過舊', 'F label 資料過舊');
    assert(r.state !== 'ACTIVE', 'F live state not ACTIVE');
    assert(r.data_stale === true, 'F data_stale');
    assert(r.last_valid_state === 'ACTIVE', 'F historical last_valid=ACTIVE');
    // Live presentation must not advertise 正在急攻
    assert(r.label !== '正在急攻', 'F badge not 正在急攻');
}

console.log('\n=== G: 60s STALLING → 90s EARLY_FAILED ===');
{
    const track60 = freshTrack({
        triggered_at_ms: Date.now() - 60_000,
        trigger_price: 100,
        state: 'EARLY',
        peak_price: 100.05,
        high_since_trigger: 100.05,
        last_ask_eating: false,
    });
    const flat = baseFeatures({
        change_pct: 1.0,
        last_price: 100.1,
        volume_accel: 8,
        rank_velocity: 2,
        return_30s: 0,
        return_1m: 0,
        ask_eating_raw: false,
        trade_aggression: 40,
        ask_replenish_heavy: false,
    });
    const r60 = decide(flat, { prev: track60, nowMs: Date.now() });
    assert(r60.state === 'STALLING', 'G60 → STALLING');
    const track90 = {
        ...r60.track!,
        triggered_at_ms: Date.now() - 90_000,
    };
    const r90 = decide(flat, { prev: track90, nowMs: Date.now() });
    assert(r90.state === 'EARLY_FAILED', 'G90 → EARLY_FAILED');
}

console.log('\n=== H: STALLING 後 75s 重新放量 → 可恢復 ===');
{
    const track = freshTrack({
        triggered_at_ms: Date.now() - 75_000,
        trigger_price: 100,
        state: 'STALLING',
        peak_price: 100.1,
        high_since_trigger: 100.1,
        stalling_since_ms: Date.now() - 15_000,
        last_valid_state: 'STALLING',
    });
    const input = baseFeatures({
        change_pct: 1.5,
        last_price: 101.2,
        volume_accel: 24,
        rank_velocity: 10,
        ask_eating_raw: true,
        trade_aggression: 70,
        return_30s: 0.3,
        return_1m: 0.4,
        vwap_pos_pct: 0.5,
        breakout_type: 'breakout',
        breakout_price: 101,
    });
    const r = decide(input, { prev: track, nowMs: Date.now() });
    assert(
        r.state === 'EARLY' || r.state === 'PRE_ATTACK' || r.state === 'ACTIVE',
        'H recovers',
    );
    assert(r.state !== 'EARLY_FAILED', 'H not FAILED');
}

console.log('\n=== I: 單筆突破 → 確認中；跌回 → 假突破（非 ACTIVE 後失敗）===');
{
    const now = Date.now();
    // Step 1: open pending breakout event
    const pending = decide(
        baseFeatures({
            change_pct: 2.0,
            last_price: 101.2,
            volume_accel: 20,
            return_30s: 0.1,
            return_1m: 0.4,
            breakout_type: 'breakout',
            breakout_price: 101,
            prints_above_breakout: 1,
            breakout_hold_sec: 0,
            last_trade_key: 'only1',
            last_trade_ts_ms: now,
            last_trade_age_sec: 1,
        }),
        { nowMs: now },
    );
    console.log('I1 pending →', pending.state, pending.label);
    assert(pending.state !== 'ACTIVE', 'I1 not ACTIVE');
    assert(
        pending.label === '突破確認中' || pending.state === 'PRE_ATTACK',
        'I1 突破確認中',
    );
    assert(pending.track?.breakout_event_valid === true, 'I1 event recorded');
    assert(
        pending.track?.breakout_confirmed_active !== true,
        'I1 not yet ACTIVE-confirmed',
    );

    // Step 2: fall back within 30s → FAKE_BREAKOUT
    const fake = decide(
        baseFeatures({
            change_pct: 1.8,
            last_price: 100.5,
            volume_accel: 18,
            return_30s: -0.15,
            return_1m: 0.2,
            breakout_type: 'breakout',
            breakout_price: 101,
            sell_aggression_up: true,
            last_trade_age_sec: 1,
        }),
        { prev: pending.track, nowMs: now + 5_000 },
    );
    console.log('I2 fake →', fake.state, fake.label);
    assert(fake.state === 'FAKE_BREAKOUT', 'I2 → FAKE_BREAKOUT');
    assert(fake.state !== 'ACTIVE', 'I2 not ACTIVE');

    // Step 3: ACTIVE 後失敗 → WEAKENING（不是假突破）
    const afterActive = freshTrack({
        triggered_at_ms: now - 60_000,
        trigger_price: 100,
        state: 'ACTIVE',
        peak_price: 103,
        high_since_trigger: 103,
        breakout_price: 101,
        breakout_at_ms: now - 40_000,
        breakout_event_valid: true,
        breakout_confirmed_active: true,
        last_valid_state: 'ACTIVE',
    });
    const weaken = decide(
        baseFeatures({
            change_pct: 2.0,
            last_price: 100.4,
            return_30s: -0.2,
            return_1m: -0.1,
            breakout_type: 'breakout',
            breakout_price: 101,
            sell_aggression_up: true,
            volume_accel: 10,
        }),
        { prev: afterActive, nowMs: now },
    );
    console.log('I3 ACTIVE-fail →', weaken.state, weaken.label);
    assert(weaken.state === 'WEAKENING', 'I3 ACTIVE後失敗 → WEAKENING');
    assert(weaken.state !== 'FAKE_BREAKOUT', 'I3 not FAKE_BREAKOUT');
}

console.log('\n=== J: 三筆不同時間成交站上＋放量 → ACTIVE ===');
{
    const samples = threeDistinctPrints(101);
    assert(countDistinctBreakoutPrints(samples) === 3, 'J distinct=3');
    // Same key resend must not count as 3
    assert(
        countDistinctBreakoutPrints([
            { trade_key: 'x', ts_ms: 1000, price: 102 },
            { trade_key: 'x', ts_ms: 1000, price: 102 },
            { trade_key: 'x', ts_ms: 1000, price: 102 },
        ]) === 1,
        'J duplicate keys count as 1',
    );
    const input = baseFeatures({
        change_pct: 2.2,
        last_price: 102,
        volume_accel: 22,
        return_30s: 0.25,
        return_1m: 0.45,
        breakout_type: 'breakout',
        breakout_price: 101,
        breakout_print_samples: samples,
        breakout_hold_sec: 16,
        breakout_hold_has_fresh_trades: true,
        best_bid_lift: true,
        last_trade_age_sec: 1,
    });
    const r = decide(input);
    assert(r.state === 'ACTIVE', 'J → ACTIVE');
}

console.log('\n=== Hold clock-only without fresh trades → 不得 ACTIVE ===');
{
    const input = baseFeatures({
        change_pct: 2.5,
        last_price: 102,
        volume_accel: 22,
        return_30s: 0.2,
        return_1m: 0.5,
        breakout_type: 'breakout',
        breakout_price: 101,
        breakout_hold_sec: 20, // clock only
        breakout_hold_has_fresh_trades: false,
        breakout_print_samples: [],
        last_trade_age_sec: 2,
        sell_aggression_up: false,
    });
    const ok = isBreakoutPersistent(
        DEFAULT_RESCUE_CONFIG,
        input,
        null,
        Date.now(),
    );
    assert(ok === false, 'clock-only hold ≠ persistent');
    const r = decide(input);
    assert(r.state !== 'ACTIVE', 'clock-only → not ACTIVE');
}

console.log('\n=== K: quality↓ 於 90s 前 → WEAKENING；90s 平坦 → FAILED ===');
{
    const q = computeAskEatingQuality(
        baseFeatures({
            ask_eating_raw: true,
            trade_aggression: 85,
            return_30s: 0,
            return_1m: 0,
            volume_accel: 30,
            ask_replenish_heavy: true,
        }),
    );
    assert(q < 50, 'K quality < 50');

    // 30s after trigger: quality collapse → WEAKENING, not EARLY_FAILED
    const track30 = freshTrack({
        triggered_at_ms: Date.now() - 30_000,
        trigger_price: 100,
        state: 'EARLY',
        peak_price: 100.05,
        high_since_trigger: 100.05,
    });
    const bad = baseFeatures({
        change_pct: 1.0,
        last_price: 100.1,
        ask_eating_raw: true,
        trade_aggression: 85,
        return_30s: 0,
        return_1m: 0,
        volume_accel: 30,
        ask_replenish_heavy: true,
        rank_velocity: 2,
        vwap_pos_pct: 0.1,
    });
    const r30 = decide(bad, { prev: track30, nowMs: Date.now() });
    console.log('K@30s →', r30.state, r30.label, 'q=', r30.ask_eating_quality);
    assert(r30.state === 'WEAKENING', 'K@30s → WEAKENING (not FAILED)');
    assert(r30.state !== 'EARLY_FAILED', 'K@30s not EARLY_FAILED');

    // 90s flat still allows EARLY_FAILED (quality path already left EARLY;
    // use STALLING track without ultra-low askQ path — use moderate aggression)
    const track90 = freshTrack({
        triggered_at_ms: Date.now() - 90_000,
        trigger_price: 100,
        state: 'STALLING',
        peak_price: 100.05,
        high_since_trigger: 100.05,
        stalling_since_ms: Date.now() - 30_000,
    });
    const flat90 = baseFeatures({
        change_pct: 1.0,
        last_price: 100.1,
        volume_accel: 8,
        rank_velocity: 2,
        return_30s: 0,
        return_1m: 0,
        ask_eating_raw: false,
        trade_aggression: 40,
        ask_replenish_heavy: false,
    });
    const r90 = decide(flat90, { prev: track90, nowMs: Date.now() });
    console.log('K@90s flat →', r90.state, r90.label);
    assert(r90.state === 'EARLY_FAILED', 'K@90s flat → EARLY_FAILED');
}

console.log('\n=== L: 突破後 15 秒但期間無新成交 → 不得 ACTIVE ===');
{
    const now = Date.now();
    const boAt = now - 15_000;
    const track = freshTrack({
        triggered_at_ms: now - 20_000,
        trigger_price: 100,
        state: 'PRE_ATTACK',
        peak_price: 101.2,
        high_since_trigger: 101.2,
        breakout_price: 101,
        breakout_at_ms: boAt,
        breakout_event_valid: true,
        breakout_confirmed_active: false,
        last_ask_eating: false,
        // Only the breakout print itself — no newer trades after breakout
        distinct_print_keys: [`${boAt}|0|101.2`],
        last_trade_key: `${boAt}|0|101.2`,
        last_fresh_trade_ms: boAt,
    });
    const input = {
        change_pct: 2.2,
        last_price: 101.2,
        volume_accel: 22,
        return_30s: 0.1,
        return_1m: 0.4,
        breakout_type: 'breakout',
        breakout_price: 101,
        breakout_hold_sec: 15,
        breakout_hold_has_fresh_trades: false,
        breakout_print_samples: [],
        ask_eating_raw: false,
        ask_replenish_heavy: false,
        trade_aggression: 55,
        // Trade age still within quote TTL (not DATA_STALE), but no NEW prints after breakout
        last_trade_age_sec: 10,
        quote_age_sec: 2,
        orderbook_age_sec: 2,
        volume_age_sec: 2,
        last_trade_key: `${boAt}|0|101.2`,
        last_trade_ts_ms: boAt,
        last_trade_seq: 0,
        sell_aggression_up: false,
    };
    const expected = 'not ACTIVE (hold without new prints)';
    const persistent = isBreakoutPersistent(
        DEFAULT_RESCUE_CONFIG,
        baseFeatures(input),
        track,
        now,
    );
    const r = decide(baseFeatures(input), { prev: track, nowMs: now });
    console.log('L input', {
        hold_sec: 15,
        last_trade_age_sec: 10,
        new_prints_after_breakout: 0,
    });
    console.log(
        'L expected',
        expected,
        'persistent=',
        persistent,
        '實際',
        r.state,
        r.label,
    );
    assert(persistent === false, 'L not persistent');
    assert(r.state !== 'ACTIVE', 'L → not ACTIVE');
    assert(r.label !== '正在急攻', 'L not 正在急攻');
}

console.log('\n=== M: 同一筆成交重送三次 → 不得當連續三筆 ===');
{
    const dup = [
        { trade_key: 'TID-9', ts_ms: 5_000, price: 102 },
        { trade_key: 'TID-9', ts_ms: 5_000, price: 102 },
        { trade_key: 'TID-9', ts_ms: 5_000, price: 102 },
    ];
    const n = countDistinctBreakoutPrints(dup);
    const input = {
        change_pct: 2.5,
        last_price: 102,
        volume_accel: 22,
        return_30s: 0.2,
        return_1m: 0.45,
        breakout_type: 'breakout',
        breakout_price: 101,
        breakout_print_samples: dup,
        breakout_hold_sec: 20,
        breakout_hold_has_fresh_trades: true, // flag alone must not promote
        last_trade_age_sec: 1,
        last_trade_key: 'TID-9',
        last_trade_ts_ms: 5_000,
    };
    const expected = 'distinct=1, not ACTIVE';
    const r = decide(baseFeatures(input));
    console.log('M input samples=3x same TID-9, expected', expected);
    console.log('M actual distinct=', n, 'state=', r.state);
    assert(n === 1, 'M distinct count = 1');
    assert(r.state !== 'ACTIVE', 'M not ACTIVE');
}

console.log('\n=== N: 三筆不同時間站上＋量價向上 → ACTIVE ===');
{
    const samples = [
        { trade_key: 'A1', ts_ms: 1_000, price: 101.5 },
        { trade_key: 'A2', ts_ms: 4_000, price: 101.8 },
        { trade_key: 'A3', ts_ms: 8_000, price: 102.2 },
    ];
    const input = {
        change_pct: 2.3,
        last_price: 102.2,
        volume_accel: 24,
        return_30s: 0.28,
        return_1m: 0.5,
        breakout_type: 'breakout',
        breakout_price: 101,
        breakout_print_samples: samples,
        last_trade_age_sec: 1,
        last_trade_key: 'A3',
        last_trade_ts_ms: 8_000,
        sell_aggression_up: false,
    };
    const expected = 'ACTIVE';
    const r = decide(baseFeatures(input));
    console.log('N input', { samples: 3, vol: 24, ret_1m: 0.5 });
    console.log('N expected', expected, '實際', r.state, r.label);
    assert(countDistinctBreakoutPrints(samples) === 3, 'N distinct=3');
    assert(r.state === 'ACTIVE', 'N → ACTIVE');
}

console.log('\n=== O: 30s 內跌回＋賣壓 → FAKE_BREAKOUT + cooldown ===');
{
    const now = Date.now();
    const track = freshTrack({
        triggered_at_ms: now - 20_000,
        trigger_price: 100,
        state: 'PRE_ATTACK',
        peak_price: 101.5,
        high_since_trigger: 101.5,
        breakout_price: 101,
        breakout_at_ms: now - 10_000,
        breakout_event_valid: true,
        breakout_confirmed_active: false,
        distinct_print_keys: ['p1'],
        last_valid_state: 'PRE_ATTACK',
    });
    const input = {
        change_pct: 1.5,
        last_price: 100.6,
        volume_accel: 15,
        return_30s: -0.2,
        return_1m: 0.1,
        breakout_type: 'breakout',
        breakout_price: 101,
        sell_aggression_up: true,
        last_trade_age_sec: 1,
    };
    const expected = 'FAKE_BREAKOUT + cooldown';
    const r = decide(baseFeatures(input), { prev: track, nowMs: now });
    console.log('O input', input);
    console.log(
        'O expected',
        expected,
        '實際',
        r.state,
        'cooldown_until',
        r.track?.cooldown_until_ms,
    );
    assert(r.state === 'FAKE_BREAKOUT', 'O → FAKE_BREAKOUT');
    assert(
        (r.track?.cooldown_until_ms ?? 0) > now,
        'O cooldown started',
    );
}

console.log('\n=== P: ACTIVE 後資料過期 → 主狀態非 ACTIVE；last_valid 可保留 ===');
{
    const now = Date.now();
    const track = freshTrack({
        triggered_at_ms: now - 120_000,
        trigger_price: 100,
        state: 'ACTIVE',
        peak_price: 106,
        high_since_trigger: 106,
        last_valid_state: 'ACTIVE',
        breakout_confirmed_active: true,
        breakout_event_valid: true,
        breakout_price: 101,
        breakout_at_ms: now - 90_000,
    });
    const input = {
        change_pct: 5,
        last_price: 106,
        volume_accel: 25,
        return_30s: 0.2,
        return_1m: 0.4,
        breakout_type: 'breakout',
        last_trade_age_sec: 35,
        quote_age_sec: 35,
        orderbook_age_sec: 35,
        volume_age_sec: 35,
    };
    const expected = 'WATCH/資料過舊, live≠ACTIVE, last_valid=ACTIVE';
    const r = decide(baseFeatures(input), { prev: track, nowMs: now });
    console.log('P input ages=35s prev=ACTIVE');
    console.log(
        'P expected',
        expected,
        '實際',
        r.state,
        r.label,
        'last_valid=',
        r.last_valid_state,
    );
    assert(r.state === 'WATCH', 'P live state WATCH');
    assert(r.label === '資料過舊', 'P label 資料過舊');
    assert(r.state !== 'ACTIVE', 'P not ACTIVE');
    assert(r.data_stale === true, 'P data_stale');
    assert(r.last_valid_state === 'ACTIVE', 'P historical last_valid');
}

console.log('\n=== Q: quality=0 僅過 20s → WEAKENING，不得 EARLY_FAILED ===');
{
    const now = Date.now();
    const track = freshTrack({
        triggered_at_ms: now - 20_000,
        trigger_price: 100,
        state: 'EARLY',
        peak_price: 100.1,
        high_since_trigger: 100.1,
        last_ask_eating: true,
    });
    const input = {
        change_pct: 1.0,
        last_price: 100.1,
        ask_eating_raw: true,
        trade_aggression: 90,
        return_30s: 0,
        return_1m: 0,
        volume_accel: 28,
        ask_replenish_heavy: true,
        rank_velocity: 2,
        vwap_pos_pct: 0.1,
    };
    const expected = 'WEAKENING (not EARLY_FAILED)';
    const r = decide(baseFeatures(input), { prev: track, nowMs: now });
    console.log('Q input age=20s quality→0');
    console.log(
        'Q expected',
        expected,
        '實際',
        r.state,
        r.label,
        'q=',
        r.ask_eating_quality,
    );
    assert(r.ask_eating_quality < 25, 'Q quality low');
    assert(r.state === 'WEAKENING', 'Q → WEAKENING');
    assert(r.state !== 'EARLY_FAILED', 'Q not EARLY_FAILED');
}

console.log('\nattack-state A–K + L–Q checks done');
