// server/src/ai/score.ts — local day-trade scoring (fallback when Python is down)

export type Stance = '看漲' | '看跌' | '盤整';

export interface AiBar {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface AnalyzeCore {
    score: number;
    stance: Stance;
    reasons: string[];
    entry?: number;
    stop?: number;
    take?: number;
    rr?: number;
    /** 上漲機率 0～100 */
    up_prob: number;
}

export function scoreToUpProb(score: number): number {
    const clamped = Math.max(-100, Math.min(100, score));
    const p = 1 / (1 + Math.exp(-clamped / 22));
    return Math.max(5, Math.min(95, Math.round(p * 100)));
}

function sma(closes: number[], n: number): number | null {
    if (closes.length < n) return null;
    let s = 0;
    for (let i = closes.length - n; i < closes.length; i++) s += closes[i]!;
    return s / n;
}

function rsi(closes: number[], n = 14): number | null {
    if (closes.length <= n) return null;
    let gains = 0;
    let losses = 0;
    for (let i = closes.length - n; i < closes.length; i++) {
        const d = closes[i]! - closes[i - 1]!;
        if (d >= 0) gains += d;
        else losses -= d;
    }
    if (losses === 0) return 100;
    const rs = gains / n / (losses / n);
    return 100 - 100 / (1 + rs);
}

function vwap(bars: AiBar[]): number | null {
    if (!bars.length) return null;
    const slice = bars.slice(-60);
    let pv = 0;
    let vol = 0;
    for (const b of slice) {
        pv += ((b.high + b.low + b.close) / 3) * b.volume;
        vol += b.volume;
    }
    if (vol <= 0) return bars[bars.length - 1]!.close;
    return pv / vol;
}

export function scoreBars(
    bars: AiBar[],
    stopPct = 0.01,
    takePct = 0.02,
): AnalyzeCore {
    if (bars.length < 30) {
        return {
            score: 0,
            stance: '盤整',
            reasons: ['資料量不足，至少需要 30 根 K 棒'],
            up_prob: 50,
        };
    }
    const closes = bars.map((b) => b.close);
    const close = closes[closes.length - 1]!;
    const ma20 = sma(closes, 20) ?? close;
    const ma60 = sma(closes, 60) ?? close;
    const lastVwap = vwap(bars) ?? close;
    const lastRsi = rsi(closes, 14) ?? 50;
    const prev = closes[closes.length - 2]!;
    const latestVol = bars[bars.length - 1]!.volume;
    const avg20Vol =
        bars.slice(-20).reduce((s, b) => s + b.volume, 0) / 20 || latestVol;

    let score = 0;
    const reasons: string[] = [];

    if (close > ma20) {
        score += 18;
        reasons.push('站上 MA20');
    } else {
        score -= 18;
        reasons.push('跌破 MA20');
    }
    if (close > ma60) {
        score += 14;
        reasons.push('長趨勢高於 MA60');
    } else {
        score -= 14;
        reasons.push('長趨勢低於 MA60');
    }
    if (close > lastVwap) {
        score += 12;
        reasons.push('現價高於 VWAP');
    } else {
        score -= 12;
        reasons.push('現價低於 VWAP');
    }

    const mom = ((close - prev) / (prev || close)) * 100;
    if (mom > 0.35) {
        score += 10;
        reasons.push('短線動能轉強');
    } else if (mom < -0.35) {
        score -= 10;
        reasons.push('短線動能轉弱');
    }

    if (lastRsi >= 55 && lastRsi <= 72) {
        score += 12;
        reasons.push(`RSI ${lastRsi.toFixed(1)} 偏多`);
    } else if (lastRsi <= 45 && lastRsi >= 28) {
        score -= 12;
        reasons.push(`RSI ${lastRsi.toFixed(1)} 偏空`);
    } else if (lastRsi > 72) {
        score -= 6;
        reasons.push(`RSI ${lastRsi.toFixed(1)} 過熱`);
    } else if (lastRsi < 28) {
        score += 6;
        reasons.push(`RSI ${lastRsi.toFixed(1)} 超賣反彈區`);
    }

    if (latestVol > avg20Vol * 1.35) {
        score += 8;
        reasons.push('量能放大');
    } else if (latestVol < avg20Vol * 0.7) {
        score -= 4;
        reasons.push('量能偏弱');
    }

    score = Math.max(-100, Math.min(100, Math.round(score)));
    const stance: Stance =
        score >= 18 ? '看漲' : score <= -18 ? '看跌' : '盤整';

    let entry: number | undefined;
    let stop: number | undefined;
    let take: number | undefined;
    let rr: number | undefined;
    if (stance === '看漲') {
        entry = +close.toFixed(2);
        stop = +(close * (1 - stopPct)).toFixed(2);
        take = +(close * (1 + takePct)).toFixed(2);
        rr = +(takePct / stopPct).toFixed(1);
    } else if (stance === '看跌') {
        entry = +close.toFixed(2);
        stop = +(close * (1 + stopPct)).toFixed(2);
        take = +(close * (1 - takePct)).toFixed(2);
        rr = +(takePct / stopPct).toFixed(1);
    }

    return {
        score,
        stance,
        reasons: reasons.slice(0, 4),
        entry,
        stop,
        take,
        rr,
        up_prob: scoreToUpProb(score),
    };
}

/** Recompute stance / levels after news + heat adjustments. */
export function finalizeScore(
    base: AnalyzeCore,
    adj: number,
    extraReasons: string[],
    stopPct = 0.01,
    takePct = 0.02,
    lastClose?: number,
): AnalyzeCore {
    let score = Math.max(
        -100,
        Math.min(100, Math.round(base.score + adj)),
    );
    const reasons = [...extraReasons, ...base.reasons].slice(0, 6);
    const stance: Stance =
        score >= 18 ? '看漲' : score <= -18 ? '看跌' : '盤整';

    const close = lastClose ?? base.entry ?? 0;
    let entry: number | undefined;
    let stop: number | undefined;
    let take: number | undefined;
    let rr: number | undefined;
    if (stance === '看漲' && close > 0) {
        entry = +close.toFixed(2);
        stop = +(close * (1 - stopPct)).toFixed(2);
        take = +(close * (1 + takePct)).toFixed(2);
        rr = +(takePct / stopPct).toFixed(1);
    } else if (stance === '看跌' && close > 0) {
        entry = +close.toFixed(2);
        stop = +(close * (1 + stopPct)).toFixed(2);
        take = +(close * (1 - takePct)).toFixed(2);
        rr = +(takePct / stopPct).toFixed(1);
    }

    return {
        score,
        stance,
        reasons,
        entry,
        stop,
        take,
        rr,
        up_prob: scoreToUpProb(score),
    };
}
