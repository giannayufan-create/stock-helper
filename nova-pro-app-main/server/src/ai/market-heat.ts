// server/src/ai/market-heat.ts — in-session vs after-hours buying heat

import type { AiBar } from './score.ts';

export interface MarketHeat {
    session: '盤內' | '盤外';
    label: string; // 買氣強 / 中性 / 賣壓
    score: number; // 0～100 heat toward buy
    scoreAdj: number; // -10..+10 for AI score
    buyVolRatio: number; // 0～1 green-bar volume share
    notes: string[];
}

function taipeiParts(now = new Date()): { hh: number; mm: number; day: number } {
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
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
        Sun: 0,
    };
    return { hh, mm, day: dayMap[wd] ?? 0 };
}

export function isTwSessionOpen(now = new Date()): boolean {
    const { hh, mm, day } = taipeiParts(now);
    if (day === 0 || day === 6) return false;
    const mins = hh * 60 + mm;
    // 09:00–13:30 continuous auction; treat 08:30–13:35 as in-session window
    return mins >= 8 * 60 + 30 && mins <= 13 * 60 + 35;
}

/** Estimate buy-side heat from recent bars (+ optional quote change). */
export function measureMarketHeat(
    bars: AiBar[],
    opts?: { changePct?: number; volumeRatio?: number },
): MarketHeat {
    const session = isTwSessionOpen() ? '盤內' : '盤外';
    const notes: string[] = [];
    const slice = bars.slice(-40);
    if (slice.length < 5) {
        return {
            session,
            label: '買氣不明',
            score: 50,
            scoreAdj: 0,
            buyVolRatio: 0.5,
            notes: ['K 棒不足，買氣暫以中性估計'],
        };
    }

    let buyVol = 0;
    let sellVol = 0;
    let flatVol = 0;
    for (const b of slice) {
        const v = Math.max(0, b.volume);
        if (b.close > b.open) buyVol += v;
        else if (b.close < b.open) sellVol += v;
        else flatVol += v;
    }
    const total = buyVol + sellVol + flatVol || 1;
    const buyVolRatio = buyVol / total;

    // recent momentum of last 8 bars
    const recent = slice.slice(-8);
    const upBars = recent.filter((b) => b.close > b.open).length;
    const recentStrength = upBars / recent.length;

    let score = Math.round(buyVolRatio * 55 + recentStrength * 35 + 10);
    if (opts?.changePct != null) {
        if (opts.changePct >= 2) {
            score += 6;
            notes.push(`日漲幅 ${opts.changePct.toFixed(1)}% 偏熱`);
        } else if (opts.changePct <= -2) {
            score -= 6;
            notes.push(`日跌幅 ${opts.changePct.toFixed(1)}% 偏冷`);
        }
    }
    if (opts?.volumeRatio != null && opts.volumeRatio >= 1.3) {
        score += 5;
        notes.push(`量比 ${opts.volumeRatio.toFixed(2)} 放大`);
    }
    score = Math.max(5, Math.min(95, score));

    // After hours: damp extremes — overnight gap risk
    let scoreAdj = Math.round((score - 50) / 5); // -9..+9
    if (session === '盤外') {
        scoreAdj = Math.round(scoreAdj * 0.7);
        notes.push('目前盤外：買氣參考最近交易時段，隔夜跳空風險較高');
    } else {
        notes.push('目前盤內：買氣依近端紅／綠量與短線強弱');
    }
    scoreAdj = Math.max(-10, Math.min(10, scoreAdj));

    let label = '買氣中性';
    if (score >= 68) label = '買氣偏強';
    else if (score >= 58) label = '買氣偏多';
    else if (score <= 32) label = '賣壓偏強';
    else if (score <= 42) label = '買氣偏弱';

    notes.unshift(
        `${session}${label}（紅量占比 ${(buyVolRatio * 100).toFixed(0)}%）`,
    );

    return { session, label, score, scoreAdj, buyVolRatio, notes };
}
