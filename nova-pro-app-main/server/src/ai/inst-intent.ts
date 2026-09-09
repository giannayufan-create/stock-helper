// server/src/ai/inst-intent.ts — 法人意圖：拉抬跟／出貨空／吃貨別追空
// Uses T+1 public 三大法人＋融資券 vs same-session (or recent) price change.
// Not 分點／盤中主力；heuristic only.

import type { ChipsSignal } from './chips-signal.ts';
import type { AiBar } from './score.ts';

export type InstIntentKind =
    | '拉抬跟進'
    | '出貨偏空'
    | '吃貨壓低'
    | '殺盤偏空'
    | '散戶追價'
    | '中性'
    | '資料不足';

export type InstPlaybook =
    | '可跟多'
    | '可偏空'
    | '別追空'
    | '別追多'
    | '觀望';

export interface InstIntent {
    intent: InstIntentKind;
    playbook: InstPlaybook;
    label: string;
    summary: string;
    scoreAdj: number; // -12..+12 into daytrade score
    conf: '低' | '中' | '高';
    drivers: string[];
    dayChangePct: number;
    asOf?: string;
    available: boolean;
    note: string;
}

function dayChangePct(bars: AiBar[]): number {
    if (bars.length < 2) return 0;
    const open = bars[Math.max(0, bars.length - 78)]!.open;
    const close = bars[bars.length - 1]!.close;
    if (!open) return 0;
    return ((close - open) / open) * 100;
}

function fmtLots(shares: number): string {
    const n = shares / 1000;
    const sign = n > 0 ? '+' : '';
    if (Math.abs(n) >= 1000) return `${sign}${(n / 1000).toFixed(1)}千張`;
    return `${sign}${n.toFixed(0)}張`;
}

/**
 * Correlate price move with institutional net + margin:
 * - 漲＋法人買 → 拉抬，可跟（融資大增則降級為散戶追價）
 * - 漲＋法人賣 → 出貨，別追多／可偏空
 * - 跌＋法人買 → 吃貨壓低，別追空
 * - 跌＋法人賣 → 殺盤偏空
 */
export function scoreInstIntent(
    chips: ChipsSignal | null | undefined,
    bars: AiBar[],
): InstIntent {
    const note =
        '法人淨額多為前一交易日公開資料（T+1），非盤中分點；意圖為啟發式非保證';
    const chg = dayChangePct(bars);

    if (!chips?.available) {
        return {
            intent: '資料不足',
            playbook: '觀望',
            label: '法人意圖不明',
            summary: '尚無三大法人／融資券資料，無法判讀拉抬或吃貨。',
            scoreAdj: 0,
            conf: '低',
            drivers: [],
            dayChangePct: +chg.toFixed(2),
            available: false,
            note,
        };
    }

    const instLots = chips.instNet / 1000;
    const margin = chips.marginDelta;
    const drivers: string[] = [];
    drivers.push(
        `價 ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}%｜法人合計 ${fmtLots(chips.instNet)}`,
    );
    if (chips.foreignNet)
        drivers.push(`外資 ${fmtLots(chips.foreignNet)}`);
    if (chips.trustNet) drivers.push(`投信 ${fmtLots(chips.trustNet)}`);
    if (margin)
        drivers.push(`融資 ${margin > 0 ? '+' : ''}${margin}張`);

    const instBuy = instLots >= 200;
    const instSell = instLots <= -200;
    const instBuyStrong = instLots >= 800;
    const instSellStrong = instLots <= -800;
    const priceUp = chg >= 1.2;
    const priceDown = chg <= -1.2;
    const priceFlat = !priceUp && !priceDown;
    const retailChase = margin >= 400 && instBuy;
    const marginDry = margin <= -200;

    let intent: InstIntentKind = '中性';
    let playbook: InstPlaybook = '觀望';
    let scoreAdj = 0;
    let conf: InstIntent['conf'] = '低';
    let label = '法人意圖中性';

    if (priceUp && instBuy) {
        if (retailChase) {
            intent = '散戶追價';
            playbook = '別追多';
            scoreAdj = -4;
            conf = '中';
            label = '法人買但融資跟→追價風險';
        } else {
            intent = '拉抬跟進';
            playbook = '可跟多';
            scoreAdj = instBuyStrong ? 10 : marginDry ? 9 : 6;
            conf = instBuyStrong || marginDry ? '高' : '中';
            label = marginDry
                ? '法人拉抬＋融資減（結構較乾）'
                : '法人拉抬，可留意跟多';
        }
    } else if (priceUp && instSell) {
        intent = '出貨偏空';
        playbook = '可偏空';
        scoreAdj = instSellStrong ? -10 : -7;
        conf = instSellStrong ? '高' : '中';
        label = '價漲法人賣→疑似拉高出貨';
    } else if (priceDown && instBuy) {
        intent = '吃貨壓低';
        playbook = '別追空';
        scoreAdj = instBuyStrong ? 8 : 5;
        conf = instBuyStrong || marginDry ? '高' : '中';
        label = '價跌法人買→疑似吃貨壓低，別追空';
    } else if (priceDown && instSell) {
        intent = '殺盤偏空';
        playbook = '可偏空';
        scoreAdj = instSellStrong ? -9 : -6;
        conf = '中';
        label = '價跌法人賣→殺盤／出貨偏空';
    } else if (priceFlat && instBuyStrong) {
        intent = '吃貨壓低';
        playbook = '別追空';
        scoreAdj = 4;
        conf = '中';
        label = '價平法人大買→默默吃貨';
    } else if (priceFlat && instSellStrong) {
        intent = '出貨偏空';
        playbook = '別追多';
        scoreAdj = -4;
        conf = '中';
        label = '價平法人大賣→默默出貨';
    } else if (retailChase) {
        intent = '散戶追價';
        playbook = '別追多';
        scoreAdj = -3;
        conf = '低';
        label = '融資明顯增加，追價風險';
    } else {
        // soft lean from chips alone
        if (chips.scoreAdj >= 6) {
            intent = '中性';
            playbook = '可跟多';
            scoreAdj = 2;
            label = '籌碼偏多但價未明顯配合';
        } else if (chips.scoreAdj <= -6) {
            intent = '中性';
            playbook = '可偏空';
            scoreAdj = -2;
            label = '籌碼偏空但價未明顯配合';
        }
    }

    const summary = `${label}（${playbook}｜信心${conf}）。${drivers.slice(0, 3).join('；')}`;

    return {
        intent,
        playbook,
        label,
        summary,
        scoreAdj: Math.max(-12, Math.min(12, scoreAdj)),
        conf,
        drivers,
        dayChangePct: +chg.toFixed(2),
        asOf: chips.asOf,
        available: true,
        note,
    };
}

export function instIntentDto(i: InstIntent) {
    return {
        intent: i.intent,
        playbook: i.playbook,
        label: i.label,
        summary: i.summary,
        score_adj: i.scoreAdj,
        conf: i.conf,
        drivers: i.drivers,
        day_change_pct: i.dayChangePct,
        as_of: i.asOf,
        available: i.available,
        note: i.note,
    };
}
