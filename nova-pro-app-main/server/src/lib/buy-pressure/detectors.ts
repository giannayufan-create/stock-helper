// server/src/lib/buy-pressure/detectors.ts

import type { BuyPressureConfig } from './config.ts';
import type {
    BidAskSnap,
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

export function detectAskConsumption(
    history: BidAskSnap[],
    cfg: BuyPressureConfig,
): {
    eating: boolean;
    cancel: boolean;
    note: string | null;
    ask_price: number | null;
} {
    if (history.length < cfg.ask_eating.min_snapshots) {
        return { eating: false, cancel: false, note: null, ask_price: null };
    }
    const recent = history.slice(-cfg.ask_eating.min_snapshots);
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    if (first.best_ask <= 0 || last.best_ask <= 0) {
        return { eating: false, cancel: false, note: null, ask_price: null };
    }
    // Same ask price level (within 0.5 tick tolerance via equality on rounded)
    const askPx = first.best_ask;
    const sameLevel = recent.every(
        (s) => Math.abs(s.best_ask - askPx) / askPx < 0.002 || s.best_ask === askPx,
    );
    if (!sameLevel) {
        return { eating: false, cancel: false, note: null, ask_price: null };
    }
    if (first.ask_volume <= 0) {
        return { eating: false, cancel: false, note: null, ask_price: askPx };
    }
    const drop = first.ask_volume - last.ask_volume;
    const dropPct = drop / first.ask_volume;
    if (dropPct < cfg.ask_eating.min_ask_drop_pct) {
        return { eating: false, cancel: false, note: null, ask_price: askPx };
    }
    const executed = recent.reduce((a, s) => a + Math.max(0, s.ask_executed_delta), 0);
    const ratio = drop > 0 ? executed / drop : 0;
    if (ratio >= cfg.ask_eating.min_executed_ratio) {
        return {
            eating: true,
            cancel: false,
            note: `正在吃 ${askPx} 賣單`,
            ask_price: askPx,
        };
    }
    if (ratio <= cfg.ask_cancel.max_executed_ratio) {
        return {
            eating: false,
            cancel: true,
            note: `ASK_CANCEL @ ${askPx}`,
            ask_price: askPx,
        };
    }
    return { eating: false, cancel: false, note: null, ask_price: askPx };
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

export function detectOverheated(
    f: BuyPressureFeatures,
    cfg: BuyPressureConfig,
): boolean {
    const chg = f.change_pct ?? 0;
    const heat = f.heat_score ?? 0;
    const dist = Math.abs(f.distance_from_vwap_pct ?? 0);
    const chase = (f.chase_risk ?? '').toLowerCase();
    const chaseHit = cfg.overheated.chase_risks.includes(chase);
    let hits = 0;
    if (chg >= cfg.overheated.min_change_pct) hits++;
    if (heat >= cfg.overheated.min_heat) hits++;
    if (dist >= cfg.overheated.min_vwap_distance_pct) hits++;
    if (chaseHit) hits++;
    return hits >= 2;
}

export function detectEarly(
    f: BuyPressureFeatures,
    cfg: BuyPressureConfig,
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
    if (rvol == null || rvol < cfg.early.min_rvol) return false;
    if (cfg.early.require_above_vwap && !above) return false;
    if (mom != null && mom < cfg.early.min_momentum) return false;
    if (
        f.trade_aggression.available &&
        (agg == null || agg < cfg.early.min_aggression)
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
    // Forbid "volume alone = BUY_SURGE"
    const rvol = f.rvol.value;
    const vol = f.volume_acceleration.value;
    const mom = f.momentum_acceleration.value;
    const agg = f.trade_aggression.value;
    const rv = f.rank_velocity.value;
    if (score < cfg.buy_surge.min_score) return false;
    if (rvol == null || rvol < cfg.buy_surge.min_rvol) return false;
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
    // Weak price momentum gate via change or momentum
    const priceOk =
        (f.change_pct != null && f.change_pct > 0) ||
        (mom != null && mom > cfg.buy_surge.min_momentum);
    if (!priceOk) return false;
    return true;
}

export function detectVolumeBreakout(
    f: BuyPressureFeatures,
    cfg: BuyPressureConfig,
): boolean {
    if (f.last_price == null || f.high == null || f.high <= 0) return false;
    if (f.last_price < f.high) return false;
    const vol = f.volume_acceleration.value;
    const agg = f.trade_aggression.value;
    if (vol == null || vol < cfg.volume_breakout.min_volume_accel) return false;
    if (
        !f.trade_aggression.available ||
        agg == null ||
        agg < cfg.volume_breakout.min_aggression
    ) {
        return false;
    }
    if (cfg.volume_breakout.require_rank_improving) {
        const rv = f.rank_velocity.value ?? 0;
        const improve =
            f.rank != null && f.rank_prev != null
                ? f.rank_prev - f.rank > 0
                : rv > 0;
        if (!improve) return false;
    }
    return true;
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
    const allowHot =
        !input.dataStale || !input.staleBlock;

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

    const priority: BuyPressureState[] = [
        'OVERHEATED',
        'VOLUME_BREAKOUT',
        'ASK_EATING',
        'BUY_SURGE',
        'LARGE_BID',
        'EARLY',
        'COOLING',
    ];
    const primary =
        priority.find((p) => states.includes(p)) ?? states[0]!;
    return { primary, states };
}
