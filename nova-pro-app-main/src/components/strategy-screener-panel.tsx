import { useMemo, useState } from 'react';
import { fetchScanner } from '../lib/backend';
import type { ScannerItem } from '../lib/types/market';
import {
    modeLabel,
    type StrategyMode,
    type PredictionRecord,
} from '../lib/prediction-book';
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
    | 'liquid';

interface Scored extends ScannerItem {
    strength: number;
    rr: number;
    tags: TagKey[];
    notes: string[];
    target: number;
    stopPrice: number;
    chgPct: number;
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
        blurb: '盤中當沖：流動性＋動能＋站上均價＋近高點，強度分數最高者優先',
        stopLossPct: 1,
        takeProfitPct: 2,
        pools: { volume: true, amount: true, gainers: true },
    },
    overnight: {
        blurb: '隔夜布局：收盤後也能掃。量夠、波動夠、收盤偏強；漲太多會扣分。休市時改用收盤備援池。',
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

export function StrategyScreenerPanel({
    watchlistSeed,
    onPickCode,
    onAddPrediction,
}: {
    watchlistSeed: Array<{ code: string; name: string; close?: number }>;
    onPickCode: (code: string) => void;
    onAddPrediction: (record: PredictionRecord) => void;
}) {
    const [mode, setMode] = useState<StrategyMode>('intraday');
    const [includeWatchlist, setIncludeWatchlist] = useState(false);
    const [loading, setLoading] = useState(false);
    const [rows, setRows] = useState<Scored[]>([]);
    const [status, setStatus] = useState(
        '選好模式後按「智能篩選」。結果依強度分數排序。',
    );

    const preset = MODE_PRESET[mode];

    const topStrength = useMemo(
        () => (rows[0] ? rows[0].strength : null),
        [rows],
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
                setStatus(
                    failed.length
                        ? `排行榜抓不到資料（失敗：${failed.join('、')}）。休市、金鑰或網路問題時會這樣。`
                        : '排行榜目前沒有資料（可能休市或行情尚未開）。',
                );
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
                .slice(0, 30);

            setRows(scored);
            const failBit = failed.length
                ? `（部分來源失敗：${failed.join('、')}）`
                : '';
            setStatus(
                scored.length
                    ? `掃描 ${list.length} 檔 → 最強 ${scored.length} 檔${failBit}。分數越高越適合現在這模式。`
                    : `掃描 ${list.length} 檔，但沒有通過最低流動性門檻${failBit}。`,
            );
        } catch (err) {
            setRows([]);
            setStatus(
                `篩選失敗：${err instanceof Error ? err.message : String(err)}`,
            );
        } finally {
            setLoading(false);
        }
    }

    function pickCandidate(item: Scored): void {
        onAddPrediction({
            id: `${item.code}-${Date.now()}`,
            createdAt: new Date().toISOString(),
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
        });
    }

    return (
        <div className={styles.wrap}>
            <div className={styles.controls}>
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
                            setRows([]);
                            setStatus(
                                '已切換「當日當沖」。按智能篩選重新掃描。',
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
                            setRows([]);
                            setStatus(
                                '已切換「隔夜布局」。按智能篩選重新掃描。',
                            );
                        }}
                    >
                        隔夜布局
                    </button>
                </div>
                <p className={styles.modeBlurb}>{preset.blurb}</p>
                <div className={styles.presetBar}>
                    <span>
                        停損 {preset.stopLossPct}% → 目標 +
                        {preset.takeProfitPct}%
                    </span>
                    {topStrength != null && (
                        <span>本輪最高強度 {topStrength}</span>
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
                    <button
                        type='button'
                        className={styles.runBtn}
                        disabled={loading}
                        onClick={() => void runScan()}
                    >
                        {loading ? '掃描中…' : '智能篩選'}
                    </button>
                </div>
                <p className={styles.modeBlurb}>{status}</p>
            </div>

            <div className={styles.body}>
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
                                        sessionStorage.setItem(
                                            'nova-screener-code',
                                            item.code,
                                        );
                                        sessionStorage.setItem(
                                            'nova-screener-strength',
                                            String(item.strength),
                                        );
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
                                        sessionStorage.setItem(
                                            'nova-screener-code',
                                            item.code,
                                        );
                                        sessionStorage.setItem(
                                            'nova-screener-strength',
                                            String(item.strength),
                                        );
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
