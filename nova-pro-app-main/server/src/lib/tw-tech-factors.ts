// server/src/lib/tw-tech-factors.ts — multi-day technicals from Yahoo daily bars

import { fetchTwDailyBars, type DailyBar } from './tw-daily-bars.ts';

export interface TechFactors {
    volRatio20: number;
    rs20: number;
    nearHigh20: number; // close / 20d high (0..1+)
    aboveMa20: boolean;
    ma20: number;
    avgVol20: number;
    samples: number;
    /** Additive strength nudge −8..+12 */
    techDelta: number;
    notes: string[];
}

function avg(xs: number[]): number {
    if (!xs.length) return 0;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function computeTechFactors(bars: DailyBar[]): TechFactors | null {
    if (bars.length < 15) return null;
    const last = bars[bars.length - 1]!;
    const win = bars.slice(-21);
    const prev = win.slice(0, -1);
    if (prev.length < 10) return null;

    const closes = prev.map((b) => b.close);
    const highs = prev.map((b) => b.high);
    const vols = prev.map((b) => b.volume).filter((v) => v > 0);
    const ma20 = avg(closes.slice(-20));
    const high20 = Math.max(...highs.slice(-20));
    const avgVol20 = avg(vols.slice(-20));
    const close20 = closes[Math.max(0, closes.length - 20)] ?? closes[0]!;

    const volRatio20 =
        avgVol20 > 0 ? last.volume / avgVol20 : last.volume > 0 ? 1.2 : 1;
    const rs20 = close20 > 0 ? last.close / close20 - 1 : 0;
    const nearHigh20 = high20 > 0 ? last.close / high20 : 1;
    const aboveMa20 = ma20 > 0 && last.close >= ma20;

    const notes: string[] = [];
    let techDelta = 0;

    if (volRatio20 >= 2) {
        techDelta += 6;
        notes.push(`量比20 ${volRatio20.toFixed(1)}x`);
    } else if (volRatio20 >= 1.4) {
        techDelta += 4;
        notes.push(`量比20 ${volRatio20.toFixed(1)}x`);
    } else if (volRatio20 < 0.7) {
        techDelta -= 2;
    }

    if (rs20 >= 0.12) {
        techDelta += 4;
        notes.push(`20日相對強 ${(rs20 * 100).toFixed(1)}%`);
    } else if (rs20 >= 0.05) {
        techDelta += 2;
    } else if (rs20 <= -0.1) {
        techDelta -= 3;
    }

    if (nearHigh20 >= 0.97) {
        techDelta += 3;
        notes.push('近20日高點');
    } else if (nearHigh20 >= 0.92 && nearHigh20 < 0.97) {
        techDelta += 2;
        notes.push('回檔近高');
    }

    if (aboveMa20) {
        techDelta += 2;
        notes.push('站上MA20');
    } else {
        techDelta -= 1;
    }

    techDelta = Math.max(-8, Math.min(12, techDelta));

    return {
        volRatio20: +volRatio20.toFixed(3),
        rs20: +rs20.toFixed(4),
        nearHigh20: +nearHigh20.toFixed(4),
        aboveMa20,
        ma20: +ma20.toFixed(2),
        avgVol20,
        samples: bars.length,
        techDelta,
        notes,
    };
}

export async function fetchTechFactorsBatch(
    codes: string[],
    concurrency = 6,
): Promise<Map<string, TechFactors>> {
    const out = new Map<string, TechFactors>();
    for (let i = 0; i < codes.length; i += concurrency) {
        const chunk = codes.slice(i, i + concurrency);
        const hits = await Promise.all(
            chunk.map(async (code) => {
                try {
                    const bars = await fetchTwDailyBars(code, '3mo');
                    const f = computeTechFactors(bars);
                    return f ? ([code, f] as const) : null;
                } catch {
                    return null;
                }
            }),
        );
        for (const h of hits) {
            if (h) out.set(h[0], h[1]);
        }
    }
    return out;
}
