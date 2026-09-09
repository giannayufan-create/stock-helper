import { useEffect, useMemo, useState } from 'react';
import {
    fetchOvernightEdge,
    fetchPublicChips,
    fetchScanner,
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
    | 'overnightEdge';

interface Scored extends ScannerItem {
    strength: number;
    rr: number;
    tags: TagKey[];
    notes: string[];
    target: number;
    stopPrice: number;
    chgPct: number;
    chipsLabel?: string;
    overnightWinRate?: number;
    overnightLabel?: string;
    learnDelta?: number;
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
        blurb: '當沖獲利流：流動性＋動能＋站上均價，再疊三大法人／融資券加權。分數高≠保證賺。',
        stopLossPct: 1,
        takeProfitPct: 2,
        pools: { volume: true, amount: true, gainers: true },
    },
    overnight: {
        blurb: '隔夜布局流：收盤偏強＋籌碼，再查近半年「收盤→次開」歷史勝率加權。勝率是統計，不是保證。',
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

/** 0～100 綜合強度：流動性 / 動能適配 / 結構 / 可做空間 */
function scoreStrength(
    row: ScannerItem,
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
    const riskPct = Math.max(
        stopLossPct,
        row.close > 0 ? pct(row.close - row.low, row.close) : 0,
    );
    const rewardPct = Math.max(
        takeProfitPct,
        row.close > 0 ? pct(Math.max(row.high - row.close, 0), row.close) : 0,
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
        if (chgPct > 6) momentum -= 4; // 盤中也別追太兇
        if (row.close > row.open) momentum += 5;
    } else {
        if (row.close >= row.open) momentum += 8;
        if (chgPct > 0 && chgPct <= 4) momentum += 10;
        if (chgPct > 4 && chgPct <= 6) momentum += 4;
        if (chgPct > 6) momentum -= 10; // 隔夜最忌追過頭
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
    if (row.close > 5 && row.close < 800) setup += 3; // 避開極低/極高價難做
    setup = clamp(setup, 0, 25);

    const strength = Math.round(liquid + momentum + structure + setup);

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

    const target = +(row.close * (1 + takeProfitPct / 100)).toFixed(2);
    const stopPrice = +(row.close * (1 - stopLossPct / 100)).toFixed(2);

    return {
        ...row,
        strength,
        rr,
        tags,
        notes: [
            `強度 ${strength}`,
            `流動${liquid}/動能${momentum}/結構${structure}/空間${setup}`,
        ],
        target,
        stopPrice,
        chgPct,
    };
}

function rememberScreenerPick(item: Scored, mode: StrategyMode): void {
    sessionStorage.setItem('nova-screener-code', item.code);
    sessionStorage.setItem('nova-screener-strength', String(item.strength));
    sessionStorage.setItem('nova-screener-mode', mode);
    sessionStorage.setItem('nova-screener-target', String(item.target));
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
    const learnModel = useMemo(() => buildLearnModel(loadPredictions()), [rows]);
    const learnStatus = useMemo(
        () => formatLearnStatus(learnModel, mode),
        [learnModel, mode],
    );

    async function loadCandidates(): Promise<{
        list: ScannerItem[];
        failed: string[];
    }> {
        const merged = new Map<string, ScannerItem>();
        const failed: string[] = [];
        const jobs: Array<{ label: string; p: Promise<ScannerItem[]> }> = [];
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
                hit.value.forEach((item) => merged.set(item.code, item));
            } else {
                failed.push(label);
            }
        });

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

        return { list: [...merged.values()], failed };
    }

    async function runScan(): Promise<void> {
        if (loading) return;
        setLoading(true);
        setStatus('掃描中…正在抓排行榜並計算強度');
        try {
            const { list, failed } = await loadCandidates();
            if (list.length === 0) {
                setRows([]);
                const msg = failed.length
                    ? `排行榜抓不到資料（失敗：${failed.join('、')}）。休市、金鑰或網路問題時會這樣。`
                    : '排行榜目前沒有資料（可能休市或行情尚未開）。';
                setStatus(msg);
                persist({ rows: [], status: msg }, true);
                return;
            }

            const scored = list
                .filter((r) => r.close > 0)
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

            // 第二步：用布局本已驗證成績做輕量學習微調（樣本不足則為 0）
            finalRows = finalRows
                .map((s) => {
                    const labels = s.tags.map((k) => tagLabels[k]);
                    const { delta, parts } = learnDeltaForTags(
                        learnModel,
                        mode,
                        labels,
                    );
                    if (!delta) return s;
                    const strength = Math.max(
                        0,
                        Math.min(100, Math.round(s.strength + delta)),
                    );
                    return {
                        ...s,
                        strength,
                        learnDelta: delta,
                        notes: [
                            ...s.notes,
                            `學習 ${delta > 0 ? '+' : ''}${delta}${parts.length ? `（${parts.join('、')}）` : ''}`,
                        ],
                    };
                })
                .sort(
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
                            target: item.target,
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
                ? `（部分來源失敗：${failed.join('、')}）`
                : '';
            const autoBit = finalRows.length
                ? `已自動記入前 ${Math.min(AUTO_SCAN_TOP_N, finalRows.length)} 名到布局本。`
                : '';
            setStatus(
                finalRows.length
                    ? `掃描 ${list.length} 檔 → 最強 ${finalRows.length} 檔（籌碼${mode === 'overnight' ? '＋隔夜勝率' : ''}）${failBit}${avgEdge != null ? `。本輪平均次開勝率約 ${avgEdge}%` : ''}。${autoBit}`
                    : `掃描 ${list.length} 檔，但沒有通過最低流動性門檻${failBit}。`,
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
            target: item.target,
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
                        <span>共 {rows.length} 檔</span>
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
            </div>

            <div className={compactMobile ? styles.bodyFlow : styles.body}>
                {rows.length === 0 && (
                    <div className={styles.empty}>{status}</div>
                )}
                {rows.map((item, idx) => {
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
                                        預計到
                                    </span>
                                    <span
                                        className={`${styles.priceValue} ${panel.dirText.up}`}
                                    >
                                        {fmtPrice(item.target)}
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
                            </div>
                            <div className={styles.meta}>
                                <span>{modeLabel(mode)}</span>
                                <span>RR {item.rr.toFixed(2)}</span>
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
