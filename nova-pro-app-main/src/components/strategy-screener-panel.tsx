import { useEffect, useMemo, useState } from 'react';
import {
    fetchFullScreener,
    fetchOpenConfirm,
    fetchOvernightEdge,
    fetchPublicChips,
    fetchScanner,
    type FullScreenerItem,
    type OpenConfirmStatus,
    type OpenConfirmV2Item,
} from '../lib/backend';
import type { ScannerItem } from '../lib/types/market';
import {
    modeLabel,
    AUTO_SCAN_TOP_N,
    loadPredictions,
    taipeiSignalDate,
    type StrategyMode,
    type PredictionRecord,
} from '../lib/prediction-book';
import {
    buildLearnModel,
    findMutedHits,
    formatLearnStatus,
    learnDeltaForTags,
} from '../lib/prediction-learn';
import {
    loadScreenerStore,
    saveScreenerStore,
} from '../lib/screener-store';
import { fmtPct, fmtPrice } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './strategy-screener-panel.css';

type TagKey =
    | 'momentum'
    | 'aboveAvg'
    | 'volumeRatio'
    | 'nearHigh'
    | 'rangeWide'
    | 'openStrength'
    | 'pullback'
    | 'liquid'
    | 'instBuy'
    | 'instSell'
    | 'marginClean'
    | 'overnightEdge'
    | 'rsStrong'
    | 'ma20'
    | 'instStreak'
    | 'tdccHot'
    | 'revenueUp'
    | 'valueCheap'
    | 'highYield'
    | 'dayTradeHot'
    | 'attention'
    | 'exDivSoon';

interface Scored extends ScannerItem {
    strength: number;
    rr: number;
    tags: TagKey[];
    notes: string[];
    entryPrice: number;
    entryNote: string;
    /** 預估最佳賣點 */
    target: number;
    sellNote: string;
    /** 進場→賣點 漲點／漲幅 */
    gainPts: number;
    gainPct: number;
    stopPrice: number;
    chgPct: number;
    chipsLabel?: string;
    overnightWinRate?: number;
    overnightLabel?: string;
    learnDelta?: number;
    tech_delta?: number;
    streak_delta?: number;
    tdcc_delta?: number;
    openapi_delta?: number;
    factors?: FullScreenerItem['factors'];
    factor_notes?: string[];
    market?: 'tse' | 'otc';
    /** [B] OPEN GATE v2 */
    open_score?: number;
    open_confirm?: OpenConfirmStatus;
    open_stage?: OpenConfirmV2Item['phase'];
    open_phase?: OpenConfirmV2Item['phase'];
    open_reasons?: string[];
    open_risks?: string[];
    open_tradable?: boolean;
    open_rvol?: number | null;
    open_vwap?: number | null;
    open_vwap_pos?: number | null;
    open_momentum?: number | null;
    open_liquidity?: number | null;
    open_market?: string | null;
    open_chase?: string | null;
    open_invalid?: number | null;
    open_data_health?: OpenConfirmV2Item['data_health'];
    open_expires_at?: string | null;
    open_data_blocked?: boolean;
    open_tradeable_candidate?: boolean;
    open_signal_id?: string | null;
    open_late_candidate?: boolean;
}

const tagLabels: Record<TagKey, string> = {
    momentum: '動能',
    aboveAvg: '站上均價',
    volumeRatio: '量能放大',
    nearHigh: '近高點',
    rangeWide: '波動夠',
    openStrength: '收強',
    pullback: '微回檔',
    liquid: '流動性',
    instBuy: '法人買超',
    instSell: '法人賣超',
    marginClean: '融資轉乾',
    overnightEdge: '隔夜優勢',
    rsStrong: '相對強勢',
    ma20: '站上MA20',
    instStreak: '法人連買',
    tdccHot: '集保大戶',
    revenueUp: '營收成長',
    valueCheap: '估值便宜',
    highYield: '高殖利率',
    dayTradeHot: '當沖過熱',
    attention: '注意股',
    exDivSoon: '近除權息',
};

const MODE_PRESET: Record<
    StrategyMode,
    {
        blurb: string;
        stopLossPct: number;
        takeProfitPct: number;
        pools: { volume: boolean; amount: boolean; gainers: boolean };
    }
> = {
    intraday: {
        blurb: '當沖：EOD 觀察池 → OPEN GATE 開盤品質閘門（非昨晚強=今天可做）。分數高≠保證賺。',
        stopLossPct: 1,
        takeProfitPct: 2,
        pools: { volume: true, amount: true, gainers: true },
    },
    overnight: {
        blurb: '隔夜流：全市場＋OpenAPI 營收／估值／除權息過濾，再疊次開勝率。勝率是統計，不是保證。',
        stopLossPct: 1.2,
        takeProfitPct: 2.5,
        pools: { volume: true, amount: true, gainers: true },
    },
};

function pct(v: number, base: number): number {
    if (!base) return 0;
    return (v / base) * 100;
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

/** Round to TW stock tick-ish precision (2 decimals under 500). */
function roundPx(n: number): number {
    if (!(n > 0)) return 0;
    const d = n >= 500 ? 0 : 2;
    const f = 10 ** d;
    return Math.round(n * f) / f;
}

/**
 * Suggest a buy zone (not a guarantee):
 * - avoid chasing extended closes
 * - prefer VWAP/avg or mild pullback
 * - overnight: slightly below close when stretched
 */
function suggestEntry(
    row: ScannerItem & Partial<FullScreenerItem>,
    mode: StrategyMode,
    chgPct: number,
    closeNearHigh: boolean,
    pullback: boolean,
): { entry: number; note: string } {
    const close = row.close;
    const avg =
        row.average_price > 0
            ? row.average_price
            : (row.open + row.high + row.low + row.close) / 4;
    const near20 = row.factors?.near_high_20;
    const stretched =
        closeNearHigh ||
        chgPct >= (mode === 'overnight' ? 4 : 5) ||
        (near20 != null && near20 >= 0.98);

    let entry = close;
    let note = '現價附近';

    if (mode === 'intraday') {
        if (pullback) {
            entry = (avg + close) / 2;
            note = '回檔靠近均價承接';
        } else if (stretched) {
            entry = Math.max(avg, close * 0.985);
            note = '偏強勿追，等回測再進';
        } else if (close >= avg) {
            entry = Math.min(close, Math.max(avg, (row.open + close) / 2));
            note = '站上均價區間進場';
        } else {
            entry = Math.min(close, (avg + close) / 2);
            note = '均價附近觀察承接';
        }
    } else {
        // overnight: prefer not buying the tip into close
        if (stretched) {
            entry = close * 0.99;
            note = '隔夜忌追高，略低於收盤';
        } else if (pullback) {
            entry = close;
            note = '收盤微回檔，收盤附近布局';
        } else if (close >= avg) {
            entry = (close + avg) / 2;
            note = '收盤與均價之間布局';
        } else {
            entry = close;
            note = '收盤附近隔夜布局';
        }
    }

    // Long bias: don't suggest paying above last
    entry = Math.min(entry, close);
    // Keep inside today's range when possible (limit-style)
    if (row.low > 0 && row.high > 0) {
        entry = clamp(entry, row.low, row.high);
    }
    // Still never above close for this helper
    entry = Math.min(entry, close);

    return { entry: roundPx(entry), note };
}

/**
 * Suggest best take-profit / sell zone from entry.
 * Uses preset TP floor, day high / range, overnight stretch caps.
 */
function suggestSell(
    row: ScannerItem & Partial<FullScreenerItem>,
    mode: StrategyMode,
    entry: number,
    takeProfitPct: number,
    closeNearHigh: boolean,
    pullback: boolean,
): { sell: number; note: string; gainPts: number; gainPct: number } {
    const baseTp = entry * (1 + takeProfitPct / 100);
    const dayHigh = row.high > 0 ? row.high : entry;
    const range = Math.max(dayHigh - row.low, entry * 0.01);
    const near20 = row.factors?.near_high_20;
    // Infer soft 20d high from near_high_20 ≈ close/high20
    const high20 =
        near20 != null && near20 > 0.5 && row.close > 0
            ? row.close / near20
            : null;

    let sell = baseTp;
    let note = `目標約 +${takeProfitPct}%`;

    if (mode === 'intraday') {
        if (pullback && dayHigh > entry * 1.002) {
            // Scale back toward prior high
            sell = Math.max(baseTp, dayHigh * 0.998);
            note = '回測後往今日高點附近出';
        } else if (closeNearHigh) {
            // Already extended: take preset TP or slight extension only
            sell = Math.max(baseTp, entry * (1 + takeProfitPct / 100));
            const ext = entry + range * 0.35;
            if (ext > sell && ext <= entry * 1.06) {
                sell = ext;
                note = '偏強量價，略延伸後分批出';
            } else {
                note = '已近高點，先達標就出';
            }
        } else if (dayHigh > entry) {
            const midExt = entry + Math.max(range * 0.55, entry * (takeProfitPct / 100));
            sell = Math.max(baseTp, Math.min(midExt, dayHigh * 1.005));
            note = '往日內壓力／高點區出貨';
        }
        // Cap day-trade greed (~7% from entry unless high already higher)
        const cap = Math.max(entry * 1.07, dayHigh * 1.01);
        sell = Math.min(sell, cap);
    } else {
        // overnight: sell zone for next session / gap
        if (closeNearHigh || (near20 != null && near20 >= 0.98)) {
            sell = Math.max(baseTp, entry * (1 + Math.min(takeProfitPct, 2) / 100));
            note = '隔夜已偏高，次開達標先出';
        } else if (high20 != null && high20 > entry) {
            const room = high20 * 0.995;
            sell = Math.max(baseTp, Math.min(room, entry * 1.05));
            note =
                room > baseTp
                    ? '往近20日高點前出'
                    : `目標約 +${takeProfitPct}%`;
        } else {
            const gapStyle = entry + range * 0.7;
            sell = Math.max(baseTp, Math.min(gapStyle, entry * 1.045));
            note =
                sell > baseTp * 1.01
                    ? '依波動預估次日賣壓區'
                    : `次開目標約 +${takeProfitPct}%`;
        }
        sell = Math.min(sell, entry * 1.08);
    }

    // Never below preset TP floor or entry
    sell = Math.max(sell, baseTp, entry * 1.005);
    sell = roundPx(sell);
    const gainPts = roundPx(sell - entry);
    const gainPct = entry > 0 ? +((gainPts / entry) * 100).toFixed(2) : 0;

    return { sell, note, gainPts, gainPct };
}

/** 0～100 綜合強度：流動性 / 動能適配 / 結構 / 可做空間／多日因子 */
function scoreStrength(
    row: ScannerItem & Partial<FullScreenerItem>,
    mode: StrategyMode,
    stopLossPct: number,
    takeProfitPct: number,
): Scored {
    const chgPct = pct(
        row.change_price,
        row.close - row.change_price || row.close,
    );
    const rangePct = pct(row.high - row.low, row.close || 1);
    const closeNearHigh = row.high > 0 && row.close >= row.high * 0.992;
    const pullback =
        row.high > 0 &&
        row.close >= row.high * 0.965 &&
        row.close < row.high * 0.992;
    const { entry, note: entryNote } = suggestEntry(
        row,
        mode,
        chgPct,
        closeNearHigh,
        pullback,
    );
    const {
        sell,
        note: sellNote,
        gainPts,
        gainPct,
    } = suggestSell(
        row,
        mode,
        entry,
        takeProfitPct,
        closeNearHigh,
        pullback,
    );

    const riskPct = Math.max(
        stopLossPct,
        entry > 0 ? pct(entry - Math.min(row.low, entry), entry) : 0,
    );
    const rewardPct = Math.max(
        takeProfitPct,
        entry > 0 ? pct(Math.max(sell - entry, 0), entry) : 0,
    );
    const rr = riskPct > 0 ? rewardPct / riskPct : 0;

    let liquid = 0;
    if (row.total_volume >= 2000 || row.rank_value > 0) liquid += 12;
    else if (row.total_volume >= 500) liquid += 8;
    else if (row.total_volume > 0) liquid += 4;
    if (row.volume_ratio >= 1.5) liquid += 10;
    else if (row.volume_ratio >= 1.2) liquid += 7;
    else if (row.volume_ratio >= 1) liquid += 4;
    if (row.total_amount > 0) liquid += 3;
    liquid = clamp(liquid, 0, 25);

    let momentum = 0;
    if (mode === 'intraday') {
        if (chgPct > 0) momentum += 8;
        if (chgPct >= 1) momentum += 6;
        if (chgPct >= 2 && chgPct <= 5) momentum += 6;
        if (chgPct > 6) momentum -= 4;
        if (row.close > row.open) momentum += 5;
    } else {
        if (row.close >= row.open) momentum += 8;
        if (chgPct > 0 && chgPct <= 4) momentum += 10;
        if (chgPct > 4 && chgPct <= 6) momentum += 4;
        if (chgPct > 6) momentum -= 10;
        if (pullback) momentum += 6;
        if (chgPct < -2) momentum -= 6;
    }
    momentum = clamp(momentum, 0, 25);

    let structure = 0;
    if (row.average_price > 0 && row.close >= row.average_price) structure += 10;
    if (closeNearHigh) structure += mode === 'intraday' ? 10 : 4;
    if (pullback && mode === 'overnight') structure += 8;
    if (row.close > row.open) structure += 5;
    structure = clamp(structure, 0, 25);

    let setup = 0;
    if (rangePct >= 2.5) setup += 10;
    else if (rangePct >= 1.5) setup += 7;
    else if (rangePct >= 1) setup += 4;
    if (rr >= 2.5) setup += 10;
    else if (rr >= 2) setup += 8;
    else if (rr >= 1.5) setup += 5;
    if (row.close > 5 && row.close < 800) setup += 3;
    // Prefer setups where entry is meaningfully below last (better RR)
    if (entry > 0 && entry < row.close * 0.998) setup += 2;
    setup = clamp(setup, 0, 25);

    const factorBoost =
        (row.tech_delta ?? 0) +
        (row.streak_delta ?? 0) +
        (row.tdcc_delta ?? 0) +
        (row.openapi_delta ?? 0);
    const strength = clamp(
        Math.round(liquid + momentum + structure + setup + factorBoost),
        0,
        100,
    );

    const tags: TagKey[] = [];
    if (liquid >= 12) tags.push('liquid');
    if (chgPct > 0.8) tags.push('momentum');
    if (row.average_price > 0 && row.close >= row.average_price)
        tags.push('aboveAvg');
    if (row.volume_ratio >= 1.2) tags.push('volumeRatio');
    if (closeNearHigh) tags.push('nearHigh');
    if (rangePct >= 1.5) tags.push('rangeWide');
    if (row.close > row.open) tags.push('openStrength');
    if (pullback) tags.push('pullback');
    if ((row.factors?.rs_20 ?? 0) >= 0.05) tags.push('rsStrong');
    if (row.factors?.above_ma20) tags.push('ma20');
    if ((row.factors?.inst_buy_streak ?? 0) >= 2) tags.push('instStreak');
    if ((row.factors?.tdcc_large_pct ?? 0) >= 25) tags.push('tdccHot');
    if ((row.factors?.revenue_yoy ?? 0) >= 5) tags.push('revenueUp');
    if (
        (row.factors?.pe != null &&
            row.factors.pe > 0 &&
            row.factors.pe <= 12) ||
        (row.factors?.pb != null && row.factors.pb > 0 && row.factors.pb <= 1.2)
    ) {
        tags.push('valueCheap');
    }
    if ((row.factors?.yield_pct ?? 0) >= 5) tags.push('highYield');
    if ((row.factors?.day_trade_pct ?? 0) >= 25) tags.push('dayTradeHot');
    if (row.factors?.attention) tags.push('attention');
    if (row.factors?.ex_div_soon) tags.push('exDivSoon');

    const target = sell;
    const stopPrice = roundPx(entry * (1 - stopLossPct / 100));

    const factorNotes = (row.factor_notes ?? []).slice(0, 5);

    return {
        ...row,
        strength,
        rr,
        tags,
        notes: [
            `強度 ${strength}`,
            `進場 ${fmtPrice(entry)}（${entryNote}）`,
            `賣點 ${fmtPrice(sell)}（+${gainPts}／${gainPct}%｜${sellNote}）`,
            `流動${liquid}/動能${momentum}/結構${structure}/空間${setup}${
                factorBoost ? `/因子${factorBoost > 0 ? '+' : ''}${factorBoost}` : ''
            }`,
            ...factorNotes,
        ],
        entryPrice: entry,
        entryNote,
        target,
        sellNote,
        gainPts,
        gainPct,
        stopPrice,
        chgPct,
        tech_delta: row.tech_delta,
        streak_delta: row.streak_delta,
        tdcc_delta: row.tdcc_delta,
        openapi_delta: row.openapi_delta,
        factors: row.factors,
        factor_notes: row.factor_notes,
    };
}

function rememberScreenerPick(item: Scored, mode: StrategyMode): void {
    sessionStorage.setItem('nova-screener-code', item.code);
    sessionStorage.setItem('nova-screener-strength', String(item.strength));
    sessionStorage.setItem('nova-screener-mode', mode);
    sessionStorage.setItem('nova-screener-target', String(item.target));
    sessionStorage.setItem('nova-screener-entry', String(item.entryPrice));
    sessionStorage.setItem('nova-screener-close', String(item.close));
    if (item.overnightWinRate != null) {
        sessionStorage.setItem(
            'nova-screener-overnight-winrate',
            String(item.overnightWinRate),
        );
    } else {
        sessionStorage.removeItem('nova-screener-overnight-winrate');
    }
}

export function StrategyScreenerPanel({
    watchlistSeed,
    onPickCode,
    onAddPrediction,
    onAutoScanPredictions,
    compactMobile = false,
}: {
    watchlistSeed: Array<{ code: string; name: string; close?: number }>;
    onPickCode: (code: string) => void;
    onAddPrediction: (record: PredictionRecord) => void;
    /** 篩選完成後自動記入前 N 名供隔日驗證 */
    onAutoScanPredictions?: (records: PredictionRecord[]) => void;
    /** Mobile: parent pane scrolls; don't nest another scrollport */
    compactMobile?: boolean;
}) {
    const cached = useMemo(() => loadScreenerStore(), []);
    const [mode, setMode] = useState<StrategyMode>(
        cached?.mode ?? 'intraday',
    );
    const [scannedMode, setScannedMode] = useState<StrategyMode | null>(
        cached?.scannedMode ?? null,
    );
    const [includeWatchlist, setIncludeWatchlist] = useState(
        cached?.includeWatchlist ?? false,
    );
    /** 當沖：預設只顯示 OPEN GATE pass（可關＝A/B 對照純 EOD） */
    const [gatePassOnly, setGatePassOnly] = useState(true);
    const [gateMeta, setGateMeta] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [rows, setRows] = useState<Scored[]>(
        () => (cached?.rows as Scored[] | undefined) ?? [],
    );
    const [status, setStatus] = useState(
        cached?.status ??
            '選好模式後按「智能篩選」。結果依強度分數排序。',
    );

    const persist = (
        next: Partial<{
            mode: StrategyMode;
            scannedMode: StrategyMode | null;
            includeWatchlist: boolean;
            rows: Scored[];
            status: string;
        }>,
        allowEmpty = false,
    ) => {
        const payload = {
            mode: next.mode ?? mode,
            scannedMode: (next.scannedMode ??
                scannedMode ??
                mode) as StrategyMode,
            includeWatchlist: next.includeWatchlist ?? includeWatchlist,
            rows: next.rows ?? rows,
            status: next.status ?? status,
            at: Date.now(),
        };
        saveScreenerStore(payload, { allowEmpty });
    };

    useEffect(() => {
        // Never let empty remount wipe a good store
        persist({}, false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, scannedMode, includeWatchlist, rows, status]);

    const preset = MODE_PRESET[mode];
    const staleResults =
        rows.length > 0 && scannedMode != null && scannedMode !== mode;

    const topStrength = useMemo(
        () => (rows[0] ? rows[0].strength : null),
        [rows],
    );
    const displayRows = useMemo(() => {
        if (mode !== 'intraday' || !gatePassOnly) return rows;
        const anyConfirm = rows.some((r) => r.open_confirm != null);
        if (!anyConfirm) return rows;
        return rows.filter(
            (r) =>
                r.open_tradeable_candidate === true ||
                (r.open_confirm === 'pass' &&
                    r.open_phase === 'confirmed' &&
                    r.open_data_health === 'healthy' &&
                    !r.open_data_blocked),
        );
    }, [rows, gatePassOnly, mode]);
    const learnModel = useMemo(() => buildLearnModel(loadPredictions()), [rows]);
    const learnStatus = useMemo(
        () => formatLearnStatus(learnModel, mode),
        [learnModel, mode],
    );

    async function loadCandidates(): Promise<{
        list: Array<ScannerItem & Partial<FullScreenerItem>>;
        failed: string[];
        meta?: {
            universe: number;
            liquid: number;
            enriched: number;
            asOf: string | null;
            tookMs: number;
        };
    }> {
        const merged = new Map<string, ScannerItem & Partial<FullScreenerItem>>();
        const failed: string[] = [];
        let meta:
            | {
                  universe: number;
                  liquid: number;
                  enriched: number;
                  asOf: string | null;
                  tookMs: number;
              }
            | undefined;

        // Primary: full TWSE+TPEx OpenAPI universe + tech/chips enrichment
        try {
            setStatus('掃描中…全上市櫃日線＋OpenAPI（估值／營收／當沖／除權息）');
            const full = await fetchFullScreener({
                techLimit: 120,
                tdccLimit: 40,
            });
            if (full.items.length) {
                full.items.forEach((item) => merged.set(item.code, item));
                meta = {
                    universe: full.universe_count,
                    liquid: full.liquid_count,
                    enriched: full.enriched_count,
                    asOf: full.as_of,
                    tookMs: full.took_ms,
                };
                if (full.warnings.length) {
                    failed.push(...full.warnings.slice(0, 2));
                }
            } else {
                failed.push('全市場日線');
            }
        } catch {
            failed.push('全市場日線');
        }

        // Fallback / supplement: Fugle (or overnight) rank pools
        if (merged.size < 40) {
            const jobs: Array<{ label: string; p: Promise<ScannerItem[]> }> =
                [];
            if (preset.pools.volume)
                jobs.push({
                    label: '成交量',
                    p: fetchScanner('VolumeRank', 50),
                });
            if (preset.pools.amount)
                jobs.push({
                    label: '成交額',
                    p: fetchScanner('AmountRank', 50),
                });
            if (preset.pools.gainers)
                jobs.push({
                    label: '漲幅',
                    p: fetchScanner('ChangePercentRank', 50),
                });

            const chunks = await Promise.allSettled(jobs.map((j) => j.p));
            chunks.forEach((hit, i) => {
                const label = jobs[i]!.label;
                if (hit.status === 'fulfilled') {
                    hit.value.forEach((item) => {
                        if (!merged.has(item.code)) merged.set(item.code, item);
                    });
                } else {
                    failed.push(label);
                }
            });
        }

        if (includeWatchlist) {
            watchlistSeed.forEach((w) => {
                if (merged.has(w.code)) return;
                merged.set(w.code, {
                    code: w.code,
                    name: w.name,
                    date: new Date().toISOString().slice(0, 10),
                    close: w.close ?? 0,
                    open: w.close ?? 0,
                    high: w.close ?? 0,
                    low: w.close ?? 0,
                    change_price: 0,
                    change_type: 0,
                    average_price: w.close ?? 0,
                    price_range: 0,
                    rank_value: 0,
                    total_volume: 0,
                    total_amount: 0,
                    volume_ratio: 0,
                    yesterday_volume: 0,
                    tick_type: 0,
                    buy_price: 0,
                    sell_price: 0,
                });
            });
        }

        return { list: [...merged.values()], failed, meta };
    }

    async function runScan(): Promise<void> {
        if (loading) return;
        setLoading(true);
        setStatus('掃描中…全上市櫃宇宙與強度計算');
        try {
            const { list, failed, meta } = await loadCandidates();
            if (list.length === 0) {
                setRows([]);
                const msg = failed.length
                    ? `排行榜抓不到資料（失敗：${failed.join('、')}）。休市、金鑰或網路問題時會這樣。`
                    : '排行榜目前沒有資料（可能休市或行情尚未開）。';
                setStatus(msg);
                persist({ rows: [], status: msg }, true);
                return;
            }

            if (meta) {
                setStatus(
                    `掃描中…宇宙 ${meta.universe} 檔／流動 ${meta.liquid} 檔（技術強化 ${meta.enriched}）`,
                );
            }

            const scored = list
                .filter((r) => r.close > 0)
                .filter((r) => !r.factors?.punished)
                .map((r) =>
                    scoreStrength(
                        r,
                        mode,
                        preset.stopLossPct,
                        preset.takeProfitPct,
                    ),
                )
                // 最低門檻：至少有一點流動性或排名，避免垃圾票
                .filter(
                    (s) =>
                        s.total_volume > 0 ||
                        s.rank_value > 0 ||
                        s.volume_ratio > 0 ||
                        includeWatchlist,
                )
                .sort(
                    (a, b) =>
                        b.strength - a.strength ||
                        b.rr - a.rr ||
                        b.chgPct - a.chgPct,
                )
                .slice(0, 40);

            // 疊加公開籌碼（三大法人＋融資券）後再排序取前 30
            let withChips = scored;
            try {
                setStatus('掃描中…疊加三大法人／融資券');
                const chipRes = await fetchPublicChips(
                    scored.map((s) => s.code),
                );
                withChips = scored
                    .map((s) => {
                        const c = chipRes.items[s.code];
                        if (!c) return s;
                        const delta = c.strength_delta ?? 0;
                        const tags = [...s.tags];
                        if ((c.inst_net ?? 0) > 200_000 && !tags.includes('instBuy'))
                            tags.push('instBuy');
                        if ((c.inst_net ?? 0) < -200_000 && !tags.includes('instSell'))
                            tags.push('instSell');
                        if (
                            (c.margin_delta ?? 0) < -400 &&
                            !tags.includes('marginClean')
                        )
                            tags.push('marginClean');
                        const strength = Math.max(
                            0,
                            Math.min(100, s.strength + delta),
                        );
                        return {
                            ...s,
                            strength,
                            tags,
                            chipsLabel: c.label,
                            notes: [
                                ...s.notes,
                                c.label
                                    ? `籌碼 ${c.label}${delta ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}`
                                    : '',
                            ].filter(Boolean),
                        };
                    })
                    .sort(
                        (a, b) =>
                            b.strength - a.strength ||
                            b.rr - a.rr ||
                            b.chgPct - a.chgPct,
                    )
                    .slice(0, 30);
            } catch {
                withChips = scored.slice(0, 30);
            }

            // 隔夜模式：疊加收盤→次開歷史勝率
            let finalRows = withChips;
            if (mode === 'overnight') {
                try {
                    setStatus('掃描中…計算隔夜→次開歷史勝率');
                    const edgeRes = await fetchOvernightEdge(
                        withChips.map((s) => s.code),
                    );
                    finalRows = withChips
                        .map((s) => {
                            const e = edgeRes.items[s.code];
                            if (!e || e.samples < 8) return s;
                            const boost = e.strength_boost ?? 0;
                            const tags = [...s.tags];
                            if (e.win_rate >= 53 && !tags.includes('overnightEdge')) {
                                tags.push('overnightEdge');
                            }
                            const strength = Math.max(
                                0,
                                Math.min(100, s.strength + boost),
                            );
                            return {
                                ...s,
                                strength,
                                tags,
                                overnightWinRate: e.win_rate,
                                overnightLabel: e.label,
                                notes: [
                                    ...s.notes,
                                    `隔夜次開 ${e.win_rate}%（${e.samples}次）`,
                                ],
                            };
                        })
                        .sort(
                            (a, b) =>
                                b.strength - a.strength ||
                                (b.overnightWinRate ?? 0) -
                                    (a.overnightWinRate ?? 0) ||
                                b.rr - a.rr,
                        );
                } catch {
                    // keep chip-ranked list
                }
            }

            // 當沖：[B] OPEN GATE v2 — EOD 強 ≠ 今天可當沖
            let gateStatusLine: string | null = null;
            setGateMeta(null);
            if (mode === 'intraday' && finalRows.length) {
                try {
                    setStatus('掃描中…OPEN GATE v2 開盤品質確認');
                    const gateRes = await fetchOpenConfirm({
                        codes: finalRows.map((s) => ({
                            code: s.code,
                            name: s.name,
                            a_score: s.strength,
                            strength: s.strength,
                            market: s.market,
                            close: s.close,
                            total_volume: s.total_volume,
                            total_amount: s.total_amount,
                            volume_ratio: s.volume_ratio,
                            yesterday_volume: s.yesterday_volume,
                            factors: s.factors,
                            source: 'eod_a',
                        })),
                    });
                    const byCode = new Map(
                        gateRes.items.map((g) => [g.symbol, g] as const),
                    );
                    const confirmRank = (c?: OpenConfirmStatus) => {
                        if (c === 'pass') return 5;
                        if (c === 'early_pass' || c === 'early') return 4;
                        if (c === 'provisional') return 3;
                        if (c === 'watch') return 2;
                        if (c === 'reject') return 0;
                        return 1;
                    };
                    finalRows = finalRows
                        .map((s) => {
                            const g = byCode.get(s.code);
                            if (!g) return s;
                            return {
                                ...s,
                                open_score: g.final_open_score,
                                open_confirm: g.open_confirm,
                                open_stage: g.phase,
                                open_phase: g.phase,
                                open_reasons: g.reasons,
                                open_risks: g.risks,
                                open_tradable:
                                    g.tradeable_candidate ?? g.tradeable,
                                open_tradeable_candidate:
                                    g.tradeable_candidate ?? g.tradeable,
                                open_rvol: g.metrics.rvol_same_time,
                                open_vwap: g.metrics.vwap,
                                open_vwap_pos: g.metrics.vwap_pos_pct,
                                open_momentum: g.metrics.momentum_score,
                                open_liquidity: g.liquidity_score,
                                open_market: g.market_regime,
                                open_chase: g.risk.chase_risk,
                                open_invalid: g.risk.invalid_price,
                                open_data_health: g.data_health,
                                open_data_blocked: g.data_blocked,
                                open_expires_at:
                                    g.signal_valid_until ?? g.expires_at,
                                open_signal_id: g.signal_id,
                                open_late_candidate: g.late_candidate,
                                notes: [
                                    ...s.notes,
                                    `OPEN ${g.open_confirm} ${g.final_open_score}`,
                                    ...g.reasons.slice(0, 2),
                                ].filter(Boolean),
                            };
                        })
                        .sort(
                            (a, b) =>
                                confirmRank(b.open_confirm) -
                                    confirmRank(a.open_confirm) ||
                                (b.open_score ?? 0) - (a.open_score ?? 0) ||
                                b.strength - a.strength ||
                                b.rr - a.rr,
                        );
                    gateStatusLine = `OPEN GATE v2 ${gateRes.phase}｜${gateRes.market_regime}｜可做 ${gateRes.tradeable_count ?? gateRes.pass}／通過 ${gateRes.pass}／早盤 ${gateRes.early_pass ?? 0}／觀察 ${gateRes.watch}／剔除 ${gateRes.reject}${
                        gateRes.warnings?.length
                            ? `（${gateRes.warnings[0]}）`
                            : ''
                    }`;
                    setGateMeta(gateStatusLine);
                } catch (err) {
                    gateStatusLine = `OPEN GATE v2 暫不可用（${
                        err instanceof Error ? err.message : String(err)
                    }）— 暫顯示 EOD 觀察池`;
                    setGateMeta(gateStatusLine);
                }
            }

            // 第二步：學習微調；暫汰條件 → 直接剔除（硬汰除）
            let mutedDropped = 0;
            const muteReasons: string[] = [];
            const kept: Scored[] = [];
            for (const s of finalRows) {
                const labels = s.tags.map((k) => tagLabels[k]);
                const mutedHits = findMutedHits(learnModel, mode, labels);
                if (mutedHits.length) {
                    mutedDropped += 1;
                    for (const h of mutedHits) {
                        if (!muteReasons.includes(h)) muteReasons.push(h);
                    }
                    continue;
                }
                const { delta, parts } = learnDeltaForTags(
                    learnModel,
                    mode,
                    labels,
                );
                if (!delta) {
                    kept.push(s);
                    continue;
                }
                const strength = Math.max(
                    0,
                    Math.min(100, Math.round(s.strength + delta)),
                );
                kept.push({
                    ...s,
                    strength,
                    learnDelta: delta,
                    notes: [
                        ...s.notes,
                        `學習 ${delta > 0 ? '+' : ''}${delta}${parts.length ? `（${parts.join('、')}）` : ''}`,
                    ],
                });
            }
            finalRows = kept.sort(
                (a, b) =>
                    b.strength - a.strength ||
                    b.rr - a.rr ||
                    b.chgPct - a.chgPct,
            );

            setRows(finalRows);
            setScannedMode(mode);
            persist({ rows: finalRows, scannedMode: mode }, true);

            // 第一段自主學習：自動記入前 N 名，供收盤／次日驗證
            if (onAutoScanPredictions && finalRows.length) {
                const nowIso = new Date().toISOString();
                const autoRecords: PredictionRecord[] = finalRows
                    .slice(0, AUTO_SCAN_TOP_N)
                    .map((item, idx) => {
                        const signalDate =
                            typeof item.date === 'string' &&
                            item.date.length >= 10
                                ? item.date.slice(0, 10)
                                : taipeiSignalDate(nowIso);
                        return {
                            id: `auto-${mode}-${signalDate}-${item.code}`,
                            createdAt: nowIso,
                            mode,
                            code: item.code,
                            name: item.name,
                            close: item.close,
                            entryPrice: item.entryPrice,
                            entryNote: item.entryNote,
                            target: item.target,
                            sellNote: item.sellNote,
                            gainPts: item.gainPts,
                            gainPct: item.gainPct,
                            rr: item.rr,
                            stopLossPct: preset.stopLossPct,
                            takeProfitPct: preset.takeProfitPct,
                            hardPass: item.strength >= 55,
                            softHitCount: item.tags.length,
                            pickedConditions: item.tags.map(
                                (k) => tagLabels[k],
                            ),
                            notes: [
                                ...item.notes,
                                `自動記入 #${idx + 1}`,
                            ],
                            signalDate,
                            source: 'auto_scan' as const,
                            strength: item.strength,
                            status: 'open' as const,
                        };
                    });
                onAutoScanPredictions(autoRecords);
            }

            const avgEdge =
                mode === 'overnight'
                    ? (() => {
                          const xs = finalRows
                              .map((r) => r.overnightWinRate)
                              .filter((n): n is number => n != null);
                          if (!xs.length) return null;
                          return Math.round(
                              xs.reduce((a, b) => a + b, 0) / xs.length,
                          );
                      })()
                    : null;
            const failBit = failed.length
                ? `（提醒：${failed.slice(0, 2).join('；')}）`
                : '';
            const autoBit = finalRows.length
                ? `已自動記入前 ${Math.min(AUTO_SCAN_TOP_N, finalRows.length)} 名到布局本。`
                : '';
            const muteBit =
                mutedDropped > 0
                    ? `暫汰剔除 ${mutedDropped} 檔${
                          muteReasons.length
                              ? `（${muteReasons.slice(0, 3).join('、')}）`
                              : ''
                      }。`
                    : '';
            const gateBit = gateStatusLine ? ` ${gateStatusLine}。` : '';
            const uniBit = meta
                ? `全市場 ${meta.universe}→流動 ${meta.liquid}（技術 ${meta.enriched}）`
                : `掃描 ${list.length} 檔`;
            setStatus(
                finalRows.length
                    ? `${uniBit} → 最強 ${finalRows.length} 檔（籌碼${mode === 'overnight' ? '＋隔夜勝率' : '＋OPEN GATE'}＋多日因子）${failBit}${avgEdge != null ? `。本輪平均次開勝率約 ${avgEdge}%` : ''}。${muteBit}${gateBit}${autoBit}`
                    : `${uniBit}，但沒有通過最低流動性門檻${failBit}${muteBit ? `；${muteBit}` : ''}${gateBit}`,
            );
        } catch (err) {
            const msg = `篩選失敗：${err instanceof Error ? err.message : String(err)}`;
            setRows([]);
            setStatus(msg);
            persist({ rows: [], status: msg }, true);
        } finally {
            setLoading(false);
        }
    }

    function pickCandidate(item: Scored): void {
        const nowIso = new Date().toISOString();
        const signalDate =
            typeof item.date === 'string' && item.date.length >= 10
                ? item.date.slice(0, 10)
                : taipeiSignalDate(nowIso);
        onAddPrediction({
            id: `${item.code}-${Date.now()}`,
            createdAt: nowIso,
            mode,
            code: item.code,
            name: item.name,
            close: item.close,
            entryPrice: item.entryPrice,
            entryNote: item.entryNote,
            target: item.target,
            sellNote: item.sellNote,
            gainPts: item.gainPts,
            gainPct: item.gainPct,
            rr: item.rr,
            stopLossPct: preset.stopLossPct,
            takeProfitPct: preset.takeProfitPct,
            hardPass: item.strength >= 55,
            softHitCount: item.tags.length,
            pickedConditions: item.tags.map((k) => tagLabels[k]),
            notes: item.notes,
            signalDate,
            source: 'manual',
            strength: item.strength,
            status: 'open',
        });
    }

    return (
        <div className={compactMobile ? styles.wrapFlow : styles.wrap}>
            <div
                className={
                    compactMobile ? styles.controlsCompact : styles.controls
                }
            >
                <div className={styles.modeTabs}>
                    <button
                        type='button'
                        className={
                            mode === 'intraday'
                                ? styles.modeTabActive
                                : styles.modeTab
                        }
                        onClick={() => {
                            setMode('intraday');
                            setStatus(
                                rows.length
                                    ? '已切換「當日當沖」。清單仍保留，按智能篩選才會重算。'
                                    : '已切換「當日當沖」。按智能篩選開始掃描。',
                            );
                        }}
                    >
                        當日當沖
                    </button>
                    <button
                        type='button'
                        className={
                            mode === 'overnight'
                                ? styles.modeTabActive
                                : styles.modeTab
                        }
                        onClick={() => {
                            setMode('overnight');
                            setStatus(
                                rows.length
                                    ? '已切換「隔夜布局」。清單仍保留，按智能篩選才會重算。'
                                    : '已切換「隔夜布局」。按智能篩選開始掃描。',
                            );
                        }}
                    >
                        隔夜布局
                    </button>
                </div>
                {!compactMobile && (
                    <p className={styles.modeBlurb}>{preset.blurb}</p>
                )}
                {staleResults && (
                    <p className={styles.modeBlurb}>
                        清單仍是「
                        {scannedMode === 'overnight' ? '隔夜布局' : '當日當沖'}
                        」結果；切換模式後請再按智能篩選才會重算。
                    </p>
                )}
                <div className={styles.presetBar}>
                    <span>
                        停損 {preset.stopLossPct}% → 目標 +
                        {preset.takeProfitPct}%
                    </span>
                    {topStrength != null && (
                        <span>本輪最高強度 {topStrength}</span>
                    )}
                    {rows.length > 0 && (
                        <span>共 {displayRows.length} 檔{gatePassOnly && mode === 'intraday' && rows.length !== displayRows.length ? `（池 ${rows.length}）` : ''}</span>
                    )}
                    <label className={styles.inlineCheck}>
                        <input
                            type='checkbox'
                            checked={includeWatchlist}
                            onChange={(e) =>
                                setIncludeWatchlist(e.target.checked)
                            }
                        />
                        含自選
                    </label>
                    {mode === 'intraday' && (
                        <label className={styles.inlineCheck} title='關閉＝A/B 對照，含 watch／reject'>
                            <input
                                type='checkbox'
                                checked={!gatePassOnly}
                                onChange={(e) =>
                                    setGatePassOnly(!e.target.checked)
                                }
                            />
                            含未確認
                        </label>
                    )}
                    {!compactMobile && (
                        <button
                            type='button'
                            className={styles.runBtn}
                            disabled={loading}
                            onClick={() => void runScan()}
                        >
                            {loading ? '掃描中…' : '智能篩選'}
                        </button>
                    )}
                </div>
                {compactMobile && (
                    <button
                        type='button'
                        className={styles.runBtnMobile}
                        disabled={loading}
                        onClick={() => void runScan()}
                    >
                        {loading ? '掃描中…' : '開始智能篩選'}
                    </button>
                )}
                <p className={styles.modeBlurb}>{learnStatus}</p>
                <p className={styles.modeBlurb}>{status}</p>
                {gateMeta && mode === 'intraday' && (
                    <p className={styles.modeBlurb}>{gateMeta}</p>
                )}
            </div>

            <div className={compactMobile ? styles.bodyFlow : styles.body}>
                {displayRows.length === 0 && (
                    <div className={styles.empty}>
                        {rows.length > 0 && gatePassOnly && mode === 'intraday'
                            ? '目前沒有 OPEN GATE 通過檔；可勾「含未確認」對照 EOD 觀察池。'
                            : status}
                    </div>
                )}
                {displayRows.map((item, idx) => {
                    const dir =
                        item.change_price > 0
                            ? 'up'
                            : item.change_price < 0
                              ? 'down'
                              : 'flat';
                    return (
                        <div className={styles.card} key={item.code}>
                            <div className={styles.topLine}>
                                <button
                                    type='button'
                                    className={styles.titleBtn}
                                    title='開啟這檔股票的 K 線'
                                    onClick={() => {
                                        persist({}, false);
                                        rememberScreenerPick(item, mode);
                                        onPickCode(item.code);
                                    }}
                                >
                                    #{idx + 1} {item.code} {item.name}
                                </button>
                                <div className={panel.dirText[dir]}>
                                    {fmtPct(item.chgPct)}
                                </div>
                            </div>
                            <div className={styles.priceRow}>
                                <div className={styles.priceBox}>
                                    <span className={styles.priceLabel}>
                                        目前
                                    </span>
                                    <span className={styles.priceValue}>
                                        {fmtPrice(item.close)}
                                    </span>
                                </div>
                                <span className={styles.priceArrow}>→</span>
                                <div className={styles.priceBox}>
                                    <span className={styles.priceLabel}>
                                        最佳進場
                                    </span>
                                    <span className={styles.priceValue}>
                                        {fmtPrice(
                                            item.entryPrice > 0
                                                ? item.entryPrice
                                                : item.close,
                                        )}
                                    </span>
                                </div>
                                <span className={styles.priceArrow}>→</span>
                                <div className={styles.priceBox}>
                                    <span className={styles.priceLabel}>
                                        最佳賣出
                                    </span>
                                    <span
                                        className={`${styles.priceValue} ${panel.dirText.up}`}
                                    >
                                        {fmtPrice(item.target)}
                                    </span>
                                </div>
                                <div className={styles.priceBox}>
                                    <span className={styles.priceLabel}>
                                        預估漲點
                                    </span>
                                    <span
                                        className={`${styles.priceValue} ${panel.dirText.up}`}
                                    >
                                        {item.gainPts != null
                                            ? `+${fmtPrice(item.gainPts)}`
                                            : '—'}
                                    </span>
                                </div>
                                <div className={styles.priceBox}>
                                    <span className={styles.priceLabel}>
                                        強度
                                    </span>
                                    <span className={styles.priceValue}>
                                        {item.strength}
                                    </span>
                                </div>
                                {item.open_score != null && (
                                    <div className={styles.priceBox}>
                                        <span className={styles.priceLabel}>
                                            開盤閘
                                        </span>
                                        <span className={styles.priceValue}>
                                            {item.open_score}
                                            {item.open_confirm
                                                ? `·${item.open_confirm}`
                                                : ''}
                                        </span>
                                    </div>
                                )}
                            </div>
                            <div className={styles.meta}>
                                <span>{modeLabel(mode)}</span>
                                {item.open_confirm && (
                                    <span
                                        style={{
                                            color:
                                                item.open_data_health ===
                                                    'stale' ||
                                                item.open_data_health ===
                                                    'disconnected'
                                                    ? '#a78bfa'
                                                    : item.open_confirm ===
                                                            'pass' ||
                                                        item.open_confirm ===
                                                            'early_pass'
                                                      ? '#34d399'
                                                      : item.open_confirm ===
                                                          'watch'
                                                        ? '#fbbf24'
                                                        : item.open_confirm ===
                                                            'reject'
                                                          ? '#f87171'
                                                          : '#9ca3af',
                                        }}
                                    >
                                        {item.open_phase === 'early'
                                            ? '早盤確認中·'
                                            : ''}
                                        OPEN {item.open_confirm}
                                        {item.open_tradeable_candidate
                                            ? '·可做'
                                            : item.open_tradable
                                              ? '·可做'
                                              : ''}
                                        {item.open_data_blocked ||
                                        item.open_data_health === 'stale' ||
                                        item.open_data_health ===
                                            'disconnected'
                                            ? '·DATA STALE'
                                            : ''}
                                        {item.open_late_candidate
                                            ? '·late→C'
                                            : ''}
                                        {item.open_data_health &&
                                        item.open_data_health !== 'healthy' &&
                                        !item.open_data_blocked
                                            ? `·${item.open_data_health}`
                                            : ''}
                                    </span>
                                )}
                                {item.open_market && (
                                    <span>Market {item.open_market}</span>
                                )}
                                {item.open_rvol != null && (
                                    <span>
                                        RVOL {item.open_rvol.toFixed(2)}x
                                    </span>
                                )}
                                {item.open_vwap_pos != null && (
                                    <span>
                                        VWAP{' '}
                                        {item.open_vwap_pos >= 0 ? '+' : ''}
                                        {item.open_vwap_pos.toFixed(2)}%
                                    </span>
                                )}
                                {item.open_momentum != null && (
                                    <span>Mom {item.open_momentum}</span>
                                )}
                                {item.open_liquidity != null && (
                                    <span>Liq {item.open_liquidity}</span>
                                )}
                                {item.open_chase && (
                                    <span>Chase {item.open_chase}</span>
                                )}
                                {item.open_invalid != null && (
                                    <span>
                                        Invalid {fmtPrice(item.open_invalid)}
                                    </span>
                                )}
                                {item.open_expires_at && (
                                    <span>
                                        有效至{' '}
                                        {new Date(
                                            item.open_expires_at,
                                        ).toLocaleTimeString('zh-TW', {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                            second: '2-digit',
                                        })}
                                    </span>
                                )}
                                <span>RR {item.rr.toFixed(2)}</span>
                                <span>
                                    進場 {item.entryNote || '現價附近'}
                                </span>
                                <span>
                                    賣點{' '}
                                    {item.sellNote ||
                                        (item.gainPct != null
                                            ? `約 +${item.gainPct}%`
                                            : '達標出')}
                                    {item.gainPct != null
                                        ? `（${item.gainPct}%）`
                                        : ''}
                                </span>
                                <span>停損 {fmtPrice(item.stopPrice)}</span>
                                {item.chipsLabel && (
                                    <span>{item.chipsLabel}</span>
                                )}
                                {item.overnightWinRate != null && (
                                    <span>
                                        次開 {item.overnightWinRate}%
                                        {item.overnightLabel
                                            ? ` · ${item.overnightLabel}`
                                            : ''}
                                    </span>
                                )}
                                {item.learnDelta != null && item.learnDelta !== 0 && (
                                    <span>
                                        學習 {item.learnDelta > 0 ? '+' : ''}
                                        {item.learnDelta}
                                    </span>
                                )}
                            </div>
                            <div className={styles.badges}>
                                {item.tags.map((k) => (
                                    <span className={styles.badge} key={k}>
                                        {tagLabels[k]}
                                    </span>
                                ))}
                            </div>
                            <div className={styles.actions}>
                                <button
                                    type='button'
                                    className={styles.actionBtn}
                                    onClick={() => {
                                        persist({}, false);
                                        rememberScreenerPick(item, mode);
                                        onPickCode(item.code);
                                    }}
                                >
                                    看圖表＋AI
                                </button>
                                <button
                                    type='button'
                                    className={styles.pickBtn}
                                    onClick={() => pickCandidate(item)}
                                >
                                    加入布局
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
