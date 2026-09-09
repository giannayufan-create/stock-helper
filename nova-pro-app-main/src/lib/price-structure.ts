// src/lib/price-structure.ts — breakout / support-resistance / target hints for day-trade

import type { Candle } from './types/market';

export type StructureBias =
    | '突破上漲'
    | '測試壓力'
    | '突破下跌'
    | '測試支撐'
    | '區間震盪';

export type StructureConfidence = '高' | '中' | '低';

export interface PriceStructure {
    bias: StructureBias;
    /** Near-term upside ceiling */
    resistance: number;
    /** Near-term downside floor */
    support: number;
    /** Primary predicted price if bias continues */
    target: number | null;
    /** Level that invalidates the idea */
    invalidation: number | null;
    confidence: StructureConfidence;
    hint: string;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function atrLike(bars: Candle[], period = 14): number {
    const slice = bars.slice(-Math.min(period, bars.length));
    if (slice.length === 0) return 0;
    let sum = 0;
    for (const b of slice) sum += Math.max(b.high - b.low, 0);
    return sum / slice.length;
}

/**
 * Structure from recent swings + last close.
 * Designed for intraday/swing: clear Chinese hint, not financial advice.
 */
export function analyzePriceStructure(bars: Candle[]): PriceStructure | null {
    if (bars.length < 20) return null;

    const last = bars[bars.length - 1]!;
    const close = last.close;
    if (!(close > 0)) return null;

    // Exclude last 2 bars when finding prior swing so breakouts are detectable
    const lookback = bars.slice(-Math.min(48, bars.length), -2);
    const base = lookback.length >= 10 ? lookback : bars.slice(0, -1);
    if (base.length < 8) return null;

    let swingHigh = base[0]!.high;
    let swingLow = base[0]!.low;
    for (const b of base) {
        if (b.high > swingHigh) swingHigh = b.high;
        if (b.low < swingLow) swingLow = b.low;
    }

    const daySlice = bars.slice(-Math.min(78, bars.length));
    let dayHigh = daySlice[0]!.high;
    let dayLow = daySlice[0]!.low;
    for (const b of daySlice) {
        if (b.high > dayHigh) dayHigh = b.high;
        if (b.low < dayLow) dayLow = b.low;
    }

    const resistance = round2(Math.max(swingHigh, dayHigh));
    const support = round2(Math.min(swingLow, dayLow));
    const range = Math.max(resistance - support, close * 0.004);
    const atr = Math.max(atrLike(bars, 14), close * 0.002);
    const nearPct = 0.004; // ~0.4%

    const prev = bars[bars.length - 2];
    const volNow = last.volume;
    const volAvg =
        bars.slice(-20).reduce((s, b) => s + b.volume, 0) / Math.min(20, bars.length) ||
        volNow;
    const volExpand = volNow > volAvg * 1.25;
    const bullBar = last.close >= last.open;
    const bearBar = last.close < last.open;

    const brokeUp = close > swingHigh * (1 + 0.0005) && bullBar;
    const brokeDown = close < swingLow * (1 - 0.0005) && bearBar;
    const nearResist = !brokeUp && close >= resistance * (1 - nearPct);
    const nearSupport = !brokeDown && close <= support * (1 + nearPct);

    let bias: StructureBias = '區間震盪';
    let target: number | null = null;
    let invalidation: number | null = null;
    let confidence: StructureConfidence = '低';
    let hint = '';

    if (brokeUp) {
        bias = '突破上漲';
        // Measured move: prior range projected up from breakout
        target = round2(resistance + range * 0.618);
        invalidation = round2(Math.max(support, resistance - atr));
        confidence = volExpand ? '高' : prev && prev.high >= swingHigh * 0.998 ? '中' : '中';
        hint = volExpand
            ? `放量突破近高 ${resistance}：上檔預測看 ${target}；若跌回 ${invalidation} 以下，突破可能失敗。`
            : `向上突破近高 ${resistance}（量能普通）：先看 ${target}；守不住 ${invalidation} 宜減碼／觀望。`;
    } else if (brokeDown) {
        bias = '突破下跌';
        target = round2(support - range * 0.618);
        invalidation = round2(Math.min(resistance, support + atr));
        confidence = volExpand ? '高' : '中';
        hint = volExpand
            ? `放量跌破近低 ${support}：下檔預測看 ${target}；若拉回站上 ${invalidation}，空方節奏可能中斷。`
            : `向下跌破近低 ${support}：下檔預測看 ${target}；反攻過 ${invalidation} 先別追空。`;
    } else if (nearResist) {
        bias = '測試壓力';
        // Don't set target = resistance (= often ≈ close). Show breakout objective.
        target = round2(resistance + Math.max(atr, range * 0.25));
        invalidation = round2(close - atr);
        confidence = '中';
        hint = `靠近上漲壓力 ${resistance}：未有效站上前回檔機率高；真突破後上看 ${target}。防守看 ${invalidation}。`;
    } else if (nearSupport) {
        bias = '測試支撐';
        target = round2(support - Math.max(atr, range * 0.25));
        invalidation = round2(close + atr);
        confidence = '中';
        hint = `靠近下跌支撐 ${support}：未有效跌破前反彈機率在；真跌破後往下看 ${target}。反彈失效看 ${invalidation}。`;
    } else {
        bias = '區間震盪';
        const mid = (resistance + support) / 2;
        // Upside objective when closer to mid/high; still keep target away from close
        if (close >= mid) {
            target = round2(Math.max(resistance, close + atr));
            invalidation = round2(support);
            hint = `落在 ${support}～${resistance} 區間上緣附近：先過壓力才看 ${target}；守不住支撐 ${support} 先觀望。`;
        } else {
            target = round2(Math.min(support, close - atr));
            invalidation = round2(resistance);
            hint = `落在 ${support}～${resistance} 區間下緣附近：跌破支撐看 ${target}；反彈壓力在 ${resistance}。`;
        }
        confidence = '低';
    }

    return {
        bias,
        resistance,
        support,
        target,
        invalidation,
        confidence,
        hint,
    };
}
