// src/lib/indicators.ts — overlay indicator computations on candles

import type { Candle } from './types/market';

export interface IndicatorPoint {
    time: number;
    value: number;
}

export function sma(bars: Candle[], period: number): IndicatorPoint[] {
    const out: IndicatorPoint[] = [];
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
        sum += bars[i]!.close;
        if (i >= period) sum -= bars[i - period]!.close;
        if (i >= period - 1) {
            out.push({ time: bars[i]!.time, value: sum / period });
        }
    }
    return out;
}

export function ema(bars: Candle[], period: number): IndicatorPoint[] {
    const out: IndicatorPoint[] = [];
    const k = 2 / (period + 1);
    let prev: number | null = null;
    for (const b of bars) {
        prev = prev === null ? b.close : b.close * k + prev * (1 - k);
        out.push({ time: b.time, value: prev });
    }
    return out.slice(period);
}

export function bollinger(
    bars: Candle[],
    period = 20,
    mult = 2,
): { mid: IndicatorPoint[]; upper: IndicatorPoint[]; lower: IndicatorPoint[] } {
    const mid: IndicatorPoint[] = [];
    const upper: IndicatorPoint[] = [];
    const lower: IndicatorPoint[] = [];
    for (let i = period - 1; i < bars.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += bars[j]!.close;
        const mean = sum / period;
        let varSum = 0;
        for (let j = i - period + 1; j <= i; j++) {
            varSum += (bars[j]!.close - mean) ** 2;
        }
        const sd = Math.sqrt(varSum / period);
        const t = bars[i]!.time;
        mid.push({ time: t, value: mean });
        upper.push({ time: t, value: mean + mult * sd });
        lower.push({ time: t, value: mean - mult * sd });
    }
    return { mid, upper, lower };
}

// VWAP resets at each trading day boundary
export function vwap(bars: Candle[]): IndicatorPoint[] {
    const out: IndicatorPoint[] = [];
    let pv = 0;
    let vol = 0;
    let day = -1;
    for (const b of bars) {
        const d = Math.floor(b.time / 86400);
        if (d !== day) {
            day = d;
            pv = 0;
            vol = 0;
        }
        const typical = (b.high + b.low + b.close) / 3;
        pv += typical * b.volume;
        vol += b.volume;
        if (vol > 0) out.push({ time: b.time, value: pv / vol });
    }
    return out;
}

export function rsi(bars: Candle[], period = 14): IndicatorPoint[] {
    if (bars.length <= period) return [];
    const out: IndicatorPoint[] = [];
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i++) {
        const delta = bars[i]!.close - bars[i - 1]!.close;
        if (delta >= 0) gain += delta;
        else loss += Math.abs(delta);
    }
    let avgGain = gain / period;
    let avgLoss = loss / period;
    const firstRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out.push({
        time: bars[period]!.time,
        value: 100 - 100 / (1 + firstRs),
    });

    for (let i = period + 1; i < bars.length; i++) {
        const delta = bars[i]!.close - bars[i - 1]!.close;
        const g = delta > 0 ? delta : 0;
        const l = delta < 0 ? Math.abs(delta) : 0;
        avgGain = (avgGain * (period - 1) + g) / period;
        avgLoss = (avgLoss * (period - 1) + l) / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        out.push({
            time: bars[i]!.time,
            value: 100 - 100 / (1 + rs),
        });
    }
    return out;
}
