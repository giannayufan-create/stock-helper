// server/src/ai/chips-signal.ts — score 三大法人 + 融資券 into AI adj

import type { TwChipRow } from '../lib/tw-chips.ts';

export type ChipsBias = '偏多' | '偏空' | '中性';

export interface ChipsSignal {
    bias: ChipsBias;
    scoreAdj: number; // -16..+16
    strengthBoost: number; // 0..15 for screener
    label: string;
    summary: string;
    notes: string[];
    asOf?: string;
    foreignNet: number;
    trustNet: number;
    dealerNet: number;
    instNet: number;
    marginDelta: number;
    shortDelta: number;
    available: boolean;
}

function lots(shares: number): number {
    return shares / 1000;
}

function fmtLots(shares: number): string {
    const n = lots(shares);
    const sign = n > 0 ? '+' : '';
    if (Math.abs(n) >= 1000) return `${sign}${(n / 1000).toFixed(1)}千張`;
    return `${sign}${n.toFixed(0)}張`;
}

/** Classic TW chip reading: 法人方向 + 散戶融資反向確認 */
export function scoreChips(row: TwChipRow | null | undefined): ChipsSignal {
    if (!row) {
        return {
            bias: '中性',
            scoreAdj: 0,
            strengthBoost: 0,
            label: '籌碼資料不足',
            summary: '尚無三大法人／融資券公開資料（可能尚未公布或非上市櫃）。',
            notes: [],
            foreignNet: 0,
            trustNet: 0,
            dealerNet: 0,
            instNet: 0,
            marginDelta: 0,
            shortDelta: 0,
            available: false,
        };
    }

    const notes: string[] = [];
    let score = 0;

    const foreignLots = lots(row.foreignNet);
    const trustLots = lots(row.trustNet);
    const instLots = lots(row.instNet);
    const marginDelta = row.marginDelta;
    const shortDelta = row.shortDelta;

    // 外資／投信權重較高
    if (foreignLots >= 800) {
        score += 7;
        notes.push(`外資大買超 ${fmtLots(row.foreignNet)}`);
    } else if (foreignLots >= 200) {
        score += 4;
        notes.push(`外資買超 ${fmtLots(row.foreignNet)}`);
    } else if (foreignLots <= -800) {
        score -= 7;
        notes.push(`外資大賣超 ${fmtLots(row.foreignNet)}`);
    } else if (foreignLots <= -200) {
        score -= 4;
        notes.push(`外資賣超 ${fmtLots(row.foreignNet)}`);
    }

    if (trustLots >= 200) {
        score += 5;
        notes.push(`投信買超 ${fmtLots(row.trustNet)}`);
    } else if (trustLots >= 50) {
        score += 2;
        notes.push(`投信小買 ${fmtLots(row.trustNet)}`);
    } else if (trustLots <= -200) {
        score -= 5;
        notes.push(`投信賣超 ${fmtLots(row.trustNet)}`);
    } else if (trustLots <= -50) {
        score -= 2;
        notes.push(`投信小賣 ${fmtLots(row.trustNet)}`);
    }

    if (instLots >= 1000) score += 2;
    else if (instLots <= -1000) score -= 2;

    // 融資：增加偏散戶追價（利空確認）；減少＋法人買＝較健康
    if (marginDelta >= 1500) {
        score -= 4;
        notes.push(`融資大增 ${marginDelta}張（散戶追）`);
    } else if (marginDelta >= 400) {
        score -= 2;
        notes.push(`融資增加 ${marginDelta}張`);
    } else if (marginDelta <= -1500) {
        score += 3;
        notes.push(`融資大減 ${marginDelta}張（籌碼轉乾淨）`);
    } else if (marginDelta <= -400) {
        score += 2;
        notes.push(`融資減少 ${marginDelta}張`);
    }

    // 融券增加：偏空壓／軋空雙面；當沖防追空，隔夜略扣
    if (shortDelta >= 800) {
        score -= 2;
        notes.push(`融券大增 ${shortDelta}張`);
    } else if (shortDelta <= -500) {
        score += 1;
        notes.push(`融券減少 ${shortDelta}張`);
    }

    // 經典結構加分：法人買＋融資減
    if (instLots > 200 && marginDelta < -200) {
        score += 3;
        notes.push('法人買超＋融資減少（結構偏佳）');
    }
    // 經典結構扣分：法人賣＋融資增
    if (instLots < -200 && marginDelta > 200) {
        score -= 3;
        notes.push('法人賣超＋融資增加（結構偏弱）');
    }

    score = Math.max(-16, Math.min(16, Math.round(score)));

    let bias: ChipsBias = '中性';
    if (score >= 5) bias = '偏多';
    else if (score <= -5) bias = '偏空';

    let label = '籌碼中性';
    if (score >= 10) label = '籌碼強多';
    else if (score >= 5) label = '籌碼偏多';
    else if (score <= -10) label = '籌碼強空';
    else if (score <= -5) label = '籌碼偏空';

    const summary = notes.length
        ? `${label}（截至 ${row.asOf}）：${notes.slice(0, 3).join('；')}`
        : `${label}（截至 ${row.asOf}）：三大法人合計 ${fmtLots(row.instNet)}，融資變動 ${marginDelta}張`;

    const strengthBoost =
        score >= 10
            ? 15
            : score >= 5
              ? 10
              : score >= 2
                ? 5
                : score <= -10
                  ? 0
                  : score <= -5
                    ? 0
                    : 2;

    // For screener we want to boost bulls and lightly dampen weak chips via separate path;
    // strengthBoost here is additive for bullish chips only; bearish handled as penalty outside.
    return {
        bias,
        scoreAdj: score,
        strengthBoost: score > 0 ? strengthBoost : 0,
        label,
        summary,
        notes,
        asOf: row.asOf,
        foreignNet: row.foreignNet,
        trustNet: row.trustNet,
        dealerNet: row.dealerNet,
        instNet: row.instNet,
        marginDelta,
        shortDelta,
        available: true,
    };
}

export function screenerChipsDelta(signal: ChipsSignal): number {
    if (!signal.available) return 0;
    if (signal.scoreAdj >= 10) return 12;
    if (signal.scoreAdj >= 5) return 8;
    if (signal.scoreAdj >= 2) return 4;
    if (signal.scoreAdj <= -10) return -10;
    if (signal.scoreAdj <= -5) return -6;
    if (signal.scoreAdj <= -2) return -3;
    return 0;
}
