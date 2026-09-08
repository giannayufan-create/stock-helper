// server/src/ai/daytrade-verdict.ts — practical day-trade decision layer
// Integrates session weights, trap dominance, screener alignment, risk sizing.
// Also runs a lightweight rule micro-backtest on the provided bars.

import type { AiBar, AnalyzeCore, Stance } from './score.ts';
import { scoreBars, scoreToUpProb } from './score.ts';

export type VerdictState = '可做' | '可觀察' | '勿追';
export type SessionPhase = '開盤' | '午前' | '午盤' | '尾盤' | '盤外';

export interface DaytradeVerdict {
    state: VerdictState;
    headline: string;
    session: SessionPhase;
    sessionNote: string;
    traps: string[];
    align?: string;
    risk: {
        stopPct: number;
        takePct: number;
        rr: number;
        sizeHint: '輕倉' | '標準' | '不加碼';
        riskNote: string;
    };
    microBacktest: {
        samples: number;
        winRate: number;
        avgRr: number;
        maxDrawdownPct: number;
        note: string;
    };
    scoreAdj: number;
    reasons: string[];
}

function taipeiMinutes(now = new Date()): { mins: number; weekday: number } {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Taipei',
        hour: '2-digit',
        minute: '2-digit',
        weekday: 'short',
        hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const hh = Number(get('hour'));
    const mm = Number(get('minute'));
    const wd = get('weekday');
    const dayMap: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
    };
    return { mins: hh * 60 + mm, weekday: dayMap[wd] ?? 0 };
}

export function sessionPhase(now = new Date()): SessionPhase {
    const { mins, weekday } = taipeiMinutes(now);
    if (weekday === 0 || weekday === 6) return '盤外';
    if (mins < 9 * 60 || mins >= 13 * 60 + 30) return '盤外';
    if (mins < 9 * 60 + 30) return '開盤';
    if (mins < 11 * 60) return '午前';
    if (mins < 12 * 60 + 30) return '午盤';
    return '尾盤';
}

function sessionWeight(phase: SessionPhase): { mult: number; note: string } {
    switch (phase) {
        case '開盤':
            return { mult: 0.85, note: '開盤波動大，訊號權重略降' };
        case '午前':
            return { mult: 1.05, note: '午前趨勢較穩，權重略升' };
        case '午盤':
            return { mult: 0.95, note: '午盤常震盪，權重略降' };
        case '尾盤':
            return { mult: 0.75, note: '尾盤易被軋／出貨，權重明顯降低' };
        default:
            return { mult: 0.7, note: '盤外僅供布局參考，隔夜跳空風險高' };
    }
}

function dayChangePct(bars: AiBar[]): number {
    if (bars.length < 2) return 0;
    // approximate session open = first bar open of last ~78 five-min bars,
    // or first bar if short
    const open = bars[Math.max(0, bars.length - 78)]!.open;
    const close = bars[bars.length - 1]!.close;
    if (!open) return 0;
    return ((close - open) / open) * 100;
}

function nearLimitUp(bars: AiBar[]): boolean {
    // TW common stock ±10%; treat ≥9% as near limit
    return dayChangePct(bars) >= 9;
}

function atrPct(bars: AiBar[], n = 14): number {
    if (bars.length < n + 1) return 1;
    let sum = 0;
    for (let i = bars.length - n; i < bars.length; i++) {
        const b = bars[i]!;
        const prev = bars[i - 1]!.close;
        const tr = Math.max(
            b.high - b.low,
            Math.abs(b.high - prev),
            Math.abs(b.low - prev),
        );
        sum += tr;
    }
    const atr = sum / n;
    const close = bars[bars.length - 1]!.close || 1;
    return (atr / close) * 100;
}

function detectTrapLabels(
    bars: AiBar[],
    stance: Stance,
    score: number,
): string[] {
    const traps: string[] = [];
    if (bars.length < 20) return ['資料不足'];
    const last = bars[bars.length - 1]!;
    const prev = bars[bars.length - 2]!;
    const range = Math.max(last.high - last.low, last.close * 0.0001);
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const body = Math.abs(last.close - last.open);
    const chg = dayChangePct(bars);

    if (nearLimitUp(bars)) traps.push('接近漲停');
    if (chg >= 5 && (stance === '看漲' || score >= 18)) traps.push('已大漲追價');
    if (chg <= -5 && (stance === '看跌' || score <= -18)) traps.push('已大跌追空');

    if (upperWick > body * 1.8 && upperWick / range > 0.45 && stance === '看漲') {
        traps.push('上影線誘多');
    }
    if (lowerWick > body * 1.8 && lowerWick / range > 0.45 && stance === '看跌') {
        traps.push('下影線誘空');
    }

    // fake poke: prev extreme then reclaim
    if (prev.high > last.high && last.close < prev.open && stance === '看漲') {
        traps.push('假突破疑慮');
    }

    const vol20 =
        bars.slice(-20).reduce((s, b) => s + b.volume, 0) / 20 || 1;
    if (last.close > prev.high && last.volume < vol20 * 0.85) {
        traps.push('無量突破');
    }

    return traps;
}

/**
 * Walk recent bars, apply scoreBars on rolling windows, check if next bar
 * moved in predicted direction — rough in-sample health check only.
 */
export function microBacktest(bars: AiBar[]): DaytradeVerdict['microBacktest'] {
    const empty = {
        samples: 0,
        winRate: 0,
        avgRr: 0,
        maxDrawdownPct: 0,
        note: '樣本不足，尚無法做規則健康檢查',
    };
    if (bars.length < 50) return empty;

    let wins = 0;
    let samples = 0;
    let rrSum = 0;
    let equity = 0;
    let peak = 0;
    let maxDd = 0;
    const step = Math.max(1, Math.floor((bars.length - 40) / 24));

    for (let i = 40; i < bars.length - 1; i += step) {
        const window = bars.slice(0, i + 1);
        const core = scoreBars(window, 0.01, 0.02);
        if (core.stance === '盤整') continue;
        const now = bars[i]!.close;
        const next = bars[i + 1]!.close;
        const dir = core.stance === '看漲' ? 1 : -1;
        const ret = ((next - now) / now) * 100 * dir;
        samples += 1;
        if (ret > 0) wins += 1;
        rrSum += ret;
        equity += ret;
        peak = Math.max(peak, equity);
        maxDd = Math.max(maxDd, peak - equity);
    }

    if (samples < 5) return empty;
    const winRate = Math.round((wins / samples) * 100);
    const avgRr = +(rrSum / samples).toFixed(2);
    return {
        samples,
        winRate,
        avgRr,
        maxDrawdownPct: +maxDd.toFixed(2),
        note: `近端規則健康檢查：${samples} 次樣本，同向下一根勝率 ${winRate}%（僅供參考，非未來保證）`,
    };
}

export function buildDaytradeVerdict(input: {
    bars: AiBar[];
    core: AnalyzeCore;
    regulatory?: 'punish' | 'attention' | null;
    screenerStrength?: number | null;
}): DaytradeVerdict {
    const phase = sessionPhase();
    const { mult, note: sessionNote } = sessionWeight(phase);
    const traps = detectTrapLabels(
        input.bars,
        input.core.stance,
        input.core.score,
    );
    if (input.regulatory === 'punish') traps.push('處置股');
    if (input.regulatory === 'attention') traps.push('注意股');

    const chg = dayChangePct(input.bars);
    const atr = atrPct(input.bars);
    let scoreAdj = 0;
    const reasons: string[] = [];

    // session dampen/boost relative to |score|
    const sessionShift = Math.round(input.core.score * (mult - 1));
    scoreAdj += sessionShift;
    if (sessionShift) reasons.push(sessionNote);

    // trap dominance
    const hardTraps = traps.filter((t) =>
        ['接近漲停', '已大漲追價', '已大跌追空', '處置股', '無量突破', '假突破疑慮'].includes(
            t,
        ),
    );
    if (hardTraps.length) {
        scoreAdj -= 18 * hardTraps.length;
        reasons.push(`陷阱主導：${hardTraps.join('、')}`);
    } else if (traps.length) {
        scoreAdj -= 8;
        reasons.push(`警示：${traps.join('、')}`);
    }

    if (chg >= 4 && input.core.score > 0) {
        scoreAdj -= Math.min(15, Math.round(chg));
        reasons.push(`日漲 ${chg.toFixed(1)}% 防追`);
    }

    // screener alignment
    let align: string | undefined;
    const ss = input.screenerStrength;
    if (ss != null && ss >= 70) {
        if (input.core.score <= -10 || hardTraps.length) {
            align = '強但勿追';
            reasons.push('篩選偏強但 AI／風險偏空或有陷阱');
        } else if (input.core.score >= 18) {
            align = '篩選與 AI 同向偏多';
        } else {
            align = '篩選強、AI 觀望';
        }
    } else if (ss != null && ss < 45 && input.core.score >= 30) {
        align = 'AI 偏多但篩選偏弱';
    }

    const adjustedScore = Math.max(
        -100,
        Math.min(100, input.core.score + scoreAdj),
    );
    const micro = microBacktest(input.bars);

    // risk sizing
    const stopPct = Math.max(0.6, Math.min(1.8, +(atr * 0.9).toFixed(2))) / 100;
    const takePct = +(stopPct * 2).toFixed(4);
    const rr = +(takePct / stopPct).toFixed(2);
    let sizeHint: DaytradeVerdict['risk']['sizeHint'] = '不加碼';
    let riskNote = '方向或風險不允許加碼';
    if (
        hardTraps.length === 0 &&
        Math.abs(adjustedScore) >= 35 &&
        rr >= 1.8 &&
        micro.winRate >= 48
    ) {
        sizeHint = '標準';
        riskNote = `波動約 ${atr.toFixed(1)}%，停損約 ${(stopPct * 100).toFixed(1)}%，單筆風險請自控在本金 0.5%～1%`;
    } else if (
        hardTraps.length === 0 &&
        Math.abs(adjustedScore) >= 18 &&
        rr >= 1.5
    ) {
        sizeHint = '輕倉';
        riskNote = `訊號中等，建議輕倉；停損約 ${(stopPct * 100).toFixed(1)}%`;
    } else if (hardTraps.length) {
        riskNote = '有陷阱／追價風險，寧可空手';
    }

    // three-state
    let state: VerdictState = '可觀察';
    let headline = '可觀察，先看不急著進';
    if (
        hardTraps.length > 0 ||
        input.regulatory === 'punish' ||
        nearLimitUp(input.bars) ||
        (chg >= 5 && adjustedScore > 0) ||
        align === '強但勿追'
    ) {
        state = '勿追';
        headline =
            align === '強但勿追'
                ? '強但勿追：名單很熱，但現在不適合追'
                : `勿追：${hardTraps[0] ?? traps[0] ?? '風險偏高'}`;
    } else if (
        Math.abs(adjustedScore) >= 35 &&
        sizeHint !== '不加碼' &&
        (input.core.stance !== '盤整' || Math.abs(adjustedScore) >= 35)
    ) {
        state = '可做';
        headline =
            adjustedScore >= 35
                ? `可做偏多（輕看風險：${sizeHint}）`
                : `可做偏空（輕看風險：${sizeHint}）`;
    } else {
        state = '可觀察';
        headline = '可觀察：分數或時段不夠乾淨，先等確認';
    }

    // micro-backtest too weak → never upgrade to 可做
    if (state === '可做' && micro.samples >= 5 && micro.winRate < 42) {
        state = '可觀察';
        headline = '可觀察：近端規則健康檢查偏弱，先別當進場依據';
        sizeHint = '不加碼';
    }

    return {
        state,
        headline,
        session: phase,
        sessionNote,
        traps,
        align,
        risk: {
            stopPct: +(stopPct * 100).toFixed(2),
            takePct: +(takePct * 100).toFixed(2),
            rr,
            sizeHint,
            riskNote,
        },
        microBacktest: micro,
        scoreAdj,
        reasons,
    };
}

export function applyVerdictToCore(
    core: AnalyzeCore,
    verdict: DaytradeVerdict,
    lastClose?: number,
    stopPct = 0.01,
    takePct = 0.02,
): AnalyzeCore {
    const score = Math.max(
        -100,
        Math.min(100, Math.round(core.score + verdict.scoreAdj)),
    );
    let stance: Stance =
        score >= 18 ? '看漲' : score <= -18 ? '看跌' : '盤整';
    if (verdict.state === '勿追') {
        // keep directional info but clear trade levels
        // stance from score still shown
    }
    const close = lastClose ?? core.entry ?? 0;
    const useStop = verdict.risk.stopPct / 100 || stopPct;
    const useTake = verdict.risk.takePct / 100 || takePct;
    let entry: number | undefined;
    let stop: number | undefined;
    let take: number | undefined;
    let rr: number | undefined;
    if (verdict.state === '可做' && stance !== '盤整' && close > 0) {
        entry = +close.toFixed(2);
        if (stance === '看漲') {
            stop = +(close * (1 - useStop)).toFixed(2);
            take = +(close * (1 + useTake)).toFixed(2);
        } else {
            stop = +(close * (1 + useStop)).toFixed(2);
            take = +(close * (1 - useTake)).toFixed(2);
        }
        rr = verdict.risk.rr;
    }
    return {
        score,
        stance,
        reasons: [...verdict.reasons, ...core.reasons].slice(0, 6),
        entry,
        stop,
        take,
        rr,
        up_prob: scoreToUpProb(score),
    };
}
