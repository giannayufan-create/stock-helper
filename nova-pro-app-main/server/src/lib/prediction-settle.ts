// server/src/lib/prediction-settle.ts — settle screener picks against daily bars

import type { DailyBar } from './tw-daily-bars.ts';

export type SettleStatus =
    | 'open'
    | 'hit_tp'
    | 'hit_sl'
    | 'win'
    | 'loss'
    | 'flat';

export interface SettleInput {
    id: string;
    code: string;
    mode: 'intraday' | 'overnight';
    close: number;
    stopLossPct: number;
    takeProfitPct: number;
    signalDate: string; // YYYY-MM-DD
}

export interface SettleResult {
    id: string;
    status: SettleStatus;
    exitPrice?: number;
    pnlPct?: number;
    settledAt?: string;
    note?: string;
}

function pct(n: number, d: number): number {
    if (!d) return 0;
    return (n / d) * 100;
}

function classifyByMove(
    entry: number,
    exit: number,
    stopLossPct: number,
    takeProfitPct: number,
): { status: SettleStatus; pnlPct: number } {
    const pnlPct = pct(exit - entry, entry);
    if (pnlPct >= takeProfitPct) return { status: 'hit_tp', pnlPct };
    if (pnlPct <= -stopLossPct) return { status: 'hit_sl', pnlPct };
    if (pnlPct > 0.05) return { status: 'win', pnlPct };
    if (pnlPct < -0.05) return { status: 'loss', pnlPct };
    return { status: 'flat', pnlPct };
}

export function taipeiDateStr(d = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

/** Minutes from midnight in Asia/Taipei */
export function taipeiMinutesNow(d = new Date()): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Taipei',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(d);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return hour * 60 + minute;
}

function findSignalIdx(bars: DailyBar[], signalDate: string): number {
    const exact = bars.findIndex((b) => b.date === signalDate);
    if (exact >= 0) return exact;
    // last bar on or before signal date
    let best = -1;
    for (let i = 0; i < bars.length; i++) {
        if (bars[i]!.date <= signalDate) best = i;
        else break;
    }
    return best;
}

function intradayDayReady(signalDate: string, now = new Date()): boolean {
    const today = taipeiDateStr(now);
    if (signalDate < today) return true;
    if (signalDate > today) return false;
    // TW cash session ends ~13:30; allow buffer for Yahoo bar
    return taipeiMinutesNow(now) >= 13 * 60 + 40;
}

export function settleOne(
    input: SettleInput,
    bars: DailyBar[],
    now = new Date(),
): SettleResult {
    const entry = input.close;
    if (!(entry > 0) || bars.length < 1) {
        return { id: input.id, status: 'open', note: '無日K' };
    }

    const sigIdx = findSignalIdx(bars, input.signalDate);
    if (sigIdx < 0) {
        return { id: input.id, status: 'open', note: '尚無訊號日K' };
    }

    if (input.mode === 'overnight') {
        const next = bars[sigIdx + 1];
        if (!next) {
            return { id: input.id, status: 'open', note: '等待次日開盤' };
        }
        const { status, pnlPct } = classifyByMove(
            entry,
            next.open,
            input.stopLossPct,
            input.takeProfitPct,
        );
        return {
            id: input.id,
            status,
            exitPrice: next.open,
            pnlPct: Math.round(pnlPct * 100) / 100,
            settledAt: new Date().toISOString(),
            note: `次開 ${next.date}`,
        };
    }

    // intraday
    const day = bars[sigIdx]!;
    if (!intradayDayReady(input.signalDate, now)) {
        return { id: input.id, status: 'open', note: '當沖尚未收盤' };
    }

    const stop = entry * (1 - input.stopLossPct / 100);
    const target = entry * (1 + input.takeProfitPct / 100);
    const hitTp = day.high >= target;
    const hitSl = day.low <= stop;

    let status: SettleStatus;
    let exitPrice: number;
    if (hitTp && hitSl) {
        // ambiguous path — settle at close
        const c = classifyByMove(
            entry,
            day.close,
            input.stopLossPct,
            input.takeProfitPct,
        );
        status = c.status;
        exitPrice = day.close;
    } else if (hitTp) {
        status = 'hit_tp';
        exitPrice = target;
    } else if (hitSl) {
        status = 'hit_sl';
        exitPrice = stop;
    } else {
        const c = classifyByMove(
            entry,
            day.close,
            input.stopLossPct,
            input.takeProfitPct,
        );
        status = c.status;
        exitPrice = day.close;
    }

    const pnlPct = Math.round(pct(exitPrice - entry, entry) * 100) / 100;
    return {
        id: input.id,
        status,
        exitPrice,
        pnlPct,
        settledAt: new Date().toISOString(),
        note: `當日 ${day.date}`,
    };
}

export function settleBatch(
    inputs: SettleInput[],
    barMap: Map<string, DailyBar[]>,
    now = new Date(),
): SettleResult[] {
    return inputs.map((input) => {
        const bars = barMap.get(input.code.trim()) ?? [];
        return settleOne(input, bars, now);
    });
}
