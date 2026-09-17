// server/src/lib/buy-pressure/detectors.ts

import type { BuyPressureConfig } from './config.ts';
import type { AccelLabel } from './feature-history.ts';
import type {
    BidAskSnap,
    BreakoutRefType,
    BuyPressureFeatures,
    BuyPressureState,
    VwapBucket,
} from './types.ts';

export function vwapBucket(
    distancePct: number | null,
    nearPct: number,
): VwapBucket | null {
    if (distancePct == null || !Number.isFinite(distancePct)) return null;
    if (Math.abs(distancePct) <= nearPct) return 'Near VWAP';
    return distancePct > 0 ? 'Above VWAP' : 'Below VWAP';
}

export type AskEatingConfidence = 'high' | 'medium' | 'low' | 'none';

export function detectAskConsumption(
    history: BidAskSnap[],
    cfg: BuyPressureConfig,
): {
    eating: boolean;
    cancel: boolean;
    note: string | null;
    ask_price: number | null;
    orderbook_depth_available: number;
    ask_eating_confidence: AskEatingConfidence;
} {
    const lastDepth = history.length
        ? history[history.length - 1]!.orderbook_depth_available
        : 0;
    const empty = {
        eating: false,
        cancel: false,
        note: null as string | null,
        ask_price: null as number | null,
        orderbook_depth_available: lastDepth,
        ask_eating_confidence: 'none' as AskEatingConfidence,
    };
    if (history.length < cfg.ask_eating.min_snapshots) {
        return empty;
    }
    const recent = history.slice(-cfg.ask_eating.min_snapshots);
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    if (first.best_ask <= 0 || last.best_ask <= 0) {
        return empty;
    }
    const askPx = first.best_ask;
    const sameLevel = recent.every(
        (s) =>
            Math.abs(s.best_ask - askPx) / askPx < 0.002 || s.best_ask === askPx,
    );
    if (!sameLevel) {
        return { ...empty, ask_price: askPx };
    }
    // Prefer same-price level qty from full book when depth > 1
    const levelAskQty = (s: BidAskSnap): number => {
        if (s.ask_levels.length > 1 && s.ask_qty.length === s.ask_levels.length) {
            const idx = s.ask_levels.findIndex(
                (p) => Math.abs(p - askPx) / askPx < 0.002 || p === askPx,
            );
            if (idx >= 0) return s.ask_qty[idx] ?? s.ask_volume;
        }
        return s.ask_volume;
    };
    const firstQty = levelAskQty(first);
    const lastQty = levelAskQty(last);
    if (firstQty <= 0) {
        return { ...empty, ask_price: askPx };
    }
    const drop = firstQty - lastQty;
    const dropPct = drop / firstQty;
    if (dropPct < cfg.ask_eating.min_ask_drop_pct) {
        return { ...empty, ask_price: askPx };
    }
    // Actual trades at same ask price across the window
    const executed = recent.reduce(
        (a, s) => a + Math.max(0, s.ask_executed_delta),
        0,
    );
    const ratio = drop > 0 ? executed / drop : 0;
    const depth = Math.max(
        ...recent.map((s) => s.orderbook_depth_available),
        lastDepth,
    );
    // Best-only book → cannot claim FULL eating/cancel certainty
    const confidence: AskEatingConfidence =
        depth >= 5 ? 'high' : depth >= 2 ? 'medium' : 'low';

    if (ratio >= cfg.ask_eating.min_executed_ratio) {
        return {
            eating: true,
            cancel: false,
            note: `正在吃 ${askPx} 賣單`,
            ask_price: askPx,
            orderbook_depth_available: depth,
            ask_eating_confidence: confidence,
        };
    }
    if (ratio <= cfg.ask_cancel.max_executed_ratio) {
        return {
            eating: false,
            cancel: true,
            note: `ASK_CANCEL @ ${askPx}`,
            ask_price: askPx,
            orderbook_depth_available: depth,
            ask_eating_confidence: confidence,
        };
    }
    return {
        ...empty,
        ask_price: askPx,
        orderbook_depth_available: depth,
        ask_eating_confidence: confidence,
    };
}

export function detectLargeBid(
    history: BidAskSnap[],
    cfg: BuyPressureConfig,
): { hit: boolean; note: string | null } {
    if (history.length < cfg.large_bid.min_history) {
        return { hit: false, note: null };
    }
    const last = history[history.length - 1]!;
    const prev = history.slice(0, -1);
    const avg =
        prev.reduce((a, s) => a + Math.max(0, s.bid_volume), 0) / prev.length;
    if (avg <= 0 || last.bid_volume < avg * cfg.large_bid.min_multiple_of_avg) {
        return { hit: false, note: null };
    }
    return {
        hit: true,
        note: `大額委買出現 @ ${last.best_bid}`,
    };
}

export type BidCancelConfidence = AskEatingConfidence;

/**
 * Bid-side mirror of detectAskConsumption: a large buy wall that shrinks
 * without matching trades at that price was pulled, not filled — the classic
 * spoof that makes LARGE_BID look bullish.
 */
export function detectBidCancel(
    history: BidAskSnap[],
    cfg: BuyPressureConfig,
): {
    cancel: boolean;
    note: string | null;
    bid_price: number | null;
    confidence: BidCancelConfidence;
} {
    const empty = {
        cancel: false,
        note: null as string | null,
        bid_price: null as number | null,
        confidence: 'none' as BidCancelConfidence,
    };
    if (history.length < cfg.bid_cancel.min_snapshots) return empty;

    const recent = history.slice(-cfg.bid_cancel.min_snapshots);
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    if (first.best_bid <= 0 || last.best_bid <= 0) return empty;

    const bidPx = first.best_bid;
    const sameLevel = recent.every(
        (s) =>
            Math.abs(s.best_bid - bidPx) / bidPx < 0.002 || s.best_bid === bidPx,
    );
    if (!sameLevel) return { ...empty, bid_price: bidPx };

    const levelBidQty = (s: BidAskSnap): number => {
        if (s.bid_levels.length > 1 && s.bid_qty.length === s.bid_levels.length) {
            const idx = s.bid_levels.findIndex(
                (p) => Math.abs(p - bidPx) / bidPx < 0.002 || p === bidPx,
            );
            if (idx >= 0) return s.bid_qty[idx] ?? s.bid_volume;
        }
        return s.bid_volume;
    };
    const firstQty = levelBidQty(first);
    const lastQty = levelBidQty(last);
    if (firstQty <= 0) return { ...empty, bid_price: bidPx };

    const drop = firstQty - lastQty;
    if (drop / firstQty < cfg.bid_cancel.min_bid_drop_pct) {
        return { ...empty, bid_price: bidPx };
    }
    const executed = recent.reduce(
        (a, s) => a + Math.max(0, s.bid_executed_delta ?? 0),
        0,
    );
    const ratio = drop > 0 ? executed / drop : 0;
    if (ratio > cfg.bid_cancel.max_executed_ratio) {
        return { ...empty, bid_price: bidPx };
    }
    const depth = Math.max(
        ...recent.map((s) => s.orderbook_depth_available),
        0,
    );
    return {
        cancel: true,
        note: `BID_CANCEL @ ${bidPx}（委買抽單，非成交）`,
        bid_price: bidPx,
        confidence: depth >= 5 ? 'high' : depth >= 2 ? 'medium' : 'low',
    };
}

export function detectOverheated(
    f: BuyPressureFeatures,
    cfg: BuyPressureConfig,
): boolean {
    const chg = f.change_pct ?? 0;
    const heat = f.heat_score ?? 0;
    const dist = Math.abs(f.distance_from_vwap_pct ?? 0);
    let hits = 0;
    if (chg >= cfg.overheated.min_change_pct) hits++;
    if (heat >= cfg.overheated.min_heat) hits++;
    if (dist >= cfg.overheated.min_vwap_distance_pct) hits++;
    return hits >= 2;
}

export interface EarlySlopeInput {
    rvol_slope: number | null;
    volume_acceleration_slope: number | null;
    trade_aggression_change: number | null;
    momentum_acceleration_slope: number | null;
    rank_velocity_slope: number | null;
    vwap_distance_change: number | null;
    rvol_accel: AccelLabel;
    volume_accel_label: AccelLabel;
    sample_count: number;
}

/**
 * EARLY must not rely on current values alone — require positive time-window slopes
 * for volume / RVOL / aggression (when available) plus VWAP structure.
 */
export function detectEarly(
    f: BuyPressureFeatures,
    cfg: BuyPressureConfig,
    slopes?: EarlySlopeInput | null,
): boolean {
    const rankImprove =
        f.rank != null && f.rank_prev != null
            ? f.rank_prev - f.rank
            : f.rank_velocity.value ?? 0;
    const vol = f.volume_acceleration.value;
    const rvol = f.rvol.value;
    const mom = f.momentum_acceleration.value;
    const agg = f.trade_aggression.value;
    const above =
        f.vwap_bucket === 'Above VWAP' ||
        (f.distance_from_vwap_pct != null && f.distance_from_vwap_pct > 0);

    if (rankImprove < cfg.early.min_rank_improve) return false;
    if (vol == null || vol < cfg.early.min_volume_accel) return false;
    if (!f.rvol.available || rvol == null || rvol < cfg.early.min_rvol) {
        return false;
    }
    if (cfg.early.require_above_vwap && !above) return false;
    if (mom != null && mom < cfg.early.min_momentum) return false;
    if (
        f.trade_aggression.available &&
        (agg == null || agg < cfg.early.min_aggression)
    ) {
        return false;
    }

    // Time-window slope gates — without history, EARLY is not FULL-qualified
    if (!slopes || slopes.sample_count < 3) return false;
    if (
        slopes.volume_acceleration_slope == null ||
        slopes.volume_acceleration_slope <= 0
    ) {
        return false;
    }
    if (slopes.rvol_slope == null || slopes.rvol_slope <= 0) return false;
    if (
        f.trade_aggression.available &&
        (slopes.trade_aggression_change == null ||
            slopes.trade_aggression_change < 0)
    ) {
        return false;
    }
    // Rank velocity / momentum: prefer improving when measurable
    if (
        slopes.rank_velocity_slope != null &&
        slopes.rank_velocity_slope < 0
    ) {
        return false;
    }
    if (
        slopes.momentum_acceleration_slope != null &&
        slopes.momentum_acceleration_slope < -0.01
    ) {
        return false;
    }
    // VWAP structure: distance should not be collapsing below VWAP
    if (
        cfg.early.require_above_vwap &&
        slopes.vwap_distance_change != null &&
        slopes.vwap_distance_change < -0.01
    ) {
        return false;
    }
    return true;
}

export function detectBuySurge(
    f: BuyPressureFeatures,
    score: number,
    cfg: BuyPressureConfig,
): boolean {
    const rvol = f.rvol.value;
    const vol = f.volume_acceleration.value;
    const mom = f.momentum_acceleration.value;
    const agg = f.trade_aggression.value;
    const rv = f.rank_velocity.value;
    if (score < cfg.buy_surge.min_score) return false;
    if (!f.rvol.available || rvol == null || rvol < cfg.buy_surge.min_rvol) {
        return false;
    }
    if (vol == null || vol < cfg.buy_surge.min_volume_accel) return false;
    if (mom == null || mom < cfg.buy_surge.min_momentum) return false;
    if (
        !f.trade_aggression.available ||
        agg == null ||
        agg < cfg.buy_surge.min_aggression
    ) {
        return false;
    }
    if (rv == null || rv < cfg.buy_surge.min_rank_velocity) return false;
    const priceOk =
        (f.change_pct != null && f.change_pct > 0) ||
        (mom != null && mom > cfg.buy_surge.min_momentum);
    if (!priceOk) return false;
    return true;
}

export interface BreakoutReference {
    breakout_type: BreakoutRefType;
    reference_level: number;
    reference_time: string | null;
}

export function detectVolumeBreakout(
    f: BuyPressureFeatures,
    cfg: BuyPressureConfig,
    refs?: BreakoutReference[] | null,
): {
    hit: boolean;
    breakout_type: BreakoutRefType | null;
    reference_level: number | null;
    reference_time: string | null;
} {
    const empty = {
        hit: false,
        breakout_type: null as BreakoutRefType | null,
        reference_level: null as number | null,
        reference_time: null as string | null,
    };
    if (f.last_price == null || f.last_price <= 0) return empty;

    const candidates: BreakoutReference[] = [...(refs ?? [])];
    // Fallback: intraday high still allowed as LOCAL_HIGH when no richer refs
    if (f.high != null && f.high > 0) {
        const hasLocal = candidates.some((r) => r.breakout_type === 'LOCAL_HIGH');
        if (!hasLocal) {
            candidates.push({
                breakout_type: 'LOCAL_HIGH',
                reference_level: f.high,
                reference_time: null,
            });
        }
    }
    if (!candidates.length) return empty;

    // Prefer the highest reference the price is at/above
    const crossed = candidates
        .filter((r) => f.last_price! >= r.reference_level)
        .sort((a, b) => b.reference_level - a.reference_level);
    if (!crossed.length) return empty;

    const best = crossed[0]!;
    const vol = f.volume_acceleration.value;
    const agg = f.trade_aggression.value;
    if (vol == null || vol < cfg.volume_breakout.min_volume_accel) return empty;
    if (
        !f.trade_aggression.available ||
        agg == null ||
        agg < cfg.volume_breakout.min_aggression
    ) {
        return empty;
    }
    if (cfg.volume_breakout.require_rank_improving) {
        const rv = f.rank_velocity.value ?? 0;
        const improve =
            f.rank != null && f.rank_prev != null
                ? f.rank_prev - f.rank > 0
                : rv > 0;
        if (!improve) return empty;
    }
    return {
        hit: true,
        breakout_type: best.breakout_type,
        reference_level: best.reference_level,
        reference_time: best.reference_time,
    };
}

export function detectCooling(
    f: BuyPressureFeatures,
    cfg: BuyPressureConfig,
): boolean {
    const vol = f.volume_acceleration.value;
    const rv = f.rank_velocity.value;
    if (vol == null || rv == null) return false;
    return (
        vol <= cfg.cooling.max_volume_accel &&
        rv <= cfg.cooling.max_rank_velocity
    );
}

export function resolveStates(input: {
    early: boolean;
    buySurge: boolean;
    askEating: boolean;
    volumeBreakout: boolean;
    largeBid: boolean;
    overheated: boolean;
    cooling: boolean;
    dataStale: boolean;
    staleBlock: boolean;
}): { primary: BuyPressureState; states: BuyPressureState[] } {
    const states: BuyPressureState[] = [];
    const allowHot = !input.dataStale || !input.staleBlock;

    if (input.overheated) states.push('OVERHEATED');
    if (allowHot && input.volumeBreakout) states.push('VOLUME_BREAKOUT');
    if (allowHot && input.askEating) states.push('ASK_EATING');
    if (allowHot && input.buySurge) states.push('BUY_SURGE');
    if (input.largeBid) states.push('LARGE_BID');
    if (input.early) states.push('EARLY');
    if (input.cooling && states.length === 0) states.push('COOLING');

    if (states.length === 0) {
        return { primary: 'COOLING', states: ['COOLING'] };
    }

    const actionPriority: Array<
        Exclude<BuyPressureState, 'OVERHEATED' | 'COOLING'>
    > = [
        'VOLUME_BREAKOUT',
        'ASK_EATING',
        'BUY_SURGE',
        'LARGE_BID',
        'EARLY',
    ];
    const fallbackPriority: BuyPressureState[] = [
        ...actionPriority,
        'OVERHEATED',
        'COOLING',
    ];
    const action = states.filter(
        (s): s is Exclude<BuyPressureState, 'OVERHEATED' | 'COOLING'> =>
            s !== 'OVERHEATED' && s !== 'COOLING',
    );
    const primary =
        (action.length
            ? actionPriority.find((p) => action.includes(p))
            : fallbackPriority.find((p) => states.includes(p))) ?? states[0]!;
    return { primary, states };
}
