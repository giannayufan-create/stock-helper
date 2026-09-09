// src/components/money-flow-panel.tsx — 全市場法人買超 + 融資散戶標籤

import { useCallback, useState } from 'react';
import { apiGet } from '../lib/api';
import { fmtInt } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './money-flow-panel.css';

type Mode = 'clean_buy' | 'inst_buy' | 'chase_buy' | 'inst_sell';

interface MoneyFlowItem {
    code: string;
    name: string;
    as_of?: string;
    foreign_net: number;
    trust_net: number;
    inst_net: number;
    margin_delta: number;
    retail_tag: string;
    quality: string;
    label: string;
}

interface MoneyFlowRes {
    as_of: string;
    mode: Mode;
    count: number;
    universe: number;
    note: string;
    rows: MoneyFlowItem[];
}

const MODES: Array<{ key: Mode; label: string; tip: string }> = [
    {
        key: 'clean_buy',
        label: '優先：法人買＋籌碼乾',
        tip: '法人買超且融資減少／持平，較適合布局',
    },
    {
        key: 'inst_buy',
        label: '法人買超排行',
        tip: '全市場三大法人淨買超由高到低',
    },
    {
        key: 'chase_buy',
        label: '動能：法人買＋散戶追',
        tip: '融資也在增加，短線熱但易追高',
    },
    {
        key: 'inst_sell',
        label: '法人賣超',
        tip: '主力偏出貨，參考避開',
    },
];

function fmtLots(shares: number): string {
    const lots = shares / 1000;
    const sign = lots > 0 ? '+' : '';
    if (Math.abs(lots) >= 1000) return `${sign}${(lots / 1000).toFixed(1)}千張`;
    return `${sign}${lots.toFixed(0)}張`;
}

export function MoneyFlowPanel({
    onPickCode,
}: {
    onPickCode: (code: string) => void;
}) {
    const [mode, setMode] = useState<Mode>('clean_buy');
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<MoneyFlowRes | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (m: Mode) => {
        setLoading(true);
        setError(null);
        try {
            const res = await apiGet<MoneyFlowRes>(
                `/api/v1/data/money-flow?mode=${encodeURIComponent(m)}&limit=40`,
            );
            setData(res);
        } catch (err) {
            setData(null);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, []);

    const active = MODES.find((x) => x.key === mode) ?? MODES[0]!;

    return (
        <div className={styles.wrap}>
            <div className={styles.controls}>
                <p className={styles.blurb}>
                    盤後資金流（公開籌碼，通常 T+1）。主看「法人買＋籌碼乾」；「散戶追」當動能警示，勿當唯一進場。
                </p>
                <div className={styles.tabs}>
                    {MODES.map((m) => (
                        <button
                            key={m.key}
                            type='button'
                            className={
                                mode === m.key ? styles.tabActive : styles.tab
                            }
                            onClick={() => {
                                setMode(m.key);
                                void load(m.key);
                            }}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>
                <p className={styles.blurb}>{active.tip}</p>
                <button
                    type='button'
                    className={styles.runBtn}
                    disabled={loading}
                    onClick={() => void load(mode)}
                >
                    {loading ? '載入中…' : data ? '重新整理' : '載入資金流'}
                </button>
                {data && (
                    <div className={styles.meta}>
                        <span>資料日 {data.as_of}</span>
                        <span>
                            顯示 {data.count}／宇宙 {data.universe} 檔
                        </span>
                    </div>
                )}
            </div>
            <div className={styles.body}>
                {error && <div className={styles.empty}>失敗：{error}</div>}
                {!error && !data && !loading && (
                    <div className={styles.empty}>
                        按「載入資金流」抓全市場法人排行（首次可能要幾秒）。
                    </div>
                )}
                {loading && <div className={styles.empty}>載入籌碼中…</div>}
                {data?.rows.map((row, idx) => {
                    const instUp = row.inst_net > 0;
                    return (
                        <div className={styles.card} key={row.code}>
                            <div className={styles.top}>
                                <button
                                    type='button'
                                    className={styles.titleBtn}
                                    onClick={() => {
                                        sessionStorage.setItem(
                                            'nova-screener-code',
                                            row.code,
                                        );
                                        sessionStorage.setItem(
                                            'nova-screener-mode',
                                            'overnight',
                                        );
                                        onPickCode(row.code);
                                    }}
                                >
                                    #{idx + 1} {row.code} {row.name}
                                </button>
                                <span
                                    className={
                                        instUp
                                            ? panel.dirText.up
                                            : panel.dirText.down
                                    }
                                >
                                    法人 {fmtLots(row.inst_net)}
                                </span>
                            </div>
                            <div className={styles.badges}>
                                <span
                                    className={
                                        row.quality === '優先布局'
                                            ? styles.badgeGood
                                            : row.quality === '動能留意' ||
                                                row.quality === '避開'
                                              ? styles.badgeWarn
                                              : styles.badge
                                    }
                                >
                                    {row.quality}
                                </span>
                                <span
                                    className={
                                        row.retail_tag.includes('乾') ||
                                        row.retail_tag.includes('大減')
                                            ? styles.badgeGood
                                            : row.retail_tag.includes('追') ||
                                                row.retail_tag.includes('大增')
                                              ? styles.badgeWarn
                                              : styles.badge
                                    }
                                >
                                    {row.retail_tag}
                                </span>
                                <span className={styles.badge}>{row.label}</span>
                            </div>
                            <div className={styles.line}>
                                <span>外資 {fmtLots(row.foreign_net)}</span>
                                <span>投信 {fmtLots(row.trust_net)}</span>
                                <span>
                                    融資{' '}
                                    {(row.margin_delta > 0 ? '+' : '') +
                                        fmtInt(row.margin_delta)}
                                    張
                                </span>
                            </div>
                        </div>
                    );
                })}
                {data && (
                    <p className={styles.blurb}>{data.note}</p>
                )}
            </div>
        </div>
    );
}
