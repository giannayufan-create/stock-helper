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

type SoftKey =
    | 'momentum'
    | 'aboveAvg'
    | 'volumeRatio'
    | 'nearHigh'
    | 'rangeWide'
    | 'openStrength';

interface Candidate extends ScannerItem {}

interface Scored extends Candidate {
    hardPass: boolean;
    rr: number;
    softHits: SoftKey[];
    notes: string[];
    target: number;
    stopPrice: number;
}

const softLabels: Record<SoftKey, string> = {
    momentum: '動能',
    aboveAvg: '站上均價',
    volumeRatio: '量比',
    nearHigh: '近高點',
    rangeWide: '波動夠',
    openStrength: '收強',
};

const MODE_PRESET: Record<
    StrategyMode,
    {
        blurb: string;
        kValue: number;
        stopLossPct: number;
        takeProfitPct: number;
        rrMin: number;
        pools: { volume: boolean; amount: boolean; gainers: boolean };
        softs: SoftKey[];
    }
> = {
    intraday: {
        blurb: '盤中找當沖：偏強勢、流動性好、今天就能做',
        kValue: 3,
        stopLossPct: 1,
        takeProfitPct: 2,
        rrMin: 2,
        pools: { volume: true, amount: true, gainers: false },
        softs: ['momentum', 'aboveAvg', 'volumeRatio', 'nearHigh'],
    },
    overnight: {
        blurb: '收盤後布局：挑明天可當沖的候補，波動夠、量夠、別追過頭',
        kValue: 2,
        stopLossPct: 1.2,
        takeProfitPct: 2.5,
        rrMin: 1.8,
        pools: { volume: true, amount: true, gainers: true },
        softs: ['volumeRatio', 'rangeWide', 'openStrength', 'aboveAvg'],
    },
};

function pct(v: number, base: number): number {
    if (!base) return 0;
    return (v / base) * 100;
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

    const preset = MODE_PRESET[mode];

    const selectedSoftKeys = useMemo(() => preset.softs, [preset]);

    async function loadCandidates(): Promise<Candidate[]> {
        const merged = new Map<string, Candidate>();
        const add = (item: ScannerItem) => {
            merged.set(item.code, item);
        };

        const jobs: Promise<ScannerItem[]>[] = [];
        if (preset.pools.volume) jobs.push(fetchScanner('VolumeRank', 50));
        if (preset.pools.amount) jobs.push(fetchScanner('AmountRank', 50));
        if (preset.pools.gainers)
            jobs.push(fetchScanner('ChangePercentRank', 50));
        const chunks = await Promise.allSettled(jobs);
        for (const hit of chunks) {
            if (hit.status === 'fulfilled') hit.value.forEach(add);
        }

        if (includeWatchlist) {
            watchlistSeed.forEach((w) => {
                add({
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

        return [...merged.values()];
    }

    function score(row: Candidate): Scored {
        const { stopLossPct, takeProfitPct, rrMin } = preset;
        const rangePct = pct(row.high - row.low, row.close);
        const closeNearHigh = row.high > 0 && row.close >= row.high * 0.992;
        const pullbackOk =
            row.high > 0 &&
            row.close >= row.high * 0.97 &&
            row.close < row.high * 0.995;
        const riskPctRaw =
            row.close > 0 ? pct(row.close - row.low, row.close) : 0;
        const rewardPctRaw =
            row.close > 0 ? pct(Math.max(row.high - row.close, 0), row.close) : 0;
        const riskPct = Math.max(stopLossPct, riskPctRaw);
        const rewardPct = Math.max(takeProfitPct, rewardPctRaw);
        const rr = riskPct > 0 ? rewardPct / riskPct : 0;

        const coreDirection =
            mode === 'intraday'
                ? row.change_price > 0
                : row.close >= row.open || pullbackOk;
        const liquidity = row.total_volume >= 500 || row.rank_value > 0;
        const notOverextended =
            mode === 'overnight'
                ? pct(
                      row.change_price,
                      row.close - row.change_price || row.close,
                  ) < 7
                : true;
        const hardPass =
            coreDirection && liquidity && rr >= rrMin && notOverextended;

        const hitMap: Record<SoftKey, boolean> = {
            momentum:
                pct(
                    row.change_price,
                    row.close - row.change_price || row.close,
                ) > 0.8,
            aboveAvg: row.close >= row.average_price,
            volumeRatio: row.volume_ratio >= 1.2,
            nearHigh: closeNearHigh,
            rangeWide: rangePct >= 1.8,
            openStrength: row.close > row.open,
        };

        const softHits = selectedSoftKeys.filter((k) => hitMap[k]);
        const target = +(row.close * (1 + takeProfitPct / 100)).toFixed(2);
        const stopPrice = +(row.close * (1 - stopLossPct / 100)).toFixed(2);
        const notes = [
            `RR ${rr.toFixed(2)}`,
            `量比 ${row.volume_ratio.toFixed(2)}`,
        ];
        return {
            ...row,
            hardPass,
            rr,
            softHits,
            notes,
            target,
            stopPrice,
        };
    }

    async function runScan(): Promise<void> {
        setLoading(true);
        try {
            const base = await loadCandidates();
            const scored = base
                .map(score)
                .filter(
                    (s) =>
                        s.hardPass && s.softHits.length >= preset.kValue,
                )
                .sort(
                    (a, b) =>
                        b.rr - a.rr || b.softHits.length - a.softHits.length,
                )
                .slice(0, 40);
            setRows(scored);
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
            hardPass: item.hardPass,
            softHitCount: item.softHits.length,
            pickedConditions: item.softHits.map((k) => softLabels[k]),
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
                        }}
                    >
                        隔夜布局
                    </button>
                </div>
                <p className={styles.modeBlurb}>{preset.blurb}</p>
                <div className={styles.presetBar}>
                    <span>
                        停損 {preset.stopLossPct}% → 目標 +{preset.takeProfitPct}%
                    </span>
                    <span>RR ≥ {preset.rrMin}</span>
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
                        className={styles.runBtn}
                        onClick={() => void runScan()}
                    >
                        {loading ? '掃描中…' : '智能篩選'}
                    </button>
                </div>
            </div>

            <div className={styles.body}>
                {rows.length === 0 && (
                    <div className={styles.empty}>
                        選好模式後按「智能篩選」。結果會顯示目前價與預計目標價。
                    </div>
                )}
                {rows.map((item) => {
                    const chgPct =
                        item.close && item.change_price
                            ? pct(
                                  item.change_price,
                                  item.close - item.change_price || item.close,
                              )
                            : 0;
                    const dir =
                        item.change_price > 0
                            ? 'up'
                            : item.change_price < 0
                              ? 'down'
                              : 'flat';
                    return (
                        <div className={styles.card} key={item.code}>
                            <div className={styles.topLine}>
                                <div className={styles.title}>
                                    {item.code} {item.name}
                                </div>
                                <div className={panel.dirText[dir]}>
                                    {fmtPct(chgPct)}
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
                            </div>
                            <div className={styles.meta}>
                                <span>{modeLabel(mode)}</span>
                                <span>RR {item.rr.toFixed(2)}</span>
                                <span>
                                    停損 {fmtPrice(item.stopPrice)}
                                </span>
                                <span>
                                    命中 {item.softHits.length}/
                                    {preset.kValue}+
                                </span>
                            </div>
                            <div className={styles.badges}>
                                {item.softHits.map((k) => (
                                    <span className={styles.badge} key={k}>
                                        {softLabels[k]}
                                    </span>
                                ))}
                            </div>
                            <div className={styles.actions}>
                                <button
                                    className={styles.actionBtn}
                                    onClick={() => onPickCode(item.code)}
                                >
                                    看圖表＋AI
                                </button>
                                <button
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
