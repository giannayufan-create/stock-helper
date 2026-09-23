// server/src/lib/radar-rescue/attack-state.ts
// EARLY / PRE_ATTACK / ACTIVE state machine — Decision Support only.
// NEVER mutates A/B/C / BP production scores.
// Round-2: stale guard, STALLING, ACTIVE persistence, FAKE_BREAKOUT,
// ask_eating_quality, push_efficiency, cooldown.

import type { BuyPressureItem } from '../buy-pressure/types.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';
import type { RadarRescueConfig } from './config.ts';
import type { RescueRadarState } from './types.ts';

export type AccelEvidenceKey =
    | 'VOLUME_ACCEL'
    | 'RANK_VELOCITY'
    | 'BP_SLOPE_UP'
    | 'BUY_SURGE'
    | 'ASK_EATING'
    | 'PRICE_SLOPE_1M'
    | 'TRADE_FREQ_UP'
    | 'TRIGGER';

export type PriceConfirmKey =
    | 'ABOVE_VWAP'
    | 'VWAP_RECLAIM'
    | 'BREAK_RECENT_HIGH'
    | 'PRINTS_LIFTING'
    | 'ASK_EATING_PRICE_UP';

export interface BreakoutPrintSample {
    /** Unique trade identity — same resend must reuse the same key. */
    trade_key: string;
    ts_ms: number;
    price: number;
}

export interface AttackFeatures {
    change_pct: number | null;
    last_price: number | null;
    vwap_pos_pct: number | null;
    prev_vwap_pos_pct: number | null;
    volume_accel: number | null;
    rank_velocity: number | null;
    bp_slope: number | null;
    buy_surge: boolean;
    ask_eating_raw: boolean;
    trade_aggression: number | null;
    trade_aggression_available: boolean;
    return_30s: number | null;
    return_1m: number | null;
    return_3m: number | null;
    breakout_type: string | null;
    trigger: number;
    near_limit: boolean;
    limit_up: boolean;
    /** Age of last trade / quote / orderbook / volume (seconds). */
    last_trade_age_sec: number | null;
    quote_age_sec: number | null;
    orderbook_age_sec: number | null;
    volume_age_sec: number | null;
    /** Breakout persistence inputs (tick-level or proxies). */
    breakout_price: number | null;
    /**
     * @deprecated Prefer breakout_print_samples — raw count is ignored for ACTIVE
     * unless backed by distinct samples / track keys.
     */
    prints_above_breakout: number;
    /** Distinct actual trades above breakout (different trade_key + ts). */
    breakout_print_samples: BreakoutPrintSample[];
    /** Seconds clock time above breakout — insufficient alone for ACTIVE. */
    breakout_hold_sec: number | null;
    /**
     * Hold window had fresh distinct trades (production sets via track;
     * tests may set explicitly).
     */
    breakout_hold_has_fresh_trades: boolean;
    last_trade_key: string | null;
    last_trade_ts_ms: number | null;
    /** Sequence within the same millisecond (for ts+seq dedupe). */
    last_trade_seq: number | null;
    best_bid_lift: boolean;
    sell_aggression_up: boolean;
    /** Ask constantly refilled — eats lots but price stuck. */
    ask_replenish_heavy: boolean;
}

export interface EarlyTrack {
    symbol: string;
    triggered_at_ms: number;
    trigger_price: number;
    trigger_change_pct: number | null;
    state: RescueRadarState;
    peak_price: number;
    high_since_trigger: number;
    last_ask_eating: boolean;
    /** Historical only — never drives live UI badge / sort / push. */
    last_valid_state: RescueRadarState;
    cooldown_until_ms: number;
    stalling_since_ms: number | null;
    breakout_price: number | null;
    breakout_at_ms: number | null;
    /** A valid breakout event was opened (pending confirmation). */
    breakout_event_valid: boolean;
    /** This breakout event already confirmed ACTIVE once. */
    breakout_confirmed_active: boolean;
    prints_above_breakout: number;
    /** Distinct trade keys counted above breakout (deduped). */
    distinct_print_keys: string[];
    last_trade_key: string | null;
    last_fresh_trade_ms: number | null;
    attack_score_at_fail: number;
    failed_at_ms: number | null;
}

export interface AttackDecision {
    state: RescueRadarState;
    label: string;
    accel_evidence: AccelEvidenceKey[];
    price_confirm: PriceConfirmKey[];
    pre_plus3: boolean;
    true_ask_eating: boolean;
    ask_eating_quality: number;
    push_efficiency: number;
    attack_score: number;
    data_stale: boolean;
    last_valid_state: RescueRadarState | null;
    reasons: string[];
    track: EarlyTrack | null;
}

function nz(v: number | null | undefined, fallback = 0): number {
    return v == null || Number.isNaN(v) ? fallback : v;
}

function finite(v: number | null | undefined): number | null {
    if (v == null || Number.isNaN(v) || !Number.isFinite(v)) return null;
    return v;
}

function clamp(n: number, lo = 0, hi = 100): number {
    return Math.max(lo, Math.min(hi, n));
}

function ageSec(iso: string | null | undefined, nowMs: number): number | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return Math.max(0, (nowMs - t) / 1000);
}

export function quoteStaleSec(cfg: RadarRescueConfig): number {
    return cfg.attack_quote_stale_sec ?? 12;
}

export function metricStaleSec(cfg: RadarRescueConfig): number {
    return cfg.attack_metric_stale_sec ?? 45;
}

export function cooldownSec(cfg: RadarRescueConfig): number {
    return cfg.attack_cooldown_sec ?? 45;
}

/** Key quote/trade > TTL or volume metric too old → cannot claim live attack. */
export function isAttackDataStale(
    cfg: RadarRescueConfig,
    f: AttackFeatures,
): boolean {
    const qTtl = quoteStaleSec(cfg);
    const mTtl = metricStaleSec(cfg);
    const quoteAges = [
        f.last_trade_age_sec,
        f.quote_age_sec,
        f.orderbook_age_sec,
    ]
        .map(finite)
        .filter((x): x is number => x != null);
    if (quoteAges.some((a) => a > qTtl)) return true;
    const volAge = finite(f.volume_age_sec);
    if (volAge != null && volAge > mTtl) return true;
    return false;
}

/** ASK_EATING must be real aggression + price lifting — not thick bids alone. */
export function isTrueAskEating(f: AttackFeatures): boolean {
    if (!f.ask_eating_raw) return false;
    if (!f.trade_aggression_available) return false;
    if (nz(f.trade_aggression) < 45) return false;
    const slope1m = finite(f.return_1m);
    const slope30 = finite(f.return_30s);
    const lifting =
        (slope1m != null && slope1m > 0) ||
        (slope30 != null && slope30 > 0);
    if (!lifting) return false;
    return true;
}

/**
 * 0–100 quality of ask eating.
 * High aggression + price lift + vol → high; eat without push / refill → low.
 */
export function computeAskEatingQuality(f: AttackFeatures): number {
    let q = 0;
    if (!f.ask_eating_raw && !isTrueAskEating(f)) {
        // Still score weak aggression context for UI.
        q = nz(f.trade_aggression) * 0.35;
        return clamp(q);
    }
    q += nz(f.trade_aggression) * 0.45;
    if (f.ask_eating_raw) q += 12;
    if (isTrueAskEating(f)) q += 18;
    q += clamp(nz(f.return_30s) * 80, 0, 20);
    q += clamp(nz(f.return_1m) * 40, 0, 15);
    q += clamp(nz(f.volume_accel) * 0.35, 0, 15);
    // Penalty: eating but price stuck / ask refill wall.
    if (f.ask_eating_raw && nz(f.return_1m) <= 0 && nz(f.return_30s) <= 0) {
        q -= 40;
    }
    if (f.ask_replenish_heavy) q -= 25;
    if (f.sell_aggression_up) q -= 10;
    return clamp(Math.round(q));
}

/**
 * Price push per unit of volume effort.
 * High volume + flat price → low; modest volume + fast lift → high.
 */
export function computePushEfficiency(f: AttackFeatures): number {
    const pricePush =
        Math.max(0, nz(f.return_30s)) * 1.4 + Math.max(0, nz(f.return_1m));
    const volEffort = Math.max(0.15, nz(f.volume_accel) / 20);
    const aggression = Math.max(0.2, nz(f.trade_aggression) / 50);
    const raw = (pricePush / volEffort / aggression) * 28;
    let e = clamp(Math.round(raw));
    if (nz(f.volume_accel) >= 20 && pricePush < 0.05) e = Math.min(e, 18);
    if (pricePush >= 0.4 && nz(f.volume_accel) < 30) e = Math.max(e, 70);
    return e;
}

export function computeAttackScore(
    f: AttackFeatures,
    askQ: number,
    pushE: number,
): number {
    return clamp(
        Math.round(
            nz(f.return_1m) * 40 +
                nz(f.return_30s) * 30 +
                nz(f.volume_accel) * 0.6 +
                nz(f.rank_velocity) * 1.2 +
                askQ * 0.25 +
                pushE * 0.2 +
                f.trigger * 0.15,
        ),
    );
}

export function collectAccelEvidence(
    cfg: RadarRescueConfig,
    f: AttackFeatures,
): AccelEvidenceKey[] {
    const out: AccelEvidenceKey[] = [];
    if (nz(f.volume_accel) >= cfg.pre_plus3_min_vol_accel) {
        out.push('VOLUME_ACCEL');
    }
    if (nz(f.rank_velocity) >= 5) out.push('RANK_VELOCITY');
    if (nz(f.bp_slope) > 0) out.push('BP_SLOPE_UP');
    if (f.buy_surge) out.push('BUY_SURGE');
    if (isTrueAskEating(f)) out.push('ASK_EATING');
    if (nz(f.return_1m) > 0) out.push('PRICE_SLOPE_1M');
    if (
        f.trade_aggression_available &&
        nz(f.trade_aggression) >= 50 &&
        nz(f.volume_accel) >= cfg.pre_plus3_min_vol_accel * 0.75
    ) {
        out.push('TRADE_FREQ_UP');
    }
    if (f.trigger >= cfg.pre_plus3_min_trigger) out.push('TRIGGER');
    return out;
}

export function collectPriceConfirm(f: AttackFeatures): PriceConfirmKey[] {
    const out: PriceConfirmKey[] = [];
    const vwap = finite(f.vwap_pos_pct);
    const prevVwap = finite(f.prev_vwap_pos_pct);
    if (vwap != null && vwap >= 0) out.push('ABOVE_VWAP');
    if (vwap != null && vwap >= 0 && prevVwap != null && prevVwap < 0) {
        out.push('VWAP_RECLAIM');
    }
    const bt = (f.breakout_type ?? '').toLowerCase();
    if (bt === 'breakout' || bt === 'rebreak') {
        out.push('BREAK_RECENT_HIGH');
    } else if (
        nz(f.return_1m) > 0.25 &&
        nz(f.return_1m) >= nz(f.return_3m) &&
        nz(f.return_30s) > 0
    ) {
        out.push('BREAK_RECENT_HIGH');
    }
    if (nz(f.return_30s) > 0 && nz(f.return_1m) > 0) {
        out.push('PRINTS_LIFTING');
    }
    if (isTrueAskEating(f) && nz(f.return_30s) > 0 && nz(f.return_1m) > 0) {
        out.push('ASK_EATING_PRICE_UP');
    }
    return [...new Set(out)];
}

export function accelPassesForEarly(evidence: AccelEvidenceKey[]): boolean {
    if (evidence.length < 2) return false;
    if (evidence.length === 1 && evidence[0] === 'TRIGGER') return false;
    if (
        evidence.length === 2 &&
        evidence.includes('TRIGGER') &&
        evidence.every((e) => e === 'TRIGGER')
    ) {
        return false;
    }
    return true;
}

function isBreakoutSignal(f: AttackFeatures): boolean {
    const bt = (f.breakout_type ?? '').toLowerCase();
    return (
        bt === 'breakout' ||
        bt === 'rebreak' ||
        (nz(f.return_1m) > 0.35 && nz(f.volume_accel) >= 15)
    );
}

/** Build stable trade identity: prefer trade_id / key, else ts_ms|seq|price. */
export function makeTradeKey(opts: {
    trade_key?: string | null;
    ts_ms?: number | null;
    seq?: number | null;
    price?: number | null;
}): string | null {
    if (opts.trade_key && opts.trade_key.length > 0) return opts.trade_key;
    const ts = opts.ts_ms;
    if (ts == null || !Number.isFinite(ts)) return null;
    const seq = opts.seq != null && Number.isFinite(opts.seq) ? opts.seq : 0;
    const px =
        opts.price != null && Number.isFinite(opts.price)
            ? opts.price
            : 0;
    return `${ts}|${seq}|${px}`;
}

/** Count distinct trade_key samples with distinct timestamps (min 50ms apart). */
export function countDistinctBreakoutPrints(
    samples: BreakoutPrintSample[] | undefined | null,
): number {
    if (!samples?.length) return 0;
    const seen = new Set<string>();
    let lastTs = -Infinity;
    let n = 0;
    const sorted = [...samples].sort((a, b) => a.ts_ms - b.ts_ms);
    for (const s of sorted) {
        const key = makeTradeKey({
            trade_key: s.trade_key,
            ts_ms: s.ts_ms,
            price: s.price,
        });
        if (!key || seen.has(key)) continue;
        if (s.ts_ms - lastTs < 50) continue; // same-batch / duplicate clock
        seen.add(key);
        lastTs = s.ts_ms;
        n += 1;
    }
    return n;
}

function priceHeldAboveBreakout(
    f: AttackFeatures,
    track: EarlyTrack | null,
): boolean {
    const bo =
        finite(f.breakout_price) ?? finite(track?.breakout_price ?? null);
    const px = finite(f.last_price);
    if (bo == null || px == null) return false;
    return px >= bo;
}

function noSignificantSellPressure(f: AttackFeatures): boolean {
    if (f.sell_aggression_up) return false;
    if (nz(f.return_30s) < -0.05) return false;
    return true;
}

function hasFreshTradeNow(
    cfg: RadarRescueConfig,
    f: AttackFeatures,
): boolean {
    const age = finite(f.last_trade_age_sec);
    if (age == null) return false;
    return age <= quoteStaleSec(cfg);
}

/**
 * True only when ≥1 distinct trade landed AFTER breakout_at (not clock alone).
 */
function hadFreshTradesDuringHold(
    f: AttackFeatures,
    track: EarlyTrack | null,
    nowMs: number,
    quoteTtlSec: number,
): boolean {
    const fromSamples = countDistinctBreakoutPrints(f.breakout_print_samples);
    if (fromSamples >= 2) return true;
    const fromTrack = track?.distinct_print_keys?.length ?? 0;
    if (fromTrack >= 2) return true;
    if (
        track?.breakout_at_ms != null &&
        track.last_fresh_trade_ms != null &&
        track.last_fresh_trade_ms > track.breakout_at_ms &&
        nowMs - track.last_fresh_trade_ms <= quoteTtlSec * 1000
    ) {
        return true;
    }
    return false;
}

/**
 * ACTIVE persistence:
 * A) ≥3 distinct-time actual trades above breakout
 * B) ≥15s hold WITH fresh trades after breakout, price above, no sell pressure
 * C) best_bid lift + price progression + ≥2 distinct fresh prints
 * Clock-only hold / flag-only / duplicate resends do NOT qualify.
 */
export function isBreakoutPersistent(
    cfg: RadarRescueConfig,
    f: AttackFeatures,
    track: EarlyTrack | null,
    nowMs: number,
): boolean {
    const needPrints = cfg.attack_breakout_prints ?? 3;
    const needHold = cfg.attack_breakout_hold_sec ?? 15;
    const qTtl = quoteStaleSec(cfg);

    if (!priceHeldAboveBreakout(f, track)) return false;
    if (!noSignificantSellPressure(f)) return false;
    if (!hasFreshTradeNow(cfg, f)) return false;

    // A: distinct prints
    const fromSamples = countDistinctBreakoutPrints(f.breakout_print_samples);
    const fromTrack = track?.distinct_print_keys?.length ?? 0;
    if (Math.max(fromSamples, fromTrack) >= needPrints) return true;

    // B: hold ≥15s — time alone is NOT enough; need fresh trades during hold
    const holdFeat = finite(f.breakout_hold_sec);
    const holdFromTrack =
        track?.breakout_at_ms != null
            ? (nowMs - track.breakout_at_ms) / 1000
            : null;
    const holdSec = holdFeat ?? holdFromTrack;
    if (
        holdSec != null &&
        holdSec >= needHold &&
        hadFreshTradesDuringHold(f, track, nowMs, qTtl)
    ) {
        return true;
    }

    // C: bid lift + progression + ≥2 distinct prints
    if (
        f.best_bid_lift &&
        nz(f.return_30s) > 0 &&
        nz(f.return_1m) > 0 &&
        Math.max(fromSamples, fromTrack) >= 2
    ) {
        return true;
    }

    return false;
}

/**
 * FAKE_BREAKOUT only after a recorded valid breakout event that never
 * confirmed ACTIVE. ACTIVE-then-fail is WEAKENING, not FAKE.
 * No event → 突破未成立 (caller keeps 突破確認中 / WATCH).
 */
export function isFakeBreakout(
    f: AttackFeatures,
    track: EarlyTrack | null,
    nowMs: number,
): boolean {
    if (!track?.breakout_event_valid) return false;
    if (track.breakout_confirmed_active) return false; // ACTIVE 後失敗 ≠ 假突破
    if (track.breakout_at_ms == null || track.breakout_price == null) {
        return false;
    }
    const age = nowMs - track.breakout_at_ms;
    if (age > 30_000) return false;
    const px = finite(f.last_price);
    if (px == null) return false;
    if (px >= track.breakout_price) return false;
    return f.sell_aggression_up || nz(f.return_30s) < 0;
}

/** Merge a fresh distinct trade into the breakout confirmation accumulator. */
export function absorbBreakoutPrint(
    track: EarlyTrack,
    f: AttackFeatures,
    nowMs: number,
    quoteTtlSec: number,
): EarlyTrack {
    const bo = track.breakout_price;
    const px = finite(f.last_price);
    if (bo == null || px == null || px < bo) {
        return { ...track, prints_above_breakout: 0 };
    }
    const age = finite(f.last_trade_age_sec);
    if (age == null || age > quoteTtlSec) return track;

    const key = makeTradeKey({
        trade_key: f.last_trade_key,
        ts_ms: f.last_trade_ts_ms,
        seq: f.last_trade_seq,
        price: px,
    });
    if (!key) return track;
    if (track.distinct_print_keys.includes(key)) return track;
    if (track.last_trade_key === key) return track;

    const ts = f.last_trade_ts_ms ?? nowMs;
    // Reject near-duplicate timestamps (batch resend of same price)
    const lastKey =
        track.distinct_print_keys[track.distinct_print_keys.length - 1];
    if (lastKey) {
        const parts = lastKey.split('|');
        const lastTsPart = Number(parts[0]);
        if (
            Number.isFinite(lastTsPart) &&
            Math.abs(ts - lastTsPart) < 50 &&
            (lastKey === key || lastKey.endsWith(`|${px}`))
        ) {
            return track;
        }
    }

    const keys = [...track.distinct_print_keys, key].slice(-12);
    return {
        ...track,
        distinct_print_keys: keys,
        prints_above_breakout: keys.length,
        last_trade_key: key,
        last_fresh_trade_ms: ts,
    };
}

function isFlatAfterTrigger(
    f: AttackFeatures,
    track: EarlyTrack,
): boolean {
    const px = finite(f.last_price);
    if (px == null || track.trigger_price <= 0) return false;
    const movePct =
        ((px - track.trigger_price) / track.trigger_price) * 100;
    const madeNewHigh =
        track.high_since_trigger >= track.trigger_price * 1.003;
    return !madeNewHigh && movePct < 0.3;
}

function hasPriceReaccel(f: AttackFeatures): boolean {
    return (
        isTrueAskEating(f) &&
        nz(f.return_30s) > 0 &&
        nz(f.return_1m) > 0 &&
        nz(f.volume_accel) >= 12
    );
}

function isPreAttack(
    f: AttackFeatures,
    trueAsk: boolean,
    askQ: number,
): boolean {
    const volStrong = nz(f.volume_accel) >= 20;
    const lifting = nz(f.return_30s) > 0 && nz(f.return_1m) > 0;
    return volStrong && trueAsk && lifting && askQ >= 50;
}

function isActiveCandidate(f: AttackFeatures, cashSession: boolean): boolean {
    if (!cashSession) return false;
    const volAgain = nz(f.volume_accel) >= 15;
    const lifting = nz(f.return_30s) > 0 && nz(f.return_1m) > 0;
    return isBreakoutSignal(f) && volAgain && lifting;
}

export function buildAttackFeatures(opts: {
    c: IntradayRankItem | null;
    bp: BuyPressureItem | null;
    trigger: number;
    changePct: number | null;
    prevVwapPos: number | null;
    bpRising?: boolean;
    nowMs?: number;
    /** Optional overrides for tests / tick feed. */
    overrides?: Partial<AttackFeatures>;
}): AttackFeatures {
    const c = opts.c;
    const bp = opts.bp;
    const m = c?.metrics;
    const now = opts.nowMs ?? Date.now();
    const change =
        finite(opts.changePct) ??
        finite(c?.change_pct) ??
        finite(bp?.change_pct);
    const last = finite(c?.last_price) ?? finite(bp?.last_price);
    const buySurge =
        bp?.primary_state === 'BUY_SURGE' ||
        !!bp?.states?.includes('BUY_SURGE');
    const askRaw =
        bp?.primary_state === 'ASK_EATING' ||
        !!bp?.states?.includes('ASK_EATING');
    const nearLimit =
        (change != null && change >= 8.5) ||
        !!c?.risk?.trap_flags?.includes('NEAR_LIMIT_UP');
    const limitUp = change != null && change >= 9.5;

    const cAge = ageSec(c?.updated_at, now);
    const bpAge = ageSec(bp?.updated_at, now);

    const base: AttackFeatures = {
        change_pct: change,
        last_price: last,
        vwap_pos_pct:
            finite(m?.vwap_pos_pct) ?? finite(bp?.distance_from_vwap_pct),
        prev_vwap_pos_pct: finite(opts.prevVwapPos),
        volume_accel:
            finite(m?.volume_acceleration) ?? finite(bp?.volume_acceleration),
        rank_velocity:
            finite(c?.rank_velocity) ?? finite(bp?.rank_velocity),
        bp_slope:
            finite(bp?.volume_acceleration_slope) ??
            (opts.bpRising ? 0.05 : null),
        buy_surge: buySurge,
        ask_eating_raw: askRaw,
        trade_aggression:
            finite(m?.trade_aggression_score) ?? finite(bp?.trade_aggression),
        trade_aggression_available:
            m?.trade_aggression_available === true ||
            (bp?.trade_aggression != null &&
                Number.isFinite(bp.trade_aggression)),
        return_30s: finite(m?.return_30s),
        return_1m: finite(m?.return_1m),
        return_3m: finite(m?.return_3m),
        breakout_type: m?.breakout_type ?? null,
        trigger: Number.isFinite(opts.trigger) ? opts.trigger : 0,
        near_limit: nearLimit,
        limit_up: limitUp,
        last_trade_age_sec: cAge ?? bpAge,
        quote_age_sec: cAge ?? bpAge,
        orderbook_age_sec: bpAge ?? cAge,
        volume_age_sec: cAge ?? bpAge,
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
    };
    return { ...base, ...(opts.overrides ?? {}) };
}

function labelFor(state: RescueRadarState, pendingBreakout = false): string {
    if (pendingBreakout && (state === 'PRE_ATTACK' || state === 'EARLY')) {
        return '突破確認中';
    }
    switch (state) {
        case 'WATCH':
            return '異常加速';
        case 'EARLY':
            return '漲3%前';
        case 'PRE_ATTACK':
            return '準備發動';
        case 'ACTIVE':
            return '正在急攻';
        case 'STALLING':
            return '攻擊停滯';
        case 'EARLY_FAILED':
            return '吃單無效';
        case 'FAKE_BREAKOUT':
            return '假突破';
        case 'WEAKENING':
            return '動能轉弱';
        case 'NEAR_LIMIT':
            return '接近漲停';
        case 'LIMIT_UP':
            return '漲停';
        case 'PULLBACK':
            return '回踩';
        case 'INSUFFICIENT_DATA':
            return '資料不足';
        case 'DATA_STALE':
            return '資料過舊';
        case 'DATA_INCOMPLETE':
            return '資料不完整';
        case 'INVALID':
            return '結構破壞';
        default:
            return '觀察';
    }
}

function cancelToWeakening(
    f: AttackFeatures,
    track: EarlyTrack | null,
): boolean {
    if (!track) return false;
    if (
        track.state !== 'EARLY' &&
        track.state !== 'PRE_ATTACK' &&
        track.state !== 'ACTIVE' &&
        track.state !== 'STALLING'
    ) {
        return false;
    }
    const vwap = finite(f.vwap_pos_pct);
    if (vwap != null && vwap < -0.05) return true;
    const px = finite(f.last_price);
    if (
        px != null &&
        track.trigger_price > 0 &&
        ((track.trigger_price - px) / track.trigger_price) * 100 >= 0.8
    ) {
        return true;
    }
    if (nz(f.rank_velocity) <= -3) return true;
    if (
        track.last_ask_eating &&
        !isTrueAskEating(f) &&
        nz(f.return_1m) < 0
    ) {
        return true;
    }
    if (nz(f.return_1m) < 0 && nz(f.return_30s) < 0) return true;
    if (
        (f.breakout_type === 'breakout' || f.breakout_type === 'rebreak') &&
        nz(f.return_1m) < -0.2
    ) {
        return true;
    }
    return false;
}

function emptyTrackFields(
    partial: Pick<
        EarlyTrack,
        | 'symbol'
        | 'triggered_at_ms'
        | 'trigger_price'
        | 'trigger_change_pct'
        | 'state'
        | 'peak_price'
        | 'high_since_trigger'
        | 'last_ask_eating'
    >,
): EarlyTrack {
    return {
        ...partial,
        last_valid_state: partial.state,
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
    };
}

function inCooldown(
    track: EarlyTrack | null,
    nowMs: number,
    attackScore: number,
    f: AttackFeatures,
): boolean {
    if (!track || track.cooldown_until_ms <= nowMs) return false;
    // Escape hatch: rebreak prior high OR attack_score clearly higher.
    const px = finite(f.last_price);
    if (
        px != null &&
        track.peak_price > 0 &&
        px > track.peak_price * 1.001
    ) {
        return false;
    }
    if (attackScore >= track.attack_score_at_fail + 18) return false;
    return true;
}

/**
 * Main state resolver for cash-session attack ladder.
 */
export function resolveAttackState(
    cfg: RadarRescueConfig,
    f: AttackFeatures,
    opts: {
        symbol: string;
        cashSession: boolean;
        stale: boolean;
        dataBlocked: boolean;
        prev: EarlyTrack | null;
        nowMs: number;
    },
): AttackDecision {
    const reasons: string[] = [];
    const askQ = computeAskEatingQuality(f);
    const pushE = computePushEfficiency(f);
    const attackScore = computeAttackScore(f, askQ, pushE);
    const trueAsk = isTrueAskEating(f);
    const accel = collectAccelEvidence(cfg, f);
    const priceOk = collectPriceConfirm(f);
    const dataStale =
        opts.stale || isAttackDataStale(cfg, f);
    const incomplete =
        finite(f.last_price) == null &&
        finite(f.volume_accel) == null &&
        finite(f.change_pct) == null;

    const finish = (
        state: RescueRadarState,
        prePlus3: boolean,
        rsns: string[],
        track: EarlyTrack | null,
        pendingBreakout = false,
        labelOverride?: string,
    ): AttackDecision => {
        const lastValid =
            track?.last_valid_state ??
            (state !== 'DATA_STALE' &&
            state !== 'DATA_INCOMPLETE' &&
            state !== 'WATCH'
                ? state
                : opts.prev?.last_valid_state ?? null);
        return {
            state,
            label: labelOverride ?? labelFor(state, pendingBreakout),
            accel_evidence: accel,
            price_confirm: priceOk,
            pre_plus3:
                prePlus3 &&
                (state === 'EARLY' ||
                    state === 'PRE_ATTACK' ||
                    state === 'STALLING'),
            true_ask_eating: trueAsk,
            ask_eating_quality: askQ,
            push_efficiency: pushE,
            attack_score: attackScore,
            data_stale: dataStale,
            last_valid_state: lastValid,
            reasons: rsns,
            track,
        };
    };

    if (opts.dataBlocked || incomplete) {
        return finish(
            incomplete && !opts.dataBlocked
                ? 'DATA_INCOMPLETE'
                : 'INSUFFICIENT_DATA',
            false,
            [incomplete ? '關鍵行情欄位缺失' : '行情資料受阻'],
            opts.prev
                ? {
                      ...opts.prev,
                      state: incomplete
                          ? 'DATA_INCOMPLETE'
                          : 'INSUFFICIENT_DATA',
                  }
                : null,
            false,
            incomplete ? '資料不完整' : undefined,
        );
    }

    const chg = finite(f.change_pct);
    const inEarlyBand =
        chg != null &&
        chg > -3 &&
        chg < cfg.pre_plus3_max_change_pct;

    // Off-hours: never claim live attack.
    if (!opts.cashSession) {
        const watchLike =
            accel.length >= 1 ||
            opts.prev?.state === 'EARLY' ||
            opts.prev?.state === 'ACTIVE';
        return finish(
            'WATCH',
            false,
            ['非交易時段，不顯示正在發動'],
            opts.prev,
            false,
            watchLike ? '歷史訊號' : labelFor('WATCH'),
        );
    }

    // STALE: hard block live attack states (incl. previous ACTIVE).
    // last_valid_state is historical only — live state/label must be WATCH／資料過舊.
    if (dataStale) {
        const hist =
            opts.prev?.state === 'EARLY' ||
            opts.prev?.state === 'PRE_ATTACK' ||
            opts.prev?.state === 'ACTIVE' ||
            opts.prev?.state === 'STALLING'
                ? opts.prev.state
                : (opts.prev?.last_valid_state ?? null);
        const t = opts.prev
            ? {
                  ...opts.prev,
                  last_valid_state: hist ?? opts.prev.last_valid_state,
                  state: 'DATA_STALE' as RescueRadarState,
              }
            : null;
        return finish(
            'WATCH',
            false,
            ['資料過舊，不得判定正在發動'],
            t,
            false,
            '資料過舊',
        );
    }

    let track = opts.prev;
    const px = finite(f.last_price);

    // Open / maintain breakout event + absorb distinct fresh prints.
    if (isBreakoutSignal(f) && px != null) {
        const boPx =
            finite(f.breakout_price) ??
            track?.breakout_price ??
            px * 0.998;
        if (track) {
            if (
                !track.breakout_event_valid ||
                track.breakout_at_ms == null ||
                track.state === 'FAKE_BREAKOUT'
            ) {
                track = {
                    ...track,
                    breakout_price: boPx,
                    breakout_at_ms: opts.nowMs,
                    breakout_event_valid: true,
                    breakout_confirmed_active: false,
                    distinct_print_keys: [],
                    prints_above_breakout: 0,
                    last_trade_key: null,
                };
            }
            track = absorbBreakoutPrint(
                track,
                f,
                opts.nowMs,
                quoteStaleSec(cfg),
            );
            // Also absorb explicit samples from feed
            if (f.breakout_print_samples?.length) {
                for (const s of f.breakout_print_samples) {
                    track = absorbBreakoutPrint(
                        track,
                        {
                            ...f,
                            last_trade_key: s.trade_key,
                            last_trade_ts_ms: s.ts_ms,
                            last_price: s.price,
                            last_trade_age_sec: Math.max(
                                0,
                                (opts.nowMs - s.ts_ms) / 1000,
                            ),
                        },
                        opts.nowMs,
                        quoteStaleSec(cfg),
                    );
                }
            }
        }
    }

    if (f.limit_up) {
        return finish('LIMIT_UP', false, ['漲停'], track);
    }

    // ACTIVE-after-fail → WEAKENING (not FAKE)
    if (
        track?.breakout_confirmed_active &&
        track.breakout_price != null &&
        px != null &&
        px < track.breakout_price &&
        (f.sell_aggression_up || nz(f.return_30s) < 0)
    ) {
        reasons.push('ACTIVE 後跌回突破價／賣壓 — 動能轉弱（非假突破）');
        return finish(
            'WEAKENING',
            false,
            reasons,
            {
                ...track,
                state: 'WEAKENING',
                last_ask_eating: trueAsk,
            },
        );
    }

    if (isFakeBreakout(f, track, opts.nowMs)) {
        const cd = opts.nowMs + cooldownSec(cfg) * 1000;
        reasons.push('有效突破事件後30秒內跌回且賣壓增加 → 假突破');
        const t = track
            ? {
                  ...track,
                  state: 'FAKE_BREAKOUT' as RescueRadarState,
                  cooldown_until_ms: cd,
                  failed_at_ms: opts.nowMs,
                  attack_score_at_fail: attackScore,
                  breakout_event_valid: false,
                  breakout_at_ms: null,
                  prints_above_breakout: 0,
                  distinct_print_keys: [],
              }
            : null;
        return finish('FAKE_BREAKOUT', false, reasons, t);
    }

    // Quality collapse before 90s → cancel/weaken, NEVER skip to EARLY_FAILED.
    // Only when eat-quality context exists (not merely low idle aggression).
    if (
        track &&
        (track.state === 'EARLY' ||
            track.state === 'PRE_ATTACK' ||
            track.state === 'STALLING') &&
        askQ < 25 &&
        (f.ask_eating_raw ||
            f.ask_replenish_heavy ||
            track.last_ask_eating) &&
        opts.nowMs - track.triggered_at_ms < 90_000
    ) {
        reasons.push('吃單品質崩壞，取消攻勢（尚未達90秒FAILED門檻）');
        return finish(
            'WEAKENING',
            false,
            reasons,
            {
                ...track,
                state: 'WEAKENING',
                last_ask_eating: trueAsk,
            },
        );
    }

    if (
        f.near_limit &&
        isActiveCandidate(f, true) &&
        isBreakoutPersistent(cfg, f, track, opts.nowMs)
    ) {
        return finish(
            'NEAR_LIMIT',
            false,
            ['接近漲停且量價仍急攻'],
            track,
        );
    }

    if (cancelToWeakening(f, track)) {
        reasons.push('觸發後動能轉弱／跌回');
        return finish(
            'WEAKENING',
            false,
            reasons,
            track
                ? {
                      ...track,
                      state: 'WEAKENING',
                      last_ask_eating: trueAsk,
                  }
                : null,
        );
    }

    // Cooldown after EARLY_FAILED / FAKE_BREAKOUT
    if (inCooldown(track, opts.nowMs, attackScore, f)) {
        reasons.push('冷卻中，暫不重新升級');
        return finish(
            track!.state === 'FAKE_BREAKOUT' ? 'FAKE_BREAKOUT' : 'EARLY_FAILED',
            false,
            reasons,
            track,
        );
    }

    // Two-phase stall / fail
    if (
        track &&
        (track.state === 'EARLY' ||
            track.state === 'PRE_ATTACK' ||
            track.state === 'STALLING')
    ) {
        const age = opts.nowMs - track.triggered_at_ms;
        const flat = isFlatAfterTrigger(f, track);

        // 60–90s recover path while STALLING
        if (
            track.state === 'STALLING' &&
            age < 90_000 &&
            hasPriceReaccel(f)
        ) {
            reasons.push('停滯後重新放量／吃單／墊高 → 恢復');
            const pre = isPreAttack(f, trueAsk, askQ);
            const state: RescueRadarState = pre ? 'PRE_ATTACK' : 'EARLY';
            track = {
                ...track,
                state,
                stalling_since_ms: null,
                last_ask_eating: trueAsk,
                last_valid_state: state,
                peak_price:
                    px != null
                        ? Math.max(track.peak_price, px)
                        : track.peak_price,
                high_since_trigger:
                    px != null
                        ? Math.max(track.high_since_trigger, px)
                        : track.high_since_trigger,
            };
            return finish(state, inEarlyBand, reasons, track);
        }

        if (age >= 90_000 && flat && !hasPriceReaccel(f)) {
            reasons.push('90秒仍無有效新高且漲幅<0.3%');
            const cd = opts.nowMs + cooldownSec(cfg) * 1000;
            return finish(
                'EARLY_FAILED',
                false,
                reasons,
                {
                    ...track,
                    state: 'EARLY_FAILED',
                    last_ask_eating: trueAsk,
                    last_valid_state: 'EARLY_FAILED',
                    cooldown_until_ms: cd,
                    failed_at_ms: opts.nowMs,
                    attack_score_at_fail: attackScore,
                    stalling_since_ms: null,
                },
            );
        }

        if (age >= 60_000 && flat) {
            reasons.push('60秒攻擊停滯（尚未FAILED）');
            return finish(
                'STALLING',
                inEarlyBand,
                reasons,
                {
                    ...track,
                    state: 'STALLING',
                    stalling_since_ms:
                        track.stalling_since_ms ?? opts.nowMs,
                    last_ask_eating: trueAsk,
                    last_valid_state: 'STALLING',
                },
            );
        }
    }

    // Stick on EARLY_FAILED while flat (after cooldown expires handled above)
    if (
        track?.state === 'EARLY_FAILED' &&
        px != null &&
        track.trigger_price > 0
    ) {
        const movePct =
            ((px - track.trigger_price) / track.trigger_price) * 100;
        if (
            movePct < 0.3 &&
            !(
                isActiveCandidate(f, true) &&
                isBreakoutPersistent(cfg, f, track, opts.nowMs)
            )
        ) {
            reasons.push('吃單無效後仍無有效推進');
            return finish('EARLY_FAILED', false, reasons, track);
        }
    }

    // ACTIVE — needs persistence confirmation
    if (isActiveCandidate(f, true)) {
        if (isBreakoutPersistent(cfg, f, track, opts.nowMs)) {
            reasons.push('突破持續確認＋放量＋成交價持續向上');
            if (track && px != null) {
                track = {
                    ...track,
                    state: 'ACTIVE',
                    last_valid_state: 'ACTIVE',
                    breakout_event_valid: true,
                    breakout_confirmed_active: true,
                    peak_price: Math.max(track.peak_price, px),
                    high_since_trigger: Math.max(
                        track.high_since_trigger,
                        px,
                    ),
                    last_ask_eating: trueAsk,
                };
            } else if (px != null) {
                track = emptyTrackFields({
                    symbol: opts.symbol,
                    triggered_at_ms: opts.nowMs,
                    trigger_price: px,
                    trigger_change_pct: chg,
                    state: 'ACTIVE',
                    peak_price: px,
                    high_since_trigger: px,
                    last_ask_eating: trueAsk,
                });
                track = {
                    ...track,
                    breakout_price: finite(f.breakout_price) ?? px,
                    breakout_at_ms: opts.nowMs,
                    breakout_event_valid: true,
                    breakout_confirmed_active: true,
                };
            }
            return finish('ACTIVE', false, reasons, track);
        }
        // Pending breakout confirmation — open valid event, not ACTIVE
        reasons.push('突破尚未持續確認');
        if (track && px != null) {
            track = {
                ...track,
                state: 'PRE_ATTACK',
                last_valid_state: 'PRE_ATTACK',
                breakout_price:
                    track.breakout_price ??
                    finite(f.breakout_price) ??
                    px,
                breakout_at_ms: track.breakout_at_ms ?? opts.nowMs,
                breakout_event_valid: true,
                peak_price: Math.max(track.peak_price, px),
                high_since_trigger: Math.max(
                    track.high_since_trigger,
                    px,
                ),
                last_ask_eating: trueAsk,
            };
            track = absorbBreakoutPrint(
                track,
                f,
                opts.nowMs,
                quoteStaleSec(cfg),
            );
        } else if (px != null) {
            track = emptyTrackFields({
                symbol: opts.symbol,
                triggered_at_ms: opts.nowMs,
                trigger_price: px,
                trigger_change_pct: chg,
                state: 'PRE_ATTACK',
                peak_price: px,
                high_since_trigger: px,
                last_ask_eating: trueAsk,
            });
            track = {
                ...track,
                breakout_price: finite(f.breakout_price) ?? px,
                breakout_at_ms: opts.nowMs,
                breakout_event_valid: true,
                breakout_confirmed_active: false,
            };
            track = absorbBreakoutPrint(
                track,
                f,
                opts.nowMs,
                quoteStaleSec(cfg),
            );
        }
        return finish('PRE_ATTACK', inEarlyBand, reasons, track, true);
    }

    // PRE_ATTACK / EARLY only inside < +3% band
    if (inEarlyBand && accelPassesForEarly(accel) && priceOk.length >= 1) {
        const pre = isPreAttack(f, trueAsk, askQ);
        const state: RescueRadarState = pre ? 'PRE_ATTACK' : 'EARLY';
        reasons.push(
            pre
                ? '量能強＋吃單有效＋成交價墊高'
                : `加速證據 ${accel.length} 項＋價格確認 ${priceOk.length} 項`,
        );
        if (chg != null) {
            reasons.push(`日漲 ${chg.toFixed(1)}%（尚未+3%）`);
        }
        if (
            !track ||
            track.state === 'WATCH' ||
            track.state === 'WEAKENING' ||
            track.state === 'EARLY_FAILED' ||
            track.state === 'FAKE_BREAKOUT' ||
            track.state === 'INACTIVE' ||
            track.state === 'DATA_STALE'
        ) {
            track =
                px != null
                    ? emptyTrackFields({
                          symbol: opts.symbol,
                          triggered_at_ms: opts.nowMs,
                          trigger_price: px,
                          trigger_change_pct: chg,
                          state,
                          peak_price: px,
                          high_since_trigger: px,
                          last_ask_eating: trueAsk,
                      })
                    : track;
        } else if (track && px != null) {
            track = {
                ...track,
                state,
                last_valid_state: state,
                peak_price: Math.max(track.peak_price, px),
                high_since_trigger: Math.max(
                    track.high_since_trigger,
                    px,
                ),
                last_ask_eating: trueAsk,
            };
        }
        return finish(state, true, reasons, track);
    }

    if (accel.length >= 1 && priceOk.length === 0) {
        reasons.push('異常加速但尚未價格確認');
        return finish('WATCH', false, reasons, track);
    }

    if (accel.length >= 1) {
        reasons.push('加速跡象觀察中');
        return finish('WATCH', false, reasons, track);
    }

    return finish(
        'WATCH',
        false,
        reasons.length ? reasons : ['尚無加速證據'],
        track,
    );
}

export { labelFor as attackStateLabel };

export function askEatingQualityLabel(q: number): string {
    if (q >= 85) return '強吃單';
    if (q >= 70) return '明顯';
    if (q >= 50) return '普通';
    return '吃單弱';
}
