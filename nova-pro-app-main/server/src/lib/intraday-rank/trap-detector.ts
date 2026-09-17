// server/src/lib/intraday-rank/trap-detector.ts
// Intraday equivalent of ai/daytrade-verdict detectTrapLabels, running on the
// live tick state C already has. Deducts score — never promotes.

import type { SymbolMarketState } from '../open-gate-v2/types.ts';
import type { BreakoutType } from './types.ts';

export type TrapFlag =
    /** Faded well off the day high and back under the open — 開高走低 */
    | 'FADE_FROM_HIGH'
    /** Poked above the prior structure high then lost it — 假突破 */
    | 'FAILED_BREAKOUT'
    /** Sitting at the day high without the volume to back it — 無量突破 */
    | 'THIN_BREAKOUT'
    /** Near limit up, where fills get unreliable — 接近漲停 */
    | 'NEAR_LIMIT_UP'
    /** Trading under the open while the day high is far above — 誘多上影線 */
    | 'UPPER_WICK';

export interface TrapThresholds {
    /** % off the day high that counts as a meaningful fade. */
    fade_from_high_pct: number;
    /** % below the open that counts as losing the open. */
    below_open_pct: number;
    /** Within this % of the day high counts as "at the high". */
    at_high_pct: number;
    /** Volume acceleration under this is "no volume behind it". */
    thin_volume_accel: number;
    /** RVOL under this is "no volume behind it". */
    thin_rvol: number;
    /** Day change at or above this is treated as near limit up. */
    near_limit_up_pct: number;
    /** Upper wick must be at least this % of the day range. */
    upper_wick_range_ratio: number;
}

export const DEFAULT_TRAP_THRESHOLDS: TrapThresholds = {
    fade_from_high_pct: 1.5,
    below_open_pct: 0.1,
    at_high_pct: 0.3,
    thin_volume_accel: 1.0,
    thin_rvol: 1.0,
    near_limit_up_pct: 9.0,
    upper_wick_range_ratio: 0.5,
};

export const DEFAULT_TRAP_PENALTIES: Record<TrapFlag, number> = {
    FADE_FROM_HIGH: 10,
    FAILED_BREAKOUT: 12,
    THIN_BREAKOUT: 8,
    NEAR_LIMIT_UP: 6,
    UPPER_WICK: 6,
};

export interface TrapReport {
    flags: TrapFlag[];
    /** Total score deduction, already capped. */
    penalty: number;
    /** Chinese labels for the risks list. */
    labels: string[];
    available: boolean;
}

const LABELS: Record<TrapFlag, string> = {
    FADE_FROM_HIGH: '開高走低（自高點回落且失守開盤）',
    FAILED_BREAKOUT: '假突破（突破後跌回結構）',
    THIN_BREAKOUT: '無量突破（貼高但量能不足）',
    NEAR_LIMIT_UP: '接近漲停（成交不確定性高）',
    UPPER_WICK: '上影線誘多（高點遠離現價）',
};

const EMPTY: TrapReport = {
    flags: [],
    penalty: 0,
    labels: [],
    available: false,
};

/**
 * All inputs come from the same snapshot C scores on, so this adds no new
 * data dependency and cannot disagree with the rest of the item.
 */
export function detectIntradayTraps(opts: {
    state: SymbolMarketState | undefined;
    breakoutType: BreakoutType | null;
    volumeAcceleration: number | null;
    rvolSameTime: number | null;
    dayChangePct: number | null;
    thresholds?: Partial<TrapThresholds>;
    penalties?: Partial<Record<TrapFlag, number>>;
    /** Upper bound so traps degrade a score rather than zero it out. */
    maxPenalty?: number;
}): TrapReport {
    const st = opts.state;
    if (!st || !(st.last_price > 0)) return EMPTY;

    const th = { ...DEFAULT_TRAP_THRESHOLDS, ...opts.thresholds };
    const pen = { ...DEFAULT_TRAP_PENALTIES, ...opts.penalties };
    const maxPenalty = opts.maxPenalty ?? 24;

    const last = st.last_price;
    const high = st.high > 0 ? st.high : last;
    const low = st.low > 0 ? st.low : last;
    const open = st.open > 0 ? st.open : 0;

    const fadeFromHighPct = high > 0 ? ((high - last) / high) * 100 : 0;
    const belowOpenPct =
        open > 0 ? ((open - last) / open) * 100 : Number.NEGATIVE_INFINITY;
    const range = Math.max(high - low, last * 0.0001);
    const upperWick = high - Math.max(open || last, last);

    const flags: TrapFlag[] = [];

    if (
        fadeFromHighPct >= th.fade_from_high_pct &&
        belowOpenPct >= th.below_open_pct
    ) {
        flags.push('FADE_FROM_HIGH');
    } else if (
        upperWick > 0 &&
        upperWick / range >= th.upper_wick_range_ratio &&
        fadeFromHighPct >= th.fade_from_high_pct
    ) {
        // Long upper shadow but still holding the open — weaker warning.
        flags.push('UPPER_WICK');
    }

    if (opts.breakoutType === 'failed_breakout') {
        flags.push('FAILED_BREAKOUT');
    }

    const atHigh = high > 0 && ((high - last) / high) * 100 <= th.at_high_pct;
    const accel = opts.volumeAcceleration;
    const rvol = opts.rvolSameTime;
    const volumeKnown = accel != null || rvol != null;
    const volumeThin =
        (accel == null || accel < th.thin_volume_accel) &&
        (rvol == null || rvol < th.thin_rvol);
    if (atHigh && volumeKnown && volumeThin) {
        flags.push('THIN_BREAKOUT');
    }

    if (
        opts.dayChangePct != null &&
        opts.dayChangePct >= th.near_limit_up_pct
    ) {
        flags.push('NEAR_LIMIT_UP');
    }

    if (!flags.length) {
        return { flags: [], penalty: 0, labels: [], available: true };
    }

    const penalty = Math.min(
        maxPenalty,
        flags.reduce((sum, f) => sum + (pen[f] ?? 0), 0),
    );
    return {
        flags,
        penalty,
        labels: flags.map((f) => LABELS[f]),
        available: true,
    };
}
