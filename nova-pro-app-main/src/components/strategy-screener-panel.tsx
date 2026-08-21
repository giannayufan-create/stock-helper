import { useMemo, useState } from 'react';
import { fetchScanner } from '../lib/backend';
import type { ScannerItem } from '../lib/types/market';
import type { StrategyMode, PredictionRecord } from '../lib/prediction-book';
import { fmtPct, fmtPrice } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './strategy-screener-panel.css';

type PoolKey = 'volumeTop50' | 'amountTop50' | 'gainersTop50' | 'watchlist';
type IndustryKey = 'electronic' | 'financial' | 'traditional' | 'other';
type SoftKey =
    | 'momentum'
    | 'aboveAvg'
    | 'volumeRatio'
    | 'nearHigh'
    | 'rangeWide'
    | 'openStrength';

interface Candidate extends ScannerItem {
    industry: IndustryKey;
}

interface Scored extends Candidate {
    hardPass: boolean;
    rr: number;
    softHits: SoftKey[];
    notes: string[];
}

const softLabels: Record<SoftKey, string> = {
    momentum: '動能上行',
    aboveAvg: '現價高於均價',
    volumeRatio: '量比達標',
    nearHigh: '接近當日高點',
    rangeWide: '波動夠大',
    openStrength: '收盤強於開盤',
};

const industryLabels: Record<IndustryKey, string> = {
    electronic: '電子',
    financial: '金融',
    traditional: '傳產',
    other: '其他/未分類',
};

function classifyIndustry(name: string): IndustryKey {
    if (/(電|半導體|晶|網通|光電|IC|科技)/i.test(name)) return 'electronic';
    if (/(金控|銀行|保險|證券|票券)/i.test(name)) return 'financial';
    if (/(鋼|航運|塑|紡|化|食品|水泥|汽車|建設)/i.test(name))
        return 'traditional';
    return 'other';
}

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
    const [mode, setMode] = useState<StrategyMode>('daytrade');
    const [kValue, setKValue] = useState(4);
    const [stopLossPct, setStopLossPct] = useState(1);
    const [takeProfitPct, setTakeProfitPct] = useState(2);
    const [rrMin, setRrMin] = useState(2);
    const [loading, setLoading] = useState(false);
    const [rows, setRows] = useState<Scored[]>([]);

    const [pools, setPools] = useState<Record<PoolKey, boolean>>({
        volumeTop50: true,
        amountTop50: false,
        gainersTop50: false,
        watchlist: false,
    });
    const [industries, setIndustries] = useState<Record<IndustryKey, boolean>>({
        electronic: true,
        financial: true,
        traditional: true,
        other: true,
    });
    const [softs, setSofts] = useState<Record<SoftKey, boolean>>({
        momentum: true,
        aboveAvg: true,
        volumeRatio: true,
        nearHigh: true,
        rangeWide: false,
        openStrength: false,
    });

    const selectedSoftKeys = useMemo(
        () => (Object.keys(softs) as SoftKey[]).filter((k) => softs[k]),
        [softs],
    );

    async function loadCandidates(): Promise<Candidate[]> {
        const merged = new Map<string, Candidate>();
        const add = (item: ScannerItem) => {
            merged.set(item.code, {
                ...item,
                industry: classifyIndustry(item.name),
            });
        };

        const jobs: Promise<ScannerItem[]>[] = [];
        if (pools.volumeTop50) jobs.push(fetchScanner('VolumeRank', 50));
        if (pools.amountTop50) jobs.push(fetchScanner('AmountRank', 50));
        if (pools.gainersTop50) jobs.push(fetchScanner('ChangePercentRank', 50));
        const chunks = await Promise.allSettled(jobs);
        for (const hit of chunks) {
            if (hit.status === 'fulfilled') hit.value.forEach(add);
        }

        if (pools.watchlist) {
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

        const enabledIndustries = new Set(
            (Object.keys(industries) as IndustryKey[]).filter((i) => industries[i]),
        );
        return [...merged.values()].filter((r) => enabledIndustries.has(r.industry));
    }

    function score(row: Candidate): Scored {
        const rangePct = pct(row.high - row.low, row.close);
        const closeNearHigh = row.high > 0 && row.close >= row.high * 0.992;
        const riskPctRaw = row.close > 0 ? pct(row.close - row.low, row.close) : 0;
        const rewardPctRaw =
            row.close > 0 ? pct(Math.max(row.high - row.close, 0), row.close) : 0;
        const riskPct = Math.max(stopLossPct, riskPctRaw);
        const rewardPct = Math.max(takeProfitPct, rewardPctRaw);
        const rr = riskPct > 0 ? rewardPct / riskPct : 0;

        const coreDirection =
            mode === 'daytrade' ? row.change_price > 0 : row.close >= row.open;
        const liquidity = row.total_volume >= 500 || row.rank_value > 0;
        const rrPass = rr >= rrMin;
        const hardPass = coreDirection && liquidity && rrPass;

        const hitMap: Record<SoftKey, boolean> = {
            momentum: pct(row.change_price, row.close - row.change_price || row.close) > 0.8,
            aboveAvg: row.close >= row.average_price,
            volumeRatio: row.volume_ratio >= 1.2,
            nearHigh: closeNearHigh,
            rangeWide: rangePct >= 1.8,
            openStrength: row.close > row.open,
        };

        const softHits = selectedSoftKeys.filter((k) => hitMap[k]);
        const notes = [
            `RR ${rr.toFixed(2)}`,
            `量 ${Math.round(row.total_volume).toLocaleString()}`,
            `量比 ${row.volume_ratio.toFixed(2)}`,
        ];
        return { ...row, hardPass, rr, softHits, notes };
    }

    async function runScan(): Promise<void> {
        setLoading(true);
        try {
            const base = await loadCandidates();
            const scored = base
                .map(score)
                .filter((s) => s.hardPass && s.softHits.length >= kValue)
                .sort((a, b) => b.rr - a.rr || b.softHits.length - a.softHits.length)
                .slice(0, 50);
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
            rr: item.rr,
            stopLossPct,
            takeProfitPct,
            hardPass: item.hardPass,
            softHitCount: item.softHits.length,
            pickedConditions: item.softHits.map((k) => softLabels[k]),
            notes: item.notes,
        });
    }

    return (
        <div className={styles.wrap}>
            <div className={styles.controls}>
                <div className={styles.row}>
                    <span className={styles.label}>模式</span>
                    <select
                        className={styles.select}
                        value={mode}
                        onChange={(e) => setMode(e.target.value as StrategyMode)}
                    >
                        <option value='daytrade'>當沖</option>
                        <option value='swing'>波段</option>
                    </select>
                    <span className={styles.label}>K 值</span>
                    <input
                        className={styles.miniInput}
                        value={kValue}
                        min={1}
                        max={6}
                        type='number'
                        onChange={(e) => setKValue(Number(e.target.value) || 4)}
                    />
                    <span className={styles.label}>RR≥</span>
                    <input
                        className={styles.miniInput}
                        value={rrMin}
                        min={1}
                        max={6}
                        step={0.1}
                        type='number'
                        onChange={(e) => setRrMin(Number(e.target.value) || 2)}
                    />
                </div>
                <div className={styles.row}>
                    <span className={styles.label}>停損%</span>
                    <input
                        className={styles.miniInput}
                        value={stopLossPct}
                        step={0.1}
                        min={0.1}
                        type='number'
                        onChange={(e) => setStopLossPct(Number(e.target.value) || 1)}
                    />
                    <span className={styles.label}>停利%</span>
                    <input
                        className={styles.miniInput}
                        value={takeProfitPct}
                        step={0.1}
                        min={0.1}
                        type='number'
                        onChange={(e) => setTakeProfitPct(Number(e.target.value) || 2)}
                    />
                </div>

                <div className={styles.row}>
                    <span className={styles.label}>候選池</span>
                    <div className={styles.section}>
                        {(Object.keys(pools) as PoolKey[]).map((key) => (
                            <label className={styles.checkbox} key={key}>
                                <input
                                    type='checkbox'
                                    checked={pools[key]}
                                    onChange={(e) =>
                                        setPools((prev) => ({
                                            ...prev,
                                            [key]: e.target.checked,
                                        }))
                                    }
                                />
                                {{
                                    volumeTop50: '流動性 Top50',
                                    amountTop50: '成交額 Top50',
                                    gainersTop50: '漲幅 Top50',
                                    watchlist: '我的自選',
                                }[key]}
                            </label>
                        ))}
                    </div>
                </div>

                <div className={styles.row}>
                    <span className={styles.label}>產業複選</span>
                    <div className={styles.section}>
                        {(Object.keys(industries) as IndustryKey[]).map((key) => (
                            <label className={styles.checkbox} key={key}>
                                <input
                                    type='checkbox'
                                    checked={industries[key]}
                                    onChange={(e) =>
                                        setIndustries((prev) => ({
                                            ...prev,
                                            [key]: e.target.checked,
                                        }))
                                    }
                                />
                                {industryLabels[key]}
                            </label>
                        ))}
                    </div>
                </div>

                <div className={styles.row}>
                    <span className={styles.label}>軟條件</span>
                    <div className={styles.section}>
                        {(Object.keys(softs) as SoftKey[]).map((key) => (
                            <label className={styles.checkbox} key={key}>
                                <input
                                    type='checkbox'
                                    checked={softs[key]}
                                    onChange={(e) =>
                                        setSofts((prev) => ({
                                            ...prev,
                                            [key]: e.target.checked,
                                        }))
                                    }
                                />
                                {softLabels[key]}
                            </label>
                        ))}
                    </div>
                    <button className={styles.runBtn} onClick={() => void runScan()}>
                        {loading ? '掃描中…' : '一鍵找可買'}
                    </button>
                </div>
            </div>

            <div className={styles.body}>
                {rows.length === 0 && (
                    <div className={styles.empty}>
                        還沒有篩選結果，請按「一鍵找可買」。
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
                                <div className={`${panel.dirText[dir]}`}>
                                    {fmtPrice(item.close)} {fmtPct(chgPct)}
                                </div>
                            </div>
                            <div className={styles.meta}>
                                <span>{industryLabels[item.industry]}</span>
                                <span>RR {item.rr.toFixed(2)}</span>
                                <span>命中 {item.softHits.length}</span>
                                <span>量比 {item.volume_ratio.toFixed(2)}</span>
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
                                    看圖表
                                </button>
                                <button
                                    className={styles.pickBtn}
                                    onClick={() => pickCandidate(item)}
                                >
                                    我打算買
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

