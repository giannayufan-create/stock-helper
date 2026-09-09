// server/src/lib/tw-money-flow.ts — 全市場法人買超排行 + 融資（散戶）標籤
// Built on TWSE/TPEx public chips cache (usually T+1).

import { scoreChips } from '../ai/chips-signal.ts';
import { ensureTwChipsLoaded, type TwChipRow } from './tw-chips.ts';

export type RetailTag = '籌碼乾' | '散戶追' | '中性' | '融資大減' | '融資大增';

export type MoneyFlowMode = 'inst_buy' | 'clean_buy' | 'chase_buy' | 'inst_sell';

export interface MoneyFlowRow {
    code: string;
    name: string;
    asOf: string;
    market: 'tse' | 'otc';
    foreignNet: number;
    trustNet: number;
    dealerNet: number;
    instNet: number;
    marginDelta: number;
    shortDelta: number;
    retailTag: RetailTag;
    quality: '優先布局' | '動能留意' | '避開' | '一般';
    label: string;
    scoreAdj: number;
}

function retailTag(marginDelta: number): RetailTag {
    if (marginDelta <= -1500) return '融資大減';
    if (marginDelta <= -400) return '籌碼乾';
    if (marginDelta >= 1500) return '融資大增';
    if (marginDelta >= 400) return '散戶追';
    return '中性';
}

function qualityOf(instNet: number, marginDelta: number): MoneyFlowRow['quality'] {
    const instLots = instNet / 1000;
    if (instLots > 200 && marginDelta < -200) return '優先布局';
    if (instLots > 200 && marginDelta > 400) return '動能留意';
    if (instLots < -200 && marginDelta > 200) return '避開';
    return '一般';
}

function toRow(row: TwChipRow): MoneyFlowRow {
    const signal = scoreChips(row);
    const tag = retailTag(row.marginDelta);
    return {
        code: row.code,
        name: row.name,
        asOf: row.asOf,
        market: row.market,
        foreignNet: row.foreignNet,
        trustNet: row.trustNet,
        dealerNet: row.dealerNet,
        instNet: row.instNet,
        marginDelta: row.marginDelta,
        shortDelta: row.shortDelta,
        retailTag: tag,
        quality: qualityOf(row.instNet, row.marginDelta),
        label: signal.label,
        scoreAdj: signal.scoreAdj,
    };
}

function filterMode(rows: MoneyFlowRow[], mode: MoneyFlowMode): MoneyFlowRow[] {
    switch (mode) {
        case 'inst_buy':
            return rows.filter((r) => r.instNet > 0);
        case 'clean_buy':
            // 法人買 + 融資減少／持平（籌碼較乾）
            return rows.filter(
                (r) => r.instNet > 200_000 && r.marginDelta <= 0,
            );
        case 'chase_buy':
            // 法人買 + 散戶融資增（動能／追價）
            return rows.filter(
                (r) => r.instNet > 200_000 && r.marginDelta >= 400,
            );
        case 'inst_sell':
            return rows.filter((r) => r.instNet < 0);
        default:
            return rows;
    }
}

export async function buildMoneyFlowRank(opts?: {
    mode?: MoneyFlowMode;
    limit?: number;
}): Promise<{
    asOf: string;
    mode: MoneyFlowMode;
    count: number;
    universe: number;
    rows: MoneyFlowRow[];
    note: string;
}> {
    const mode = opts?.mode ?? 'inst_buy';
    const limit = Math.min(100, Math.max(10, opts?.limit ?? 40));
    const bundle = await ensureTwChipsLoaded();
    const all = [...bundle.byCode.values()]
        .filter((r) => /^\d{4}$/.test(r.code)) // 一般股票 4 碼
        .map(toRow);

    let ranked = filterMode(all, mode);
    if (mode === 'inst_sell') {
        ranked.sort((a, b) => a.instNet - b.instNet);
    } else {
        ranked.sort(
            (a, b) =>
                b.instNet - a.instNet ||
                a.marginDelta - b.marginDelta ||
                b.scoreAdj - a.scoreAdj,
        );
    }

    // clean_buy: prefer 優先布局 first
    if (mode === 'clean_buy') {
        ranked.sort((a, b) => {
            const qa = a.quality === '優先布局' ? 2 : a.quality === '一般' ? 1 : 0;
            const qb = b.quality === '優先布局' ? 2 : b.quality === '一般' ? 1 : 0;
            return qb - qa || b.instNet - a.instNet;
        });
    }

    const rows = ranked.slice(0, limit);
    return {
        asOf: bundle.asOf,
        mode,
        count: rows.length,
        universe: all.length,
        rows,
        note:
            '資料為證交所／櫃買公開籌碼（通常 T+1）。' +
            '「優先布局」＝法人買超＋融資減少；「動能留意」＝法人買＋融資增（散戶追，慎追高）。非投資建議。',
    };
}

export function moneyFlowRowDto(r: MoneyFlowRow) {
    return {
        code: r.code,
        name: r.name,
        as_of: r.asOf,
        market: r.market,
        foreign_net: r.foreignNet,
        trust_net: r.trustNet,
        dealer_net: r.dealerNet,
        inst_net: r.instNet,
        margin_delta: r.marginDelta,
        short_delta: r.shortDelta,
        retail_tag: r.retailTag,
        quality: r.quality,
        label: r.label,
        score_adj: r.scoreAdj,
    };
}
