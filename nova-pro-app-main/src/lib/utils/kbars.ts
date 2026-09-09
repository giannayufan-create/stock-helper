// src/lib/utils/kbars.ts — KBars column arrays -> candles, aggregation

import type { Candle, KBars } from '../types/market';

// kbar datetimes are Taiwan local; encode wall-clock as UTC so the chart
// axis shows Taiwan session times regardless of viewer timezone.
export function wallClockToUtc(dt: string): number {
    const y = Number(dt.slice(0, 4));
    const mo = Number(dt.slice(5, 7));
    const d = Number(dt.slice(8, 10));
    const h = Number(dt.slice(11, 13)) || 0;
    const mi = Number(dt.slice(14, 16)) || 0;
    const s = Number(dt.slice(17, 19)) || 0;
    return Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
}

export function kbarsToCandles(k: KBars): Candle[] {
    const out: Candle[] = [];
    for (let i = 0; i < k.datetime.length; i++) {
        const dt = k.datetime[i];
        if (!dt) continue;
        out.push({
            time: wallClockToUtc(dt),
            open: k.Open[i] ?? 0,
            high: k.High[i] ?? 0,
            low: k.Low[i] ?? 0,
            close: k.Close[i] ?? 0,
            volume: k.Volume[i] ?? 0,
        });
    }
    out.sort((a, b) => a.time - b.time);
    return sanitizeCandles(out);
}

/** Drop invalid / duplicate times so lightweight-charts setData won't throw. */
export function sanitizeCandles(candles: Candle[]): Candle[] {
    const out: Candle[] = [];
    let prevTime = -Infinity;
    for (const c of candles) {
        if (
            !Number.isFinite(c.time) ||
            !Number.isFinite(c.open) ||
            !Number.isFinite(c.high) ||
            !Number.isFinite(c.low) ||
            !Number.isFinite(c.close) ||
            !(c.close > 0) ||
            !(c.high >= c.low)
        ) {
            continue;
        }
        const high = Math.max(c.high, c.open, c.close);
        const low = Math.min(c.low, c.open, c.close);
        if (c.time < prevTime) continue;
        if (c.time === prevTime) {
            const last = out[out.length - 1]!;
            last.high = Math.max(last.high, high);
            last.low = Math.min(last.low, low);
            last.close = c.close;
            last.volume += c.volume;
            continue;
        }
        out.push({
            time: c.time,
            open: c.open,
            high,
            low,
            close: c.close,
            volume: Number.isFinite(c.volume) ? c.volume : 0,
        });
        prevTime = c.time;
    }
    return out;
}

// Aggregate 1-minute candles into N-minute or daily bars.
export function aggregate(candles: Candle[], minutes: number): Candle[] {
    if (minutes <= 1) return sanitizeCandles(candles);
    const out: Candle[] = [];
    let cur: Candle | null = null;
    const bucketSec = minutes * 60;
    for (const c of candles) {
        const bucket =
            minutes >= 1440
                ? Math.floor(c.time / 86400) * 86400
                : Math.floor(c.time / bucketSec) * bucketSec;
        if (!cur || cur.time !== bucket) {
            if (cur) out.push(cur);
            cur = { ...c, time: bucket };
        } else {
            cur.high = Math.max(cur.high, c.high);
            cur.low = Math.min(cur.low, c.low);
            cur.close = c.close;
            cur.volume += c.volume;
        }
    }
    if (cur) out.push(cur);
    return sanitizeCandles(out);
}

export function dateStrOffset(daysAgo: number): string {
    // Use Taipei calendar day so from/to align with TW market + Fugle dates
    const ms = Date.now() - daysAgo * 86400_000;
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(ms));
}
