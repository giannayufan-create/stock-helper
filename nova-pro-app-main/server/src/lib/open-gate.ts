// server/src/lib/open-gate.ts — [B] OPEN GATE: open-quality gate for day-trade
// Stages B0/B1/B2 + open_score 0~100 across gap/rvol/price/momentum/chase.

import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MarketDataProvider } from '../providers/market-data.ts';
import type { Snapshot } from '../types/dto.ts';
import { fetchTwDailyBarsBatch, type DailyBar } from './tw-daily-bars.ts';
import { fetchRegulatoryLists } from '../providers/fugle/regulatory.ts';

export type OpenStage = 'B0' | 'B1' | 'B2' | 'AFTER';
export type OpenConfirmStatus =
    | 'provisional'
    | 'early'
    | 'pass'
    | 'watch'
    | 'reject'
    | 'n/a';

export interface OpenGateDims {
    gap: number;
    rvol: number;
    price: number;
    momentum: number;
    chase: number;
}

export interface OpenGateMetrics {
    prev_close: number;
    open: number;
    last: number;
    vwap: number | null;
    gap_pct: number;
    chg_from_open_pct: number;
    day_chg_pct: number;
    rvol_5: number | null;
    rvol_10: number | null;
    rvol_15: number | null;
    held_open: boolean;
    above_vwap: boolean;
    higher_highs: boolean;
    pullback_from_high_pct: number;
    session_minutes: number;
}

export interface OpenGateResult {
    code: string;
    name?: string;
    a_score?: number;
    as_of: string;
    stage: OpenStage;
    open_confirm: OpenConfirmStatus;
    open_score: number;
    dims: OpenGateDims;
    metrics: OpenGateMetrics;
    reasons: string[];
    tradable: boolean;
    lite?: boolean;
}

export interface OpenGateRunResult {
    stage: OpenStage;
    as_of: string;
    session_minutes: number;
    count: number;
    pass: number;
    watch: number;
    reject: number;
    items: OpenGateResult[];
    warnings: string[];
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

function taipeiParts(now = new Date()): {
    mins: number;
    weekday: number;
    ymd: string;
} {
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
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
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
    };
    const y = get('year');
    const mo = get('month');
    const d = get('day');
    return {
        mins: hh * 60 + mm,
        weekday: dayMap[wd] ?? 0,
        ymd: `${y}-${mo}-${d}`,
    };
}

/** Resolve OPEN GATE stage from Taipei clock. */
export function resolveOpenStage(now = new Date()): {
    stage: OpenStage;
    sessionMinutes: number;
} {
    const { mins, weekday } = taipeiParts(now);
    if (weekday === 0 || weekday === 6) {
        return { stage: 'AFTER', sessionMinutes: 0 };
    }
    const open = 9 * 60;
    const sessionMinutes = Math.max(0, mins - open);
    if (mins < open) return { stage: 'AFTER', sessionMinutes: 0 };
    if (mins < open + 3) return { stage: 'B0', sessionMinutes };
    if (mins < open + 10) return { stage: 'B1', sessionMinutes };
    if (mins < open + 30) return { stage: 'B2', sessionMinutes };
    return { stage: 'AFTER', sessionMinutes };
}

function scoreGap(gapPct: number): { score: number; note?: string } {
    // Ideal band +0.5% ~ +3.5%
    if (gapPct >= 0.5 && gapPct <= 3.5) {
        const mid = 2.0;
        const score = 100 - Math.abs(gapPct - mid) * 12;
        return {
            score: clamp(score, 70, 100),
            note: `開盤缺口 ${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(1)}%`,
        };
    }
    if (gapPct > 3.5 && gapPct <= 5) {
        return {
            score: clamp(70 - (gapPct - 3.5) * 15, 40, 70),
            note: `開盤偏熱 ${gapPct.toFixed(1)}%`,
        };
    }
    if (gapPct > 5) {
        return {
            score: clamp(35 - (gapPct - 5) * 8, 5, 35),
            note: `開盤過熱 ${gapPct.toFixed(1)}%`,
        };
    }
    if (gapPct >= 0) {
        return {
            score: 55 + gapPct * 20,
            note: `平盤附近開 ${gapPct.toFixed(1)}%`,
        };
    }
    if (gapPct >= -2) {
        return {
            score: clamp(45 + gapPct * 10, 25, 45),
            note: `低開 ${gapPct.toFixed(1)}%`,
        };
    }
    return {
        score: clamp(20 + gapPct * 5, 0, 25),
        note: `弱開 ${gapPct.toFixed(1)}%`,
    };
}

function scoreRvol(rvol: number | null): { score: number; note?: string } {
    if (rvol == null || !(rvol > 0)) {
        return { score: 40, note: '量能對比不足' };
    }
    if (rvol < 0.7) return { score: 15, note: `量能偏弱 ${rvol.toFixed(1)}x` };
    if (rvol < 1.0) return { score: 40, note: `量能普通 ${rvol.toFixed(1)}x` };
    if (rvol < 1.2) return { score: 60, note: `量能略增 ${rvol.toFixed(1)}x` };
    if (rvol <= 2.5) {
        return {
            score: clamp(70 + (rvol - 1.2) * 20, 70, 95),
            note: `開盤量能 ${rvol.toFixed(1)}x`,
        };
    }
    if (rvol <= 4) {
        return {
            score: clamp(90 - (rvol - 2.5) * 8, 70, 90),
            note: `爆量留意 ${rvol.toFixed(1)}x`,
        };
    }
    return {
        score: 55,
        note: `極端爆量 ${rvol.toFixed(1)}x（防假突破）`,
    };
}

function scorePrice(opts: {
    heldOpen: boolean;
    aboveVwap: boolean;
    chgFromOpen: number;
}): { score: number; notes: string[] } {
    let score = 50;
    const notes: string[] = [];
    if (opts.heldOpen) {
        score += 25;
        notes.push('守住開盤價');
    } else {
        score -= 30;
        notes.push('跌破開盤價');
    }
    if (opts.aboveVwap) {
        score += 20;
        notes.push('站上 VWAP');
    } else if (opts.aboveVwap === false) {
        score -= 15;
        notes.push('跌破 VWAP');
    }
    if (opts.chgFromOpen < -1.5) score -= 15;
    if (opts.chgFromOpen > 0.5 && opts.heldOpen) score += 5;
    return { score: clamp(score, 0, 100), notes };
}

function scoreMomentum(opts: {
    higherHighs: boolean;
    pullbackPct: number;
    chgFromOpen: number;
}): { score: number; notes: string[] } {
    let score = 50;
    const notes: string[] = [];
    if (opts.higherHighs) {
        score += 25;
        notes.push('高點持續墊高');
    } else {
        score -= 10;
        notes.push('高點未墊高');
    }
    if (opts.pullbackPct >= 2.5) {
        score -= 30;
        notes.push(`沖高回落 ${opts.pullbackPct.toFixed(1)}%`);
    } else if (opts.pullbackPct >= 1.2) {
        score -= 15;
        notes.push(`自高點回撤 ${opts.pullbackPct.toFixed(1)}%`);
    } else if (opts.pullbackPct < 0.6 && opts.chgFromOpen >= 0) {
        score += 15;
        notes.push('未明顯回落');
    }
    return { score: clamp(score, 0, 100), notes };
}

/** Higher = safer (less chase). */
function scoreChase(dayChgPct: number): { score: number; note?: string } {
    if (dayChgPct < 3) {
        return {
            score: 90,
            note: `漲幅 ${dayChgPct >= 0 ? '+' : ''}${dayChgPct.toFixed(1)}%，尚未過熱`,
        };
    }
    if (dayChgPct < 5) {
        return {
            score: 70,
            note: `漲幅 +${dayChgPct.toFixed(1)}%`,
        };
    }
    if (dayChgPct < 7) {
        return {
            score: 45,
            note: `漲幅 +${dayChgPct.toFixed(1)}%，追價風險升`,
        };
    }
    if (dayChgPct < 9) {
        return {
            score: 25,
            note: `漲幅 +${dayChgPct.toFixed(1)}%，偏熱`,
        };
    }
    return {
        score: 5,
        note: `逼近漲停 +${dayChgPct.toFixed(1)}%`,
    };
}

function estimateRvolFromSnapshot(
    snap: Snapshot,
    avgDayVolLots: number,
    sessionMinutes: number,
): number | null {
    if (!(avgDayVolLots > 0) || sessionMinutes <= 0) return null;
    // Snapshot total_volume often in 張 for TW brokers; Yahoo daily is shares.
    // Use volume_ratio if provider gives it; else scale by session fraction.
    if (snap.volume_ratio > 0) return snap.volume_ratio;
    const expected = avgDayVolLots * (sessionMinutes / 270);
    if (!(expected > 0)) return null;
    return snap.total_volume / expected;
}

function avgDailyVolumeLots(bars: DailyBar[]): number {
    const slice = bars.slice(-20);
    if (!slice.length) return 0;
    // Yahoo volume = shares → 張
    const vols = slice.map((b) => b.volume / 1000);
    return vols.reduce((a, b) => a + b, 0) / vols.length;
}

function inferPrevClose(snap: Snapshot, bars: DailyBar[] | undefined): number {
    if (bars && bars.length >= 2) {
        // last bar may be today partial; prefer previous complete
        const last = bars[bars.length - 1]!;
        const prev = bars[bars.length - 2]!;
        const today = taipeiParts().ymd;
        if (last.date === today && prev.close > 0) return prev.close;
        if (last.close > 0 && snap.close > 0) {
            // if change_price present
            if (Math.abs(snap.change_price) > 0) {
                const pc = snap.close - snap.change_price;
                if (pc > 0) return pc;
            }
        }
        return last.close;
    }
    if (Math.abs(snap.change_price) > 0) {
        const pc = snap.close - snap.change_price;
        if (pc > 0) return pc;
    }
    return snap.open || snap.close;
}

export function scoreOpenGateOne(input: {
    code: string;
    name?: string;
    aScore?: number;
    snap: Snapshot;
    bars?: DailyBar[];
    stage: OpenStage;
    sessionMinutes: number;
    punished?: boolean;
    lite?: boolean;
}): OpenGateResult {
    const { snap, stage, sessionMinutes } = input;
    const reasons: string[] = [];
    const prevClose = inferPrevClose(snap, input.bars);
    const open = snap.open > 0 ? snap.open : snap.close;
    const last = snap.close > 0 ? snap.close : open;
    const high = snap.high > 0 ? snap.high : Math.max(open, last);
    const low = snap.low > 0 ? snap.low : Math.min(open, last);
    const gapPct = prevClose > 0 ? ((open - prevClose) / prevClose) * 100 : 0;
    const chgFromOpen = open > 0 ? ((last - open) / open) * 100 : 0;
    const dayChg =
        prevClose > 0 ? ((last - prevClose) / prevClose) * 100 : snap.change_rate;
    const heldOpen = last >= open * 0.999;
    const vwap =
        snap.average_price > 0
            ? snap.average_price
            : (open + high + low + last) / 4;
    const aboveVwap = last >= vwap;
    const pullback =
        high > 0 ? ((high - last) / high) * 100 : 0;
    const higherHighs =
        high >= open && last >= (open + high) / 2 && chgFromOpen >= -0.3;

    const avgVol = input.bars ? avgDailyVolumeLots(input.bars) : 0;
    const rvolEst = estimateRvolFromSnapshot(snap, avgVol, Math.max(sessionMinutes, 1));
    // Approximate 5/10/15 from single estimate scaled (best-effort without minute bars)
    const scale = (n: number) =>
        rvolEst != null
            ? rvolEst * (Math.min(sessionMinutes, n) / Math.max(sessionMinutes, 1))
            : null;
    const rvol5 = sessionMinutes >= 3 ? rvolEst : scale(5);
    const rvol10 = sessionMinutes >= 5 ? rvolEst : null;
    const rvol15 = sessionMinutes >= 10 ? rvolEst : null;
    const rvolUse =
        (sessionMinutes >= 10 ? rvol15 : null) ??
        (sessionMinutes >= 5 ? rvol10 : null) ??
        rvol5 ??
        rvolEst;

    const g = scoreGap(gapPct);
    const r = scoreRvol(rvolUse);
    const p = scorePrice({
        heldOpen,
        aboveVwap,
        chgFromOpen,
    });
    const m = scoreMomentum({
        higherHighs,
        pullbackPct: pullback,
        chgFromOpen,
    });
    const c = scoreChase(dayChg);

    if (g.note) reasons.push(`${g.score >= 55 ? '+' : '-'} ${g.note}`);
    if (r.note) reasons.push(`${r.score >= 55 ? '+' : '-'} ${r.note}`);
    for (const n of p.notes) reasons.push(`${p.score >= 50 ? '+' : '-'} ${n}`);
    for (const n of m.notes) reasons.push(`${m.score >= 50 ? '+' : '-'} ${n}`);
    if (c.note) reasons.push(`${c.score >= 55 ? '+' : '-'} ${c.note}`);

    const dims: OpenGateDims = {
        gap: Math.round(g.score),
        rvol: Math.round(r.score),
        price: Math.round(p.score),
        momentum: Math.round(m.score),
        chase: Math.round(c.score),
    };

    let openScore = Math.round(
        0.15 * dims.gap +
            0.3 * dims.rvol +
            0.2 * dims.price +
            0.2 * dims.momentum +
            0.15 * dims.chase,
    );
    openScore = clamp(openScore, 0, 100);

    // Hard rejects
    let hardReject = false;
    if (input.punished) {
        hardReject = true;
        reasons.push('- 處置股');
    }
    if ((rvolUse ?? 0) < 0.7 && dayChg > 2) {
        hardReject = true;
        reasons.push('- 開高無量');
    }
    if (!heldOpen && !aboveVwap && (rvolUse ?? 0) < 1.2) {
        hardReject = true;
        reasons.push('- 跌破開盤且跌破VWAP');
    }
    if (dayChg >= 8) {
        hardReject = true;
        reasons.push('- 漲幅過熱（≥8%）');
    }

    let status: OpenConfirmStatus = 'watch';
    const lite = Boolean(input.lite);
    const passFloor = lite ? 75 : 70;
    const rvolFloor = lite ? 1.5 : 1.2;

    if (stage === 'AFTER') {
        // Outside open window: still score for logging / display, not tradable gate
        if (hardReject || openScore < 55) status = 'reject';
        else if (openScore >= passFloor && heldOpen && (rvolUse ?? 0) >= rvolFloor)
            status = 'pass';
        else if (openScore >= 55) status = 'watch';
        else status = 'reject';
    } else if (hardReject) {
        status = 'reject';
    } else if (stage === 'B0') {
        status = 'provisional';
    } else if (stage === 'B1') {
        if (openScore >= 75 && (rvolUse ?? 0) >= 1.5 && heldOpen) status = 'early';
        else if (openScore >= 55) status = 'watch';
        else status = 'reject';
    } else {
        // B2
        if (
            openScore >= passFloor &&
            heldOpen &&
            (rvolUse ?? 0) >= rvolFloor
        ) {
            status = 'pass';
        } else if (openScore >= 55) {
            status = 'watch';
        } else {
            status = 'reject';
        }
    }

    const { mins, weekday } = taipeiParts();
    // tradable only after B1 window ends ( >= 09:10 ) and during session
    const inSession =
        weekday !== 0 &&
        weekday !== 6 &&
        mins >= 9 * 60 + 10 &&
        mins < 13 * 60 + 30;
    const tradable = status === 'pass' && inSession;

    return {
        code: input.code,
        name: input.name,
        a_score: input.aScore,
        as_of: new Date().toISOString(),
        stage,
        open_confirm: status,
        open_score: openScore,
        dims,
        metrics: {
            prev_close: +prevClose.toFixed(2),
            open: +open.toFixed(2),
            last: +last.toFixed(2),
            vwap: vwap > 0 ? +vwap.toFixed(2) : null,
            gap_pct: +gapPct.toFixed(2),
            chg_from_open_pct: +chgFromOpen.toFixed(2),
            day_chg_pct: +dayChg.toFixed(2),
            rvol_5: rvol5 != null ? +rvol5.toFixed(2) : null,
            rvol_10: rvol10 != null ? +rvol10.toFixed(2) : null,
            rvol_15: rvol15 != null ? +rvol15.toFixed(2) : null,
            held_open: heldOpen,
            above_vwap: aboveVwap,
            higher_highs: higherHighs,
            pullback_from_high_pct: +pullback.toFixed(2),
            session_minutes: sessionMinutes,
        },
        reasons: reasons.slice(0, 8),
        tradable,
        lite,
    };
}

const LOG_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'data',
    'open-gate-logs',
);

export function appendOpenGateLog(rows: OpenGateResult[]): void {
    if (!rows.length) return;
    try {
        mkdirSync(LOG_DIR, { recursive: true });
        const ymd = taipeiParts().ymd;
        const path = join(LOG_DIR, `${ymd}.jsonl`);
        const lines =
            rows
                .map((r) =>
                    JSON.stringify({
                        symbol: r.code,
                        date: ymd,
                        a_score: r.a_score ?? null,
                        b_score: r.open_score,
                        b_status: r.open_confirm,
                        b_stage: r.stage,
                        b_reasons: r.reasons,
                        b_timestamp: r.as_of,
                        dims: r.dims,
                        metrics: r.metrics,
                        lite: Boolean(r.lite),
                        tradable: r.tradable,
                    }),
                )
                .join('\n') + '\n';
        appendFileSync(path, lines, 'utf8');
    } catch (err) {
        console.warn(
            'open-gate log failed:',
            err instanceof Error ? err.message : err,
        );
    }
}

export async function runOpenGate(opts: {
    market: MarketDataProvider;
    codes: Array<{ code: string; name?: string; a_score?: number }>;
    includeScannerSurges?: boolean;
    liteExtra?: Array<{ code: string; name?: string }>;
}): Promise<OpenGateRunResult> {
    const warnings: string[] = [];
    const { stage, sessionMinutes } = resolveOpenStage();
    const asOf = new Date().toISOString();

    let punish = new Set<string>();
    try {
        const lists = await fetchRegulatoryLists();
        punish = new Set(lists.code.filter(Boolean));
    } catch {
        warnings.push('處置名單暫不可用');
    }

    const pool = new Map<string, { code: string; name?: string; a_score?: number; lite?: boolean }>();
    for (const c of opts.codes) {
        if (!c.code) continue;
        pool.set(c.code, { ...c, lite: false });
    }

    if (opts.includeScannerSurges) {
        try {
            const [vol, amt, chg] = await Promise.all([
                opts.market.scanner('VolumeRank', 30, false),
                opts.market.scanner('AmountRank', 30, false),
                opts.market.scanner('ChangePercentRank', 30, false),
            ]);
            for (const row of [...vol, ...amt, ...chg]) {
                if (pool.has(row.code)) continue;
                pool.set(row.code, {
                    code: row.code,
                    name: row.name,
                    lite: true,
                });
            }
        } catch (err) {
            warnings.push(
                `scanner 突發池失敗：${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
    for (const x of opts.liteExtra ?? []) {
        if (!pool.has(x.code)) {
            pool.set(x.code, { ...x, lite: true });
        }
    }

    const list = [...pool.values()].slice(0, 100);
    if (!list.length) {
        return {
            stage,
            as_of: asOf,
            session_minutes: sessionMinutes,
            count: 0,
            pass: 0,
            watch: 0,
            reject: 0,
            items: [],
            warnings: [...warnings, '無候選代碼'],
        };
    }

    const codes = list.map((x) => x.code);
    let snaps: Snapshot[] = [];
    try {
        snaps = await opts.market.snapshots(
            codes.map((code) => ({
                security_type: 'STK' as const,
                exchange: 'TSE',
                code,
            })),
        );
        // OTC retry missing
        const got = new Set(snaps.map((s) => s.code));
        const missing = codes.filter((c) => !got.has(c));
        if (missing.length) {
            const more = await opts.market.snapshots(
                missing.map((code) => ({
                    security_type: 'STK' as const,
                    exchange: 'OTC',
                    code,
                })),
            );
            snaps = [...snaps, ...more];
        }
    } catch (err) {
        warnings.push(
            `snapshots 失敗：${err instanceof Error ? err.message : String(err)}`,
        );
    }

    const snapMap = new Map(snaps.map((s) => [s.code, s]));
    let barsMap = new Map<string, DailyBar[]>();
    try {
        barsMap = await fetchTwDailyBarsBatch(codes, '3mo', 8);
    } catch {
        warnings.push('歷史日K部分失敗，RVOL 將降級估算');
    }

    const items: OpenGateResult[] = [];
    for (const row of list) {
        const snap = snapMap.get(row.code);
        if (!snap || !(snap.close > 0 || snap.open > 0)) {
            items.push({
                code: row.code,
                name: row.name,
                a_score: row.a_score,
                as_of: asOf,
                stage,
                open_confirm: 'reject',
                open_score: 0,
                dims: { gap: 0, rvol: 0, price: 0, momentum: 0, chase: 0 },
                metrics: {
                    prev_close: 0,
                    open: 0,
                    last: 0,
                    vwap: null,
                    gap_pct: 0,
                    chg_from_open_pct: 0,
                    day_chg_pct: 0,
                    rvol_5: null,
                    rvol_10: null,
                    rvol_15: null,
                    held_open: false,
                    above_vwap: false,
                    higher_highs: false,
                    pullback_from_high_pct: 0,
                    session_minutes: sessionMinutes,
                },
                reasons: ['- 無即時報價'],
                tradable: false,
                lite: row.lite,
            });
            continue;
        }
        items.push(
            scoreOpenGateOne({
                code: row.code,
                name: row.name ?? snap.code,
                aScore: row.a_score,
                snap,
                bars: barsMap.get(row.code),
                stage,
                sessionMinutes,
                punished: punish.has(row.code),
                lite: row.lite,
            }),
        );
    }

    items.sort(
        (a, b) =>
            b.open_score - a.open_score ||
            (b.a_score ?? 0) - (a.a_score ?? 0),
    );

    appendOpenGateLog(items);

    const pass = items.filter((i) => i.open_confirm === 'pass').length;
    const watch = items.filter(
        (i) =>
            i.open_confirm === 'watch' ||
            i.open_confirm === 'early' ||
            i.open_confirm === 'provisional',
    ).length;
    const reject = items.filter((i) => i.open_confirm === 'reject').length;

    return {
        stage,
        as_of: asOf,
        session_minutes: sessionMinutes,
        count: items.length,
        pass,
        watch,
        reject,
        items,
        warnings,
    };
}
