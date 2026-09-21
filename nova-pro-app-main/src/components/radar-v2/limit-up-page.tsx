// src/components/radar-v2/limit-up-page.tsx — 今日漲停板（獨立資料源）

import { useEffect, useRef, useState } from 'react';
import {
    fetchLimitUpBoard,
    type LimitUpBoardItem,
} from '../../lib/limit-up-board';
import { vars } from '../../theme.css';
import * as s from './radar.css';
import { radarColor } from './tokens';

function fmtPct(n: number) {
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)}%`;
}

function fmtPrice(n: number | null) {
    if (n == null || !Number.isFinite(n)) return '—';
    return n >= 100 ? n.toFixed(1) : n.toFixed(2);
}

function fmtLots(n: number | null) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (n >= 10_000) return `${(n / 10_000).toFixed(1)}萬張`;
    return `${Math.round(n)}張`;
}

const SOURCE_LABEL: Record<string, string> = {
    scanner: '即時漲幅排行',
    tw_openapi: '證交所／櫃買日線',
    finmind: 'FinMind 日線',
};

export function LimitUpPage({
    onOpenSymbol,
}: {
    onOpenSymbol: (symbol: string) => void;
}) {
    const [items, setItems] = useState<LimitUpBoardItem[]>([]);
    const [asOf, setAsOf] = useState<string | null>(null);
    const [source, setSource] = useState<string | null>(null);
    const [mode, setMode] = useState<string | null>(null);
    const [warnings, setWarnings] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState<string | null>(null);
    const gotData = useRef(false);

    useEffect(() => {
        let cancelled = false;
        const load = () => {
            void fetchLimitUpBoard({ count: 80, timeoutMs: 18_000 })
                .then((dto) => {
                    if (cancelled) return;
                    gotData.current = true;
                    setItems(dto.items);
                    setAsOf(dto.as_of);
                    setSource(dto.source);
                    setMode(dto.mode);
                    setWarnings(dto.warnings ?? []);
                    setErr(null);
                })
                .catch(() => {
                    if (!cancelled && !gotData.current) {
                        setErr('漲停板暫時無法載入');
                    }
                })
                .finally(() => {
                    if (!cancelled) setLoading(false);
                });
        };
        load();
        const t = setInterval(load, 12_000);
        const onVis = () => {
            if (!document.hidden) load();
        };
        document.addEventListener('visibilitychange', onVis);
        return () => {
            cancelled = true;
            clearInterval(t);
            document.removeEventListener('visibilitychange', onVis);
        };
    }, []);

    return (
        <div style={{ paddingTop: 0 }}>
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    gap: 8,
                    marginBottom: 10,
                }}
            >
                <div>
                    <div
                        style={{
                            fontSize: 18,
                            fontWeight: 700,
                            letterSpacing: '-0.02em',
                        }}
                    >
                        今日漲停板
                    </div>
                    <div
                        style={{
                            marginTop: 4,
                            fontSize: 12,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        {loading && !gotData.current
                            ? '載入中…'
                            : `${items.length} 檔 · ${SOURCE_LABEL[source ?? ''] ?? source ?? '—'} · ${mode === 'live' ? '即時' : '日線'}`}
                        {asOf
                            ? ` · ${new Date(asOf).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                            : ''}
                    </div>
                </div>
            </div>

            {err && (
                <div className={`${s.banner} ${s.bannerBad}`} style={{ margin: '0 0 10px' }}>
                    {err}
                </div>
            )}
            {warnings.length > 0 && !err && (
                <div className={s.banner} style={{ margin: '0 0 10px' }}>
                    {warnings[0]}
                </div>
            )}

            {loading && !items.length ? (
                <div
                    style={{
                        padding: '24px 0',
                        color: vars.color.mutedForeground,
                        fontSize: 14,
                    }}
                >
                    正在抓取今日漲停…
                </div>
            ) : items.length === 0 ? (
                <div
                    style={{
                        padding: '24px 0',
                        color: vars.color.mutedForeground,
                        fontSize: 14,
                    }}
                >
                    目前沒有達到漲停門檻的標的（≥9.5%）
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {items.map((it, idx) => (
                        <button
                            key={it.symbol}
                            type="button"
                            className={s.glass}
                            onClick={() => onOpenSymbol(it.symbol)}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 12,
                                width: '100%',
                                padding: '12px 14px',
                                textAlign: 'left',
                                color: 'inherit',
                                cursor: 'pointer',
                            }}
                        >
                            <div
                                style={{
                                    width: 28,
                                    fontVariantNumeric: 'tabular-nums',
                                    fontSize: 13,
                                    color: vars.color.mutedForeground,
                                    flexShrink: 0,
                                }}
                            >
                                {idx + 1}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                    style={{
                                        display: 'flex',
                                        alignItems: 'baseline',
                                        gap: 8,
                                    }}
                                >
                                    <span
                                        style={{
                                            fontWeight: 700,
                                            fontSize: 16,
                                            letterSpacing: '-0.02em',
                                        }}
                                    >
                                        {it.name}
                                    </span>
                                    <span
                                        style={{
                                            fontSize: 12,
                                            color: vars.color.mutedForeground,
                                            fontVariantNumeric: 'tabular-nums',
                                        }}
                                    >
                                        {it.symbol}
                                        {it.market
                                            ? ` · ${it.market === 'tse' ? '上市' : '上櫃'}`
                                            : ''}
                                    </span>
                                </div>
                                <div
                                    style={{
                                        marginTop: 4,
                                        fontSize: 12,
                                        color: vars.color.mutedForeground,
                                    }}
                                >
                                    量 {fmtLots(it.volume)} · 價 {fmtPrice(it.last_price)}
                                </div>
                            </div>
                            <div
                                style={{
                                    textAlign: 'right',
                                    flexShrink: 0,
                                    color: radarColor.strong,
                                    fontWeight: 700,
                                    fontVariantNumeric: 'tabular-nums',
                                }}
                            >
                                <div style={{ fontSize: 16 }}>{fmtPct(it.change_pct)}</div>
                                <div
                                    style={{
                                        fontSize: 12,
                                        fontWeight: 600,
                                        opacity: 0.85,
                                    }}
                                >
                                    {fmtPrice(it.last_price)}
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
