// server/src/lib/radar-quality/institutional.ts
// REUSES tw-chips + tw-inst-streak. Always PREVIOUS_DAY. Never realtime foreign ID.

import { getChipRows, type TwChipRow } from '../tw-chips.ts';
import { getInstStreakMap } from '../tw-inst-streak.ts';
import type { RadarQualityConfig } from './config.ts';
import type {
    ForeignBackground,
    InstitutionalContinuation,
    InstitutionalSnapshot,
    RadarQualityInput,
} from './types.ts';

const EMPTY_INST: InstitutionalSnapshot = {
    foreign_net_buy_shares: null,
    foreign_buy_shares: null,
    foreign_sell_shares: null,
    investment_trust_net_buy: null,
    dealer_net_buy: null,
    foreign_net_buy_1d: null,
    foreign_net_buy_3d: null,
    foreign_net_buy_5d: null,
    institutional_net_buy_3d: null,
    institutional_net_buy_5d: null,
    foreign_buy_streak_days: null,
    foreign_net_buy_rank: null,
    foreign_net_buy_to_volume_ratio: null,
    source_trade_date: null,
    freshness: 'PREVIOUS_DAY',
    background: 'INSUFFICIENT_DATA',
    continuation: 'INSUFFICIENT_DATA',
    note: '昨日官方法人資料尚未載入',
};

function sumFirst(arr: number[] | undefined, n: number): number | null {
    if (!arr?.length) return null;
    let s = 0;
    for (let i = 0; i < Math.min(n, arr.length); i++) s += arr[i]!;
    return s;
}

export function classifyForeignBackground(
    chip: TwChipRow | null,
    cfg: RadarQualityConfig,
): ForeignBackground {
    if (!chip) return 'INSUFFICIENT_DATA';
    if (chip.trustNet >= cfg.trust_accumulation_min_shares) {
        return 'TRUST_ACCUMULATION';
    }
    if (chip.foreignNet >= cfg.foreign_strong_accumulation_min_shares) {
        return 'FOREIGN_STRONG_ACCUMULATION';
    }
    if (chip.foreignNet >= cfg.foreign_accumulation_min_shares) {
        return 'FOREIGN_ACCUMULATION';
    }
    if (chip.foreignNet <= cfg.foreign_distribution_max_shares) {
        return 'FOREIGN_DISTRIBUTION';
    }
    return 'FOREIGN_NEUTRAL';
}

export function evaluateContinuation(
    background: ForeignBackground,
    input: Pick<
        RadarQualityInput,
        | 'c_score'
        | 'bp_score'
        | 'vwap_pos_pct'
        | 'volume_acceleration'
        | 'sector_state'
        | 'momentum_acceleration'
        | 'rank_velocity'
    >,
): InstitutionalContinuation {
    if (
        background === 'INSUFFICIENT_DATA' ||
        background === 'FOREIGN_NEUTRAL'
    ) {
        return background === 'INSUFFICIENT_DATA'
            ? 'INSUFFICIENT_DATA'
            : 'WAITING_CONFIRMATION';
    }

    const positiveBg =
        background === 'FOREIGN_STRONG_ACCUMULATION' ||
        background === 'FOREIGN_ACCUMULATION' ||
        background === 'TRUST_ACCUMULATION';
    const negativeBg = background === 'FOREIGN_DISTRIBUTION';

    const bp = input.bp_score ?? 0;
    const c = input.c_score ?? 0;
    const vwap = input.vwap_pos_pct ?? -999;
    const vol = input.volume_acceleration ?? 0;
    const sec = (input.sector_state ?? '').toUpperCase();
    const rotatingIn =
        sec.includes('ROTATING_IN') ||
        sec.includes('HOT') ||
        sec.includes('LEADING');
    const rotatingOut = sec.includes('ROTATING_OUT');
    const momOk = (input.momentum_acceleration ?? 0) > 0;
    const rankOk = (input.rank_velocity ?? 0) > 0;

    const strongToday =
        c >= 80 &&
        bp >= 70 &&
        vwap >= 0 &&
        vol > 0 &&
        (rotatingIn || momOk || rankOk);

    const weakToday =
        bp <= 40 ||
        vwap < -1 ||
        rotatingOut ||
        ((input.momentum_acceleration ?? 0) <= 0 &&
            (input.volume_acceleration ?? 0) <= 0 &&
            (input.rank_velocity ?? 0) <= 0);

    const partialToday =
        (bp >= 55 || c >= 75 || vwap >= 0 || vol > 0) && !weakToday;

    if (positiveBg) {
        if (strongToday) return 'CONFIRMED_CONTINUATION';
        if (weakToday) return rotatingOut || bp <= 30 ? 'REJECTED' : 'DIVERGENCE';
        if (partialToday) return 'PARTIAL_CONTINUATION';
        return 'WAITING_CONFIRMATION';
    }

    if (negativeBg) {
        if (strongToday) return 'DIVERGENCE';
        if (weakToday) return 'REJECTED';
        return 'WAITING_CONFIRMATION';
    }

    return 'WAITING_CONFIRMATION';
}

export function backgroundLabel(bg: ForeignBackground): string {
    switch (bg) {
        case 'FOREIGN_STRONG_ACCUMULATION':
            return '昨日外資大幅買超';
        case 'FOREIGN_ACCUMULATION':
            return '昨日外資買超';
        case 'TRUST_ACCUMULATION':
            return '昨日投信買超';
        case 'FOREIGN_DISTRIBUTION':
            return '昨日外資賣超';
        case 'FOREIGN_NEUTRAL':
            return '法人背景中性';
        default:
            return '法人資料不足';
    }
}

export function continuationLabel(c: InstitutionalContinuation): string {
    switch (c) {
        case 'CONFIRMED_CONTINUATION':
            return '昨日法人買超，今日盤中續強';
        case 'PARTIAL_CONTINUATION':
            return '法人背景偏正向，今日部分確認';
        case 'DIVERGENCE':
            return '法人背景與今日盤面背離';
        case 'REJECTED':
            return '法人續強未獲今日確認';
        case 'WAITING_CONFIRMATION':
            return '等待今日盤中確認';
        default:
            return '法人續強資料不足';
    }
}

export async function loadInstitutionalMap(
    symbols: string[],
    cfg: RadarQualityConfig,
): Promise<Map<string, InstitutionalSnapshot>> {
    const out = new Map<string, InstitutionalSnapshot>();
    if (!symbols.length) return out;

    let chips: Map<string, TwChipRow> = new Map();
    try {
        const bundle = await getChipRows(symbols);
        for (const row of bundle.rows) {
            chips.set(row.code, row);
        }
    } catch {
        chips = new Map();
    }

    let streaks = new Map<
        string,
        { streak: number; lastInstNet: number; asOf?: string }
    >();
    try {
        streaks = await getInstStreakMap(symbols);
    } catch {
        streaks = new Map();
    }

    // Rank by foreign net among loaded chips (previous-day).
    const ranked = [...chips.values()]
        .filter((r) => Number.isFinite(r.foreignNet))
        .sort((a, b) => b.foreignNet - a.foreignNet);
    const rankByCode = new Map<string, number>();
    ranked.forEach((r, i) => rankByCode.set(r.code, i + 1));

    for (const sym of symbols) {
        const chip = chips.get(sym) ?? null;
        const streak = streaks.get(sym);
        if (!chip && !streak) {
            out.set(sym, { ...EMPTY_INST });
            continue;
        }
        const background = classifyForeignBackground(chip, cfg);
        // 3d/5d: reuse streak series only exposes lastInstNet + streak days.
        // Partial: 1d from chips; multi-day institutional from streak note.
        const inst3 = streak?.lastInstNet != null ? streak.lastInstNet : null;
        const snap: InstitutionalSnapshot = {
            foreign_net_buy_shares: chip?.foreignNet ?? null,
            foreign_buy_shares: null,
            foreign_sell_shares: null,
            investment_trust_net_buy: chip?.trustNet ?? null,
            dealer_net_buy: chip?.dealerNet ?? null,
            foreign_net_buy_1d: chip?.foreignNet ?? null,
            foreign_net_buy_3d: null, // foreign multi-day series not in streak cache
            foreign_net_buy_5d: null,
            institutional_net_buy_3d: inst3,
            institutional_net_buy_5d: null,
            foreign_buy_streak_days:
                streak && streak.streak > 0 ? streak.streak : null,
            foreign_net_buy_rank: rankByCode.get(sym) ?? null,
            foreign_net_buy_to_volume_ratio: null,
            source_trade_date: chip?.asOf ?? streak?.asOf ?? null,
            freshness: 'PREVIOUS_DAY',
            background,
            continuation: 'WAITING_CONFIRMATION',
            note: `${backgroundLabel(background)}（Previous-Day / T+1，非即時外資身份）`,
        };
        out.set(sym, snap);
    }

    // Silence unused sumFirst until multi-day foreign series is wired.
    void sumFirst;
    return out;
}

export function attachContinuation(
    inst: InstitutionalSnapshot,
    input: RadarQualityInput,
): InstitutionalSnapshot {
    const continuation = evaluateContinuation(inst.background, input);
    return {
        ...inst,
        continuation,
        note: `${backgroundLabel(inst.background)} · ${continuationLabel(continuation)}`,
    };
}

/** Guard: forbidden realtime foreign copy. */
export const FORBIDDEN_FOREIGN_PHRASES = [
    '今天外資正在買',
    '外資正在掃貨',
    '外資今天大買',
    '外資持續進場',
    '外資正在買',
] as const;

export function containsForbiddenForeignWording(text: string): boolean {
    return FORBIDDEN_FOREIGN_PHRASES.some((p) => text.includes(p));
}
