// server/src/ai/overnight-edge.ts — 隔夜收盤 → 次日開盤 歷史勝率
// Uses overnight screener-like rules on daily bars (not a guarantee).

import {
    fetchTwDailyBars,
    fetchTwDailyBarsBatch,
    type DailyBar,
} from '../lib/tw-daily-bars.ts';

export interface OvernightEdgeReport {
    code: string;
    samples: number;
    winRate: number; // % of long signals where next open > signal close
    avgGapPct: number;
    avgWinGapPct: number;
    avgLossGapPct: number;
    expectancyPct: number; // avg gap across samples
    maxDrawdownPct: number; // cumulative gap equity drawdown
    lastSignal: boolean;
    lastClose?: number;
    lastNextOpenHint: string;
    scoreAdj: number; // -10..+10 for AI
    strengthBoost: number; // -8..+10 for screener
    label: string;
    summary: string;
    note: string;
}

function pct(n: number, d: number): number {
    if (!d) return 0;
    return (n / d) * 100;
}

/** Mirror overnight screener: liquid-ish, not chasing, close strong / mild pullback */
export function overnightSignal(day: DailyBar, prev?: DailyBar): boolean {
    if (!(day.close > 0 && day.open > 0)) return false;
    const chg = prev ? pct(day.close - prev.close, prev.close) : pct(day.close - day.open, day.open);
    const rangePct = pct(day.high - day.low, day.close);
    const closeNearHigh = day.close >= day.high * 0.992;
    const pullback =
        day.close >= day.high * 0.965 && day.close < day.high * 0.992;
    const volOk = !prev?.volume || day.volume >= prev.volume * 0.85;

    if (chg > 6) return false; // 追過頭
    if (chg < -2) return false;
    if (rangePct < 1.2) return false;
    if (!volOk && day.volume < 500_000) return false;

    const strongClose = day.close >= day.open && (closeNearHigh || chg > 0);
    const healthyPullback = pullback && chg > 0 && chg <= 4;
    return strongClose || healthyPullback;
}

export function measureOvernightEdge(
    code: string,
    bars: DailyBar[],
): OvernightEdgeReport {
    const empty: OvernightEdgeReport = {
        code,
        samples: 0,
        winRate: 0,
        avgGapPct: 0,
        avgWinGapPct: 0,
        avgLossGapPct: 0,
        expectancyPct: 0,
        maxDrawdownPct: 0,
        lastSignal: false,
        lastNextOpenHint: '樣本不足',
        scoreAdj: 0,
        strengthBoost: 0,
        label: '隔夜樣本不足',
        summary: '日K不足，尚無法估隔夜→次開勝率。',
        note: '需要至少約 40 根日K；僅供參考，非未來保證。',
    };
    if (bars.length < 40) return empty;

    let samples = 0;
    let wins = 0;
    let gapSum = 0;
    let winGap = 0;
    let lossGap = 0;
    let equity = 0;
    let peak = 0;
    let maxDd = 0;

    for (let i = 1; i < bars.length - 1; i++) {
        const day = bars[i]!;
        const prev = bars[i - 1]!;
        const next = bars[i + 1]!;
        if (!overnightSignal(day, prev)) continue;
        const gap = pct(next.open - day.close, day.close);
        samples += 1;
        gapSum += gap;
        equity += gap;
        peak = Math.max(peak, equity);
        maxDd = Math.max(maxDd, peak - equity);
        if (gap > 0) {
            wins += 1;
            winGap += gap;
        } else {
            lossGap += gap;
        }
    }

    const last = bars[bars.length - 1]!;
    const prevLast = bars[bars.length - 2];
    const lastSignal = overnightSignal(last, prevLast);

    if (samples < 8) {
        return {
            ...empty,
            lastSignal,
            lastClose: last.close,
            samples,
            note: `僅 ${samples} 次歷史訊號，可信度偏低。`,
        };
    }

    const winRate = Math.round((wins / samples) * 100);
    const avgGapPct = +(gapSum / samples).toFixed(3);
    const avgWinGapPct = wins ? +(winGap / wins).toFixed(3) : 0;
    const losses = samples - wins;
    const avgLossGapPct = losses ? +(lossGap / losses).toFixed(3) : 0;
    const expectancyPct = avgGapPct;
    const maxDrawdownPct = +maxDd.toFixed(2);

    let scoreAdj = 0;
    let strengthBoost = 0;
    let label = '隔夜中性';
    if (winRate >= 58 && avgGapPct > 0.05) {
        scoreAdj = 8;
        strengthBoost = 10;
        label = '隔夜優勢偏強';
    } else if (winRate >= 53 && avgGapPct > 0) {
        scoreAdj = 4;
        strengthBoost = 6;
        label = '隔夜略有優勢';
    } else if (winRate <= 42 || avgGapPct < -0.08) {
        scoreAdj = -8;
        strengthBoost = -8;
        label = '隔夜歷史偏弱';
    } else if (winRate <= 47) {
        scoreAdj = -4;
        strengthBoost = -4;
        label = '隔夜勝率偏弱';
    }

    // if tonight also qualifies, nudge a bit
    if (lastSignal && scoreAdj > 0) scoreAdj = Math.min(10, scoreAdj + 1);
    if (lastSignal && scoreAdj < 0) scoreAdj = Math.max(-10, scoreAdj - 1);

    const summary =
        `${label}：近半年同規則 ${samples} 次，` +
        `次開上漲勝率 ${winRate}%` +
        `，平均跳空 ${avgGapPct > 0 ? '+' : ''}${avgGapPct}%` +
        (lastSignal ? '；今日收盤訊號仍符合隔夜規則' : '；今日收盤未觸發隔夜規則');

    return {
        code,
        samples,
        winRate,
        avgGapPct,
        avgWinGapPct,
        avgLossGapPct,
        expectancyPct,
        maxDrawdownPct,
        lastSignal,
        lastClose: last.close,
        lastNextOpenHint: lastSignal
            ? '若隔夜持有，歷史同規則次開勝率見上（非保證）'
            : '今日未達隔夜進場規則，報告僅供對照',
        scoreAdj,
        strengthBoost,
        label,
        summary,
        note: `隔夜→次開健康檢查（非未來保證）。最大累積回撤約 ${maxDrawdownPct}%（以跳空％加總近似）。`,
    };
}

export async function overnightEdgeForCode(
    code: string,
): Promise<OvernightEdgeReport> {
    const bars = await fetchTwDailyBars(code, '6mo');
    return measureOvernightEdge(code, bars);
}

export async function overnightEdgeForCodes(
    codes: string[],
): Promise<Record<string, OvernightEdgeReport>> {
    const map = await fetchTwDailyBarsBatch(codes.slice(0, 40), '6mo', 6);
    const out: Record<string, OvernightEdgeReport> = {};
    for (const code of codes.slice(0, 40)) {
        const bars = map.get(code) ?? [];
        out[code] = measureOvernightEdge(code, bars);
    }
    return out;
}

export function overnightEdgeDto(r: OvernightEdgeReport) {
    return {
        code: r.code,
        samples: r.samples,
        win_rate: r.winRate,
        avg_gap_pct: r.avgGapPct,
        avg_win_gap_pct: r.avgWinGapPct,
        avg_loss_gap_pct: r.avgLossGapPct,
        expectancy_pct: r.expectancyPct,
        max_drawdown_pct: r.maxDrawdownPct,
        last_signal: r.lastSignal,
        last_close: r.lastClose,
        label: r.label,
        summary: r.summary,
        note: r.note,
        score_adj: r.scoreAdj,
        strength_boost: r.strengthBoost,
    };
}
