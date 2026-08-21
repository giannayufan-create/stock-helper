import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

type TipBody = {
    affect: string;
    range: string;
    meaning: string;
};

const softLabels: Record<SoftKey, string> = {
    momentum: '動能上行',
    aboveAvg: '現價高於均價',
    volumeRatio: '量比達標',
    nearHigh: '接近當日高點',
    rangeWide: '波動夠大',
    openStrength: '收盤強於開盤',
};

const softTips: Record<SoftKey, TipBody> = {
    momentum: {
        affect: '是否算「動能」命中一項',
        range: '漲幅 > 約 0.8% 才算命中',
        meaning: '勾選後，沒漲夠的票會少一點命中數',
    },
    aboveAvg: {
        affect: '現價是否站上當日均價',
        range: '現價 ≥ 均價',
        meaning: '偏多才過；跌破均價不算命中',
    },
    volumeRatio: {
        affect: '量能是否夠熱',
        range: '量比 ≥ 1.2',
        meaning: '量比太低＝交投冷，不易當沖進出',
    },
    nearHigh: {
        affect: '是否逼近當日高點',
        range: '收盤 ≥ 當日高點約 99.2%',
        meaning: '偏追強；離高點遠就不算命中',
    },
    rangeWide: {
        affect: '當日波動是否夠大',
        range: '高低振幅 ≥ 1.8%',
        meaning: '波動太小難做出停損停利空間',
    },
    openStrength: {
        affect: '收盤是否強於開盤',
        range: '收盤 > 開盤',
        meaning: '紅 K／偏強；綠 K 不算命中',
    },
};

const poolLabels: Record<PoolKey, string> = {
    volumeTop50: '流動性 Top50',
    amountTop50: '成交額 Top50',
    gainersTop50: '漲幅 Top50',
    watchlist: '我的自選',
};

const poolTips: Record<PoolKey, TipBody> = {
    volumeTop50: {
        affect: '從哪裡撈候選股',
        range: '成交量排名前 50 名',
        meaning: '流動性好、較好進出；只勾這個結果較少但乾淨',
    },
    amountTop50: {
        affect: '從哪裡撈候選股',
        range: '成交金額排名前 50 名',
        meaning: '資金熱度高；可跟流動性一起勾，名單會變多',
    },
    gainersTop50: {
        affect: '從哪裡撈候選股',
        range: '漲幅排名前 50 名',
        meaning: '偏追強勢股；容易已漲一截',
    },
    watchlist: {
        affect: '從哪裡撈候選股',
        range: '你的自選清單',
        meaning: '只篩你有加的股票，不管排行榜',
    },
};

const industryLabels: Record<IndustryKey, string> = {
    electronic: '電子',
    financial: '金融',
    traditional: '傳產',
    other: '其他/未分類',
};

const industryTips: Record<IndustryKey, TipBody> = {
    electronic: {
        affect: '產業過濾',
        range: '股名含電／半導體／晶／網通等',
        meaning: '取消勾選＝這類股不會出現',
    },
    financial: {
        affect: '產業過濾',
        range: '股名含金控／銀行／保險／證券等',
        meaning: '取消勾選＝金融股不會出現',
    },
    traditional: {
        affect: '產業過濾',
        range: '股名含鋼／航運／塑化／紡織等',
        meaning: '取消勾選＝傳產股不會出現',
    },
    other: {
        affect: '產業過濾',
        range: '對不到上面關鍵字的股票',
        meaning: '取消勾選＝未分類股不會出現',
    },
};

const fieldTips = {
    mode: {
        affect: '硬條件怎麼判斷方向',
        range: '當沖 或 波段',
        meaning:
            '當沖：要今日上漲＋有流動性。波段：收盤相對開盤偏強即可。影響誰能進候選，不改 K 值算法。',
    },
    kValue: {
        affect: '軟條件至少要命中幾項才進結果',
        range: '建議 1～6（介面允許 1～6）',
        meaning:
            '1～2＝鬆、名單多；3＝一般（預設）；4＝偏嚴；5～6＝很嚴、常常沒結果。數字越大候選越少。',
    },
    rrMin: {
        affect: '報酬／風險比下限，未達就不進結果',
        range: '建議 1.0～3.0（介面約 1～6）',
        meaning:
            '1.0～1.5＝鬆、風險偏大；2.0＝常用門檻（賺至少是虧的 2 倍）；2.5～3＝很挑、名單少。',
    },
    stopLoss: {
        affect: '估風險距離與 RR；也寫進預測本',
        range: '建議 0.5～2.0（最小約 0.1）',
        meaning:
            '0.5～0.8＝緊、易洗；1.0＝當沖常用；1.5～2.0＝寬、較扛波動但 RR 較難達標。',
    },
    takeProfit: {
        affect: '估報酬距離與 RR；也寫進預測本',
        range: '建議 1.0～4.0（最小約 0.1）',
        meaning:
            '通常設成停損的 2 倍以上。例：停損 1% → 停利 2% 才容易 RR≥2。停利太小＝RR 不夠被刷掉。',
    },
    maxPrice: {
        affect: '現價上限過濾',
        range: '空白＝不限；或填正數（元）',
        meaning:
            '例填 100＝只要 ≤100 元。影響資金門檻，不影響 K 值／RR 算法。',
    },
    pools: {
        affect: '候選股來源（可複選合併）',
        range: '至少勾 1 個池',
        meaning: '勾越多名單越大；一個都不勾就幾乎掃不到。',
    },
    industries: {
        affect: '產業白名單',
        range: '可複選',
        meaning: '取消某產業＝該類完全不出現。',
    },
    softs: {
        affect: '軟條件加分項；命中數要 ≥ K 值',
        range: '可複選 0～6 項',
        meaning: '勾越多越容易湊滿 K 值；但每項本身也有門檻（見各項說明）。',
    },
} as const satisfies Record<string, TipBody>;

function Tip({
    label,
    tip,
    short,
    children,
}: {
    label: string;
    tip: TipBody;
    short: string;
    children?: React.ReactNode;
}) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState({ top: 0, left: 0 });

    useLayoutEffect(() => {
        if (!open || !wrapRef.current) return;
        const r = wrapRef.current.getBoundingClientRect();
        const width = Math.min(300, window.innerWidth - 16);
        let left = r.left;
        if (left + width > window.innerWidth - 8) {
            left = Math.max(8, window.innerWidth - width - 8);
        }
        let top = r.bottom + 6;
        if (top + 160 > window.innerHeight) {
            top = Math.max(8, r.top - 166);
        }
        setPos({ top, left });
    }, [open]);

    return (
        <div
            ref={wrapRef}
            className={styles.fieldCard}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
        >
            <div className={styles.fieldHead}>
                <span className={styles.fieldTitle}>{label}</span>
                <span className={styles.fieldHelpMark} aria-hidden>
                    ?
                </span>
            </div>
            <div className={styles.fieldControl}>{children}</div>
            <div className={styles.fieldShort}>{short}</div>
            {open &&
                createPortal(
                    <div
                        className={styles.tipBubble}
                        style={{ top: pos.top, left: pos.left }}
                        role='tooltip'
                    >
                        <div className={styles.tipLine}>
                            <b>影響</b> {tip.affect}
                        </div>
                        <div className={styles.tipLine}>
                            <b>區間</b> {tip.range}
                        </div>
                        <div className={styles.tipLine}>
                            <b>意思</b> {tip.meaning}
                        </div>
                    </div>,
                    document.body,
                )}
        </div>
    );
}

function TipCheck({
    tip,
    checked,
    onChange,
    children,
}: {
    tip: TipBody;
    checked: boolean;
    onChange: (next: boolean) => void;
    children: React.ReactNode;
}) {
    const wrapRef = useRef<HTMLLabelElement>(null);
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState({ top: 0, left: 0 });

    useLayoutEffect(() => {
        if (!open || !wrapRef.current) return;
        const r = wrapRef.current.getBoundingClientRect();
        const width = Math.min(280, window.innerWidth - 16);
        let left = r.left;
        if (left + width > window.innerWidth - 8) {
            left = Math.max(8, window.innerWidth - width - 8);
        }
        let top = r.bottom + 6;
        if (top + 140 > window.innerHeight) {
            top = Math.max(8, r.top - 146);
        }
        setPos({ top, left });
    }, [open]);

    return (
        <label
            ref={wrapRef}
            className={styles.checkbox}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
        >
            <input
                type='checkbox'
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
            />
            {children}
            {open &&
                createPortal(
                    <div
                        className={styles.tipBubble}
                        style={{ top: pos.top, left: pos.left }}
                        role='tooltip'
                    >
                        <div className={styles.tipLine}>
                            <b>影響</b> {tip.affect}
                        </div>
                        <div className={styles.tipLine}>
                            <b>區間</b> {tip.range}
                        </div>
                        <div className={styles.tipLine}>
                            <b>意思</b> {tip.meaning}
                        </div>
                    </div>,
                    document.body,
                )}
        </label>
    );
}

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
    const [kValue, setKValue] = useState(3);
    const [stopLossPct, setStopLossPct] = useState(1);
    const [takeProfitPct, setTakeProfitPct] = useState(2);
    const [rrMin, setRrMin] = useState(2);
    const [maxPrice, setMaxPrice] = useState<number | ''>('');
    const [loading, setLoading] = useState(false);
    const [rows, setRows] = useState<Scored[]>([]);

    const [pools, setPools] = useState<Record<PoolKey, boolean>>({
        volumeTop50: true,
        amountTop50: true,
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
        const pricePass =
            maxPrice === '' || maxPrice <= 0 || row.close <= maxPrice;
        const hardPass = coreDirection && liquidity && rrPass && pricePass;

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
                <div className={styles.fieldGrid}>
                    <Tip
                        label='交易模式'
                        short='當沖＝看今天漲跌；波段＝看收盤強弱'
                        tip={fieldTips.mode}
                    >
                        <select
                            className={styles.select}
                            value={mode}
                            onChange={(e) =>
                                setMode(e.target.value as StrategyMode)
                            }
                        >
                            <option value='daytrade'>當沖</option>
                            <option value='swing'>波段</option>
                        </select>
                    </Tip>
                    <Tip
                        label='命中數門檻（K）'
                        short='1～6；越大越嚴。4＝要湊滿 4 個軟條件'
                        tip={fieldTips.kValue}
                    >
                        <input
                            className={styles.miniInput}
                            value={kValue}
                            min={1}
                            max={6}
                            type='number'
                            onChange={(e) =>
                                setKValue(Number(e.target.value) || 4)
                            }
                        />
                    </Tip>
                    <Tip
                        label='賺賠比下限（RR）'
                        short='常用 2＝賺至少是虧的 2 倍；低於就刷掉'
                        tip={fieldTips.rrMin}
                    >
                        <input
                            className={styles.miniInput}
                            value={rrMin}
                            min={1}
                            max={6}
                            step={0.1}
                            type='number'
                            onChange={(e) =>
                                setRrMin(Number(e.target.value) || 2)
                            }
                        />
                    </Tip>
                    <Tip
                        label='停損％'
                        short='建議 0.5～2；1＝虧 1% 就砍，用來算風險'
                        tip={fieldTips.stopLoss}
                    >
                        <input
                            className={styles.miniInput}
                            value={stopLossPct}
                            step={0.1}
                            min={0.1}
                            type='number'
                            onChange={(e) =>
                                setStopLossPct(Number(e.target.value) || 1)
                            }
                        />
                    </Tip>
                    <Tip
                        label='停利％'
                        short='建議設成停損的 2 倍；用來算能賺多少'
                        tip={fieldTips.takeProfit}
                    >
                        <input
                            className={styles.miniInput}
                            value={takeProfitPct}
                            step={0.1}
                            min={0.1}
                            type='number'
                            onChange={(e) =>
                                setTakeProfitPct(Number(e.target.value) || 2)
                            }
                        />
                    </Tip>
                    <Tip
                        label='最高股價（元）'
                        short='空白＝不限；填 100＝只要 100 元以下'
                        tip={fieldTips.maxPrice}
                    >
                        <input
                            className={styles.miniInputWide}
                            value={maxPrice}
                            min={0}
                            step={1}
                            type='number'
                            placeholder='不限'
                            onChange={(e) => {
                                const v = e.target.value.trim();
                                if (v === '') {
                                    setMaxPrice('');
                                    return;
                                }
                                const n = Number(v);
                                setMaxPrice(Number.isFinite(n) ? n : '');
                            }}
                        />
                    </Tip>
                </div>

                <div className={styles.row}>
                    <span className={styles.sectionTitle}>候選池（從哪裡找股票）</span>
                    <div className={styles.section}>
                        {(Object.keys(pools) as PoolKey[]).map((key) => (
                            <TipCheck
                                key={key}
                                tip={poolTips[key]}
                                checked={pools[key]}
                                onChange={(checked) =>
                                    setPools((prev) => ({
                                        ...prev,
                                        [key]: checked,
                                    }))
                                }
                            >
                                {poolLabels[key]}
                            </TipCheck>
                        ))}
                    </div>
                </div>

                <div className={styles.row}>
                    <span className={styles.sectionTitle}>
                        產業（取消勾＝該類不出現）
                    </span>
                    <div className={styles.section}>
                        {(Object.keys(industries) as IndustryKey[]).map(
                            (key) => (
                                <TipCheck
                                    key={key}
                                    tip={industryTips[key]}
                                    checked={industries[key]}
                                    onChange={(checked) =>
                                        setIndustries((prev) => ({
                                            ...prev,
                                            [key]: checked,
                                        }))
                                    }
                                >
                                    {industryLabels[key]}
                                </TipCheck>
                            ),
                        )}
                    </div>
                </div>

                <div className={styles.row}>
                    <span className={styles.sectionTitle}>
                        軟條件（命中數要 ≥ 上面的 K 門檻）
                    </span>
                    <div className={styles.section}>
                        {(Object.keys(softs) as SoftKey[]).map((key) => (
                            <TipCheck
                                key={key}
                                tip={softTips[key]}
                                checked={softs[key]}
                                onChange={(checked) =>
                                    setSofts((prev) => ({
                                        ...prev,
                                        [key]: checked,
                                    }))
                                }
                            >
                                {softLabels[key]}
                            </TipCheck>
                        ))}
                    </div>
                    <button
                        className={styles.runBtn}
                        onClick={() => void runScan()}
                    >
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

