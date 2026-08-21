// src/lib/inst-trap.ts — detect common institutional "騙線" patterns for TW day-trade

import type { Candle } from './types/market';
import type { AiStance } from './ai-score-label';
import type { PriceStructure } from './price-structure';

export type TradeAction = '做多' | '做空' | '無法判定';

export interface TrapHit {
    /** Short label shown in UI */
    label: string;
    /** Why this looks like a trap */
    detail: string;
    severity: 'warn' | 'block';
}

export interface TrapReport {
    traps: TrapHit[];
    /** True when AI should refuse a directional call */
    blocked: boolean;
    action: TradeAction;
    actionReason: string;
}

function avgVol(bars: Candle[], n: number): number {
    const slice = bars.slice(-n);
    if (!slice.length) return 0;
    return slice.reduce((s, b) => s + b.volume, 0) / slice.length;
}

/**
 * Heuristics for common TW institutional traps:
 * - 假突破（突破後收回區間）
 * - 追高過熱 / 殺低超賣誘多誘空
 * - 量價背離
 * - 長影線拒絕（誘多／誘空針）
 * - 無量突破
 */
export function detectInstTraps(
    bars: Candle[],
    stance: AiStance,
    score: number,
    structure: PriceStructure | null | undefined,
): TrapReport {
    const traps: TrapHit[] = [];
    if (bars.length < 20) {
        return {
            traps: [],
            blocked: true,
            action: '無法判定',
            actionReason: 'K 棒不足，先不判斷方向',
        };
    }

    const last = bars[bars.length - 1]!;
    const prev = bars[bars.length - 2]!;
    const close = last.close;
    const range = Math.max(last.high - last.low, close * 0.0001);
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const body = Math.abs(last.close - last.open);
    const vol20 = avgVol(bars, 20);
    const volNow = last.volume;

    // RSI-like from last closes (reuse simple calc)
    let gains = 0;
    let losses = 0;
    for (let i = bars.length - 14; i < bars.length; i++) {
        if (i <= 0) continue;
        const d = bars[i]!.close - bars[i - 1]!.close;
        if (d >= 0) gains += d;
        else losses -= d;
    }
    const rs = losses === 0 ? 100 : gains / losses;
    const rsi = 100 - 100 / (1 + rs);

    // 1) Fake breakout: previous bar pierced swing, current closed back inside
    if (structure) {
        const piercedHigh =
            prev.high >= structure.resistance * 0.999 &&
            last.close < structure.resistance * 0.998;
        const piercedLow =
            prev.low <= structure.support * 1.001 &&
            last.close > structure.support * 1.002;
        if (piercedHigh) {
            traps.push({
                label: '假突破上檔',
                detail: `剛戳過壓力 ${structure.resistance} 又收回，常見法人誘多出貨。`,
                severity: 'block',
            });
        }
        if (piercedLow) {
            traps.push({
                label: '假跌破下檔',
                detail: `剛戳破支撐 ${structure.support} 又拉回，常見法人洗盤誘空。`,
                severity: 'block',
            });
        }
    }

    // 2) Breakout without volume
    if (
        structure &&
        (structure.bias === '突破上漲' || structure.bias === '突破下跌') &&
        vol20 > 0 &&
        volNow < vol20 * 0.9
    ) {
        traps.push({
            label: '無量突破',
            detail: '突破當根量能偏弱，假突破機率偏高，法人常這樣誘跟單。',
            severity: 'block',
        });
    }

    // 3) Chase overheat while bullish
    if ((stance === '看漲' || score >= 18) && rsi >= 72) {
        traps.push({
            label: '過熱追多',
            detail: `RSI ${rsi.toFixed(0)} 過熱還看漲，易變成法人拉高出貨的騙線。`,
            severity: 'block',
        });
    }

    // 4) Capitulation / oversold while bearish — bear trap
    if ((stance === '看跌' || score <= -18) && rsi <= 28) {
        traps.push({
            label: '超賣誘空',
            detail: `RSI ${rsi.toFixed(0)} 超賣還看跌，易變成法人壓低吸籌的騙線。`,
            severity: 'warn',
        });
    }

    // 5) Long upper wick rejection (shooting star) near highs
    if (upperWick > body * 1.6 && upperWick / range > 0.45 && last.close < last.open) {
        traps.push({
            label: '上影誘多針',
            detail: '長上影收黑：上方有人砸，追多容易被套在影線裡。',
            severity: 'block',
        });
    }

    // 6) Long lower wick rejection (hammer) near lows after selloff — caution shorts
    if (lowerWick > body * 1.6 && lowerWick / range > 0.45 && last.close > last.open) {
        traps.push({
            label: '下影洗盤針',
            detail: '長下影收紅：下方有承接，追空可能被軋。',
            severity: 'warn',
        });
    }

    // 7) Price-volume divergence on last 5 bars (up closes, down volume)
    const last5 = bars.slice(-5);
    if (last5.length === 5) {
        const upMoves = last5.filter((b, i) => i > 0 && b.close > last5[i - 1]!.close).length;
        const vols = last5.map((b) => b.volume);
        const volFalling = vols[4]! < vols[0]! * 0.85 && vols[3]! < vols[1]!;
        if (upMoves >= 3 && volFalling && stance === '看漲') {
            traps.push({
                label: '量價背離',
                detail: '價漲量縮：買盤不真實，法人常邊拉邊出。',
                severity: 'block',
            });
        }
        const downMoves = last5.filter((b, i) => i > 0 && b.close < last5[i - 1]!.close).length;
        const volRisingOnDrop = vols[4]! > vols[0]! * 1.35 && downMoves >= 3;
        if (volRisingOnDrop && stance === '看跌') {
            traps.push({
                label: '放量殺低',
                detail: '急殺放量：可能洗盤也完成也可能續崩，方向不乾淨。',
                severity: 'warn',
            });
        }
    }

    // 8) Conflicting structure vs score
    if (structure?.bias === '測試壓力' && stance === '看漲' && score < 55) {
        traps.push({
            label: '卡在壓力區',
            detail: '人還在壓力下方硬看漲，容易買在法人出貨區。',
            severity: 'warn',
        });
    }
    if (structure?.bias === '測試支撐' && stance === '看跌' && score > -55) {
        traps.push({
            label: '卡在支撐區',
            detail: '人還在支撐上方硬看跌，容易賣在法人承接區。',
            severity: 'warn',
        });
    }

    const blocked = traps.some((t) => t.severity === 'block');
    const abs = Math.abs(score);

    let action: TradeAction = '無法判定';
    let actionReason = '';

    if (blocked) {
        action = '無法判定';
        actionReason = `偵測到疑似法人騙線（${traps
            .filter((t) => t.severity === 'block')
            .map((t) => t.label)
            .join('、')}），先空手。`;
    } else if (stance === '盤整' || abs < 18) {
        action = '無法判定';
        actionReason = '方向不夠清楚，先觀望。';
    } else if (stance === '看漲' && abs >= 35) {
        action = '做多';
        actionReason =
            traps.length > 0
                ? `偏多可做，但仍注意：${traps.map((t) => t.label).join('、')}`
                : '條件相對乾淨，偏向做多（仍須掛停損）。';
    } else if (stance === '看跌' && abs >= 35) {
        action = '做空';
        actionReason =
            traps.length > 0
                ? `偏空可做，但仍注意：${traps.map((t) => t.label).join('、')}`
                : '條件相對乾淨，偏向做空（仍須掛停損）。';
    } else {
        action = '無法判定';
        actionReason = '訊號偏弱，寧可錯過不追。';
    }

    return { traps, blocked, action, actionReason };
}

/** Classify a reason string as good (紅) or danger (綠) for TW convention. */
export function reasonTone(text: string): 'good' | 'danger' | 'neutral' {
    if (
        /過熱|超賣|跌破|低於|轉弱|偏弱|偏空|誘|假|背離|洗盤|危險|不足|不明|卡在|無量/.test(
            text,
        )
    ) {
        return 'danger';
    }
    if (
        /站上|高於|轉強|偏多|放量|突破上漲|支撐|動能/.test(text) &&
        !/誘|假|背離/.test(text)
    ) {
        return 'good';
    }
    return 'neutral';
}
