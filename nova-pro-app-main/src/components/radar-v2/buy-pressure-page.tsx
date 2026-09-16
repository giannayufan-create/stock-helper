// src/components/radar-v2/buy-pressure-page.tsx — 即時買盤雷達 v1 (context only)

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
    fetchBuyPressure,
    type BuyPressureItemDto,
    type BuyPressureState,
} from '../../lib/buy-pressure';
import { vars } from '../../theme.css';
import * as s from './radar.css';
import { radarColor } from './tokens';

type PricePreset =
    | 'ALL'
    | 'LT50'
    | 'LT100'
    | 'LT200'
    | '200_500'
    | 'GT500'
    | 'CUSTOM';

type MarketPreset = 'ALL' | 'TSE' | 'OTC' | 'ESM';

const inputStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    padding: '10px 12px',
    borderRadius: 12,
    border: `1px solid ${radarColor.glassBorder}`,
    background: 'rgba(0,0,0,0.25)',
    color: vars.color.foreground,
    fontSize: 14,
};

const STATE_META: Record<
    BuyPressureState,
    { icon: string; label: string }
> = {
    EARLY: { icon: '🟡', label: '開始轉強' },
    BUY_SURGE: { icon: '🔥', label: '買盤加速' },
    ASK_EATING: { icon: '⚡', label: '正在吃賣單' },
    VOLUME_BREAKOUT: { icon: '🚀', label: '放量突破' },
    LARGE_BID: { icon: '💰', label: '大額委買出現' },
    OVERHEATED: { icon: '⚠', label: '偏熱' },
    COOLING: { icon: '❄', label: '買盤降溫' },
};

function priceBounds(preset: PricePreset, customMin: string, customMax: string) {
    switch (preset) {
        case 'ALL':
            return {};
        case 'LT50':
            return { max_price: 50 };
        case 'LT100':
            return { max_price: 100 };
        case 'LT200':
            return { max_price: 200 };
        case '200_500':
            return { min_price: 200, max_price: 500 };
        case 'GT500':
            return { min_price: 500 };
        case 'CUSTOM': {
            const min = customMin.trim() ? Number(customMin) : undefined;
            const max = customMax.trim() ? Number(customMax) : undefined;
            return {
                min_price: Number.isFinite(min) ? min : undefined,
                max_price: Number.isFinite(max) ? max : undefined,
            };
        }
    }
}

function fmtPct(n: number | null | undefined) {
    if (n == null || !Number.isFinite(n)) return '—';
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)}%`;
}

function fmtNum(n: number | null | undefined, d = 1) {
    if (n == null || !Number.isFinite(n)) return '—';
    return n.toFixed(d);
}

export function BuyPressurePage({
    onBack,
    onOpenSymbol,
}: {
    onBack?: () => void;
    onOpenSymbol: (symbol: string) => void;
}) {
    const [pricePreset, setPricePreset] = useState<PricePreset>('ALL');
    const [customMin, setCustomMin] = useState('');
    const [customMax, setCustomMax] = useState('');
    const [market, setMarket] = useState<MarketPreset>('ALL');
    const [stateFilter, setStateFilter] = useState<BuyPressureState | 'ALL'>(
        'ALL',
    );
    const [notOverheated, setNotOverheated] = useState(false);
    const [showFilters, setShowFilters] = useState(false);
    const [items, setItems] = useState<BuyPressureItemDto[]>([]);
    const [asOf, setAsOf] = useState<string | null>(null);
    const [staleGlobal, setStaleGlobal] = useState(false);
    const [loading, setLoading] = useState(true);
    const [detail, setDetail] = useState<BuyPressureItemDto | null>(null);
    const [err, setErr] = useState<string | null>(null);

    const query = useMemo(() => {
        const bounds = priceBounds(pricePreset, customMin, customMax);
        return {
            ...bounds,
            state: stateFilter,
            market,
            overheated: notOverheated ? false : undefined,
            limit: 40,
        };
    }, [pricePreset, customMin, customMax, stateFilter, market, notOverheated]);

    useEffect(() => {
        let cancelled = false;
        const load = () => {
            void fetchBuyPressure(query)
                .then((batch) => {
                    if (cancelled) return;
                    setItems(batch.items);
                    setAsOf(batch.as_of);
                    setStaleGlobal(batch.data_stale_global);
                    setErr(null);
                })
                .catch(() => {
                    if (!cancelled) setErr('買盤雷達暫時無法載入');
                })
                .finally(() => {
                    if (!cancelled) setLoading(false);
                });
        };
        load();
        const t = setInterval(load, 2500);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, [query]);

    if (detail) {
        return (
            <DetailView
                item={detail}
                onBack={() => setDetail(null)}
                onOpenSymbol={onOpenSymbol}
            />
        );
    }

    return (
        <>
            <div className={s.sectionRow}>
                <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                    🔥 即時買盤雷達
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span
                        style={{
                            fontSize: 12,
                            fontWeight: 700,
                            color: staleGlobal
                                ? '#fcd34d'
                                : radarColor.live,
                        }}
                    >
                        {staleGlobal ? '⚠ DATA STALE' : '● LIVE'}
                    </span>
                    {onBack && (
                        <button
                            type="button"
                            className={s.linkBtn}
                            onClick={onBack}
                        >
                            ← 返回
                        </button>
                    )}
                </div>
            </div>

            <div className={s.quickBar} style={{ marginBottom: 8 }}>
                {(
                    [
                        ['ALL', '全部'],
                        ['LT100', '<100'],
                        ['NOT_HOT', '未過熱'],
                        ['FILTER', '篩選'],
                    ] as const
                ).map(([id, lab]) => (
                    <button
                        key={id}
                        type="button"
                        className={`${s.quickBtn} ${
                            (id === 'ALL' &&
                                pricePreset === 'ALL' &&
                                !notOverheated &&
                                !showFilters) ||
                            (id === 'LT100' && pricePreset === 'LT100') ||
                            (id === 'NOT_HOT' && notOverheated) ||
                            (id === 'FILTER' && showFilters)
                                ? s.tabChipOn
                                : ''
                        }`}
                        onClick={() => {
                            if (id === 'ALL') {
                                setPricePreset('ALL');
                                setNotOverheated(false);
                                setShowFilters(false);
                            } else if (id === 'LT100') {
                                setPricePreset('LT100');
                            } else if (id === 'NOT_HOT') {
                                setNotOverheated((v) => !v);
                            } else {
                                setShowFilters((v) => !v);
                            }
                        }}
                    >
                        {lab}
                    </button>
                ))}
            </div>

            <div className={s.quickBar} style={{ marginBottom: 10 }}>
                {(
                    [
                        ['ALL', '全部'],
                        ['EARLY', '🟡 開始轉強'],
                        ['BUY_SURGE', '🔥 買盤加速'],
                        ['ASK_EATING', '⚡ 正在吃單'],
                        ['VOLUME_BREAKOUT', '🚀 放量突破'],
                    ] as const
                ).map(([id, lab]) => (
                    <button
                        key={id}
                        type="button"
                        className={`${s.quickBtn} ${
                            stateFilter === id ? s.tabChipOn : ''
                        }`}
                        onClick={() =>
                            setStateFilter(id as BuyPressureState | 'ALL')
                        }
                    >
                        {lab}
                    </button>
                ))}
            </div>

            {showFilters && (
                <div
                    className={s.glass}
                    style={{ padding: 12, marginBottom: 12 }}
                >
                    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
                        價格
                    </div>
                    <div className={s.quickBar} style={{ marginBottom: 8 }}>
                        {(
                            [
                                ['ALL', '全部'],
                                ['LT50', '<50'],
                                ['LT100', '<100'],
                                ['LT200', '<200'],
                                ['200_500', '200～500'],
                                ['GT500', '>500'],
                                ['CUSTOM', '自訂'],
                            ] as const
                        ).map(([id, lab]) => (
                            <button
                                key={id}
                                type="button"
                                className={`${s.quickBtn} ${
                                    pricePreset === id ? s.tabChipOn : ''
                                }`}
                                onClick={() => setPricePreset(id)}
                            >
                                {lab}
                            </button>
                        ))}
                    </div>
                    {pricePreset === 'CUSTOM' && (
                        <div
                            style={{
                                display: 'flex',
                                gap: 8,
                                marginBottom: 10,
                            }}
                        >
                            <input
                                style={inputStyle}
                                placeholder="min"
                                value={customMin}
                                onChange={(e) => setCustomMin(e.target.value)}
                                inputMode="decimal"
                            />
                            <input
                                style={inputStyle}
                                placeholder="max"
                                value={customMax}
                                onChange={(e) => setCustomMax(e.target.value)}
                                inputMode="decimal"
                            />
                        </div>
                    )}
                    <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
                        市場
                    </div>
                    <div className={s.quickBar}>
                        {(
                            [
                                ['ALL', '全部市場'],
                                ['TSE', '上市'],
                                ['OTC', '上櫃'],
                                ['ESM', '興櫃｜尚未啟用'],
                            ] as const
                        ).map(([id, lab]) => (
                            <button
                                key={id}
                                type="button"
                                className={`${s.quickBtn} ${
                                    market === id ? s.tabChipOn : ''
                                }`}
                                disabled={id === 'ESM'}
                                onClick={() => setMarket(id)}
                            >
                                {lab}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {asOf && (
                <div
                    style={{
                        fontSize: 12,
                        color: vars.color.mutedForeground,
                        marginBottom: 8,
                    }}
                >
                    Last Updated{' '}
                    {new Date(asOf).toLocaleTimeString('zh-TW', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false,
                    })}
                    {pricePreset === 'ALL' ? ' · 價格篩選：全部' : ''}
                </div>
            )}

            {loading && <div className={s.empty}>載入中…</div>}
            {err && (
                <div className={s.empty} style={{ color: '#fca5a5' }}>
                    {err}
                </div>
            )}
            {!loading && !err && items.length === 0 && (
                <div className={s.empty}>目前沒有符合條件的買盤訊號</div>
            )}

            {items.map((it) => {
                const meta = STATE_META[it.primary_state];
                return (
                    <button
                        key={it.symbol}
                        type="button"
                        className={s.stockCard}
                        style={{
                            opacity: it.data_stale ? 0.55 : 1,
                            marginBottom: 10,
                            textAlign: 'left',
                            width: '100%',
                        }}
                        onClick={() => setDetail(it)}
                    >
                        <div
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                gap: 8,
                            }}
                        >
                            <strong>
                                {it.symbol} {it.name}
                            </strong>
                            {it.data_stale && (
                                <span style={{ color: '#fcd34d', fontSize: 12 }}>
                                    ⚠ STALE
                                </span>
                            )}
                        </div>
                        <div
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                marginTop: 4,
                                fontFamily: vars.font.mono,
                            }}
                        >
                            <span>{fmtNum(it.last_price, 2)}</span>
                            <span
                                style={{
                                    color:
                                        (it.change_pct ?? 0) >= 0
                                            ? vars.color.up
                                            : vars.color.down,
                                }}
                            >
                                {fmtPct(it.change_pct)}
                            </span>
                        </div>
                        <div
                            style={{
                                marginTop: 8,
                                fontWeight: 700,
                                color: radarColor.aiSoft,
                            }}
                        >
                            {meta.icon} {meta.label}
                        </div>
                        <div
                            className={s.metricGrid}
                            style={{ marginTop: 10, fontSize: 13 }}
                        >
                            <div>
                                <span className={s.metricLab}>Buy Pressure</span>
                                {Math.round(it.buy_pressure_score)}
                            </div>
                            <div>
                                <span className={s.metricLab}>C Score</span>
                                {it.c_score != null
                                    ? Math.round(it.c_score)
                                    : '—'}
                            </div>
                            <div>
                                <span className={s.metricLab}>Heat</span>
                                {it.heat_score != null
                                    ? Math.round(it.heat_score)
                                    : '—'}
                            </div>
                            <div>
                                <span className={s.metricLab}>3分量</span>
                                {it.volume_acceleration != null
                                    ? `${it.volume_acceleration > 0 ? '+' : ''}${Math.round(it.volume_acceleration)}%`
                                    : '—'}
                            </div>
                            <div>
                                <span className={s.metricLab}>RVOL</span>
                                {it.rvol != null ? `${fmtNum(it.rvol)}x` : '—'}
                            </div>
                            <div>
                                <span className={s.metricLab}>Rank</span>
                                {it.rank_prev != null && it.rank != null
                                    ? `${it.rank_prev} → ${it.rank}`
                                    : it.rank ?? '—'}
                            </div>
                            <div>
                                <span className={s.metricLab}>VWAP</span>
                                {it.distance_from_vwap_pct != null
                                    ? fmtPct(it.distance_from_vwap_pct)
                                    : it.vwap_bucket ?? '—'}
                            </div>
                        </div>
                        {it.ask_eating_note && (
                            <div
                                style={{
                                    marginTop: 8,
                                    fontSize: 13,
                                    color: '#fcd34d',
                                }}
                            >
                                ⚡ {it.ask_eating_note}
                            </div>
                        )}
                        <div
                            style={{
                                marginTop: 10,
                                fontSize: 13,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            查看詳情 ›
                        </div>
                    </button>
                );
            })}
        </>
    );
}

function DetailView({
    item,
    onBack,
    onOpenSymbol,
}: {
    item: BuyPressureItemDto;
    onBack: () => void;
    onOpenSymbol: (symbol: string) => void;
}) {
    const meta = STATE_META[item.primary_state];
    return (
        <>
            <div className={s.sectionRow}>
                <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                    {item.symbol} {item.name}
                </div>
                <button type="button" className={s.linkBtn} onClick={onBack}>
                    ← 返回列表
                </button>
            </div>
            <div
                className={s.glass}
                style={{
                    padding: 14,
                    marginBottom: 12,
                    opacity: item.data_stale ? 0.55 : 1,
                }}
            >
                <div style={{ fontWeight: 700, marginBottom: 8 }}>
                    {meta.icon} {meta.label}
                </div>
                <div className={s.metricGrid} style={{ fontSize: 14 }}>
                    <div>
                        <span className={s.metricLab}>Buy Pressure</span>
                        {Math.round(item.buy_pressure_score)}
                    </div>
                    <div>
                        <span className={s.metricLab}>C Score</span>
                        {item.c_score != null ? Math.round(item.c_score) : '—'}
                    </div>
                    <div>
                        <span className={s.metricLab}>Heat</span>
                        {item.heat_score != null
                            ? Math.round(item.heat_score)
                            : '—'}
                    </div>
                    <div>
                        <span className={s.metricLab}>Volume Accel</span>
                        {fmtNum(item.volume_acceleration, 0)}
                    </div>
                    <div>
                        <span className={s.metricLab}>RVOL</span>
                        {item.rvol != null ? `${fmtNum(item.rvol)}x` : '—'}
                    </div>
                    <div>
                        <span className={s.metricLab}>Aggression</span>
                        {fmtNum(item.trade_aggression, 0)}
                    </div>
                    <div>
                        <span className={s.metricLab}>BidAsk Imb</span>
                        {fmtNum(item.bidask_imbalance, 2)}
                    </div>
                    <div>
                        <span className={s.metricLab}>VWAP</span>
                        {item.vwap_bucket ?? '—'}{' '}
                        {item.distance_from_vwap_pct != null
                            ? fmtPct(item.distance_from_vwap_pct)
                            : ''}
                    </div>
                    <div>
                        <span className={s.metricLab}>Rank Vel</span>
                        {fmtNum(item.rank_velocity, 0)}
                    </div>
                    <div>
                        <span className={s.metricLab}>Momentum Accel</span>
                        {fmtNum(item.momentum_acceleration, 0)}
                    </div>
                </div>
                {item.data_stale && (
                    <div style={{ marginTop: 10, color: '#fcd34d', fontSize: 13 }}>
                        ⚠ DATA STALE · Last Updated{' '}
                        {new Date(item.last_updated).toLocaleTimeString('zh-TW', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                            hour12: false,
                        })}
                    </div>
                )}
            </div>

            <div className={s.sectionTitle}>最近事件</div>
            <div className={s.glass} style={{ padding: 14, marginBottom: 12 }}>
                {item.events.length === 0 ? (
                    <div className={s.empty} style={{ padding: 8 }}>
                        尚無事件
                    </div>
                ) : (
                    [...item.events]
                        .reverse()
                        .slice(0, 12)
                        .map((ev) => (
                            <div key={ev.timestamp + ev.event_type} className={s.eventRow}>
                                <div style={{ fontWeight: 700 }}>
                                    {new Date(ev.timestamp).toLocaleTimeString(
                                        'zh-TW',
                                        {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                            hour12: false,
                                        },
                                    )}{' '}
                                    {ev.event_type}
                                </div>
                                {ev.note && (
                                    <div
                                        style={{
                                            fontSize: 12,
                                            color: vars.color.mutedForeground,
                                        }}
                                    >
                                        {ev.note}
                                    </div>
                                )}
                            </div>
                        ))
                )}
            </div>

            <button
                type="button"
                className={s.btnPrimary}
                style={{ width: '100%' }}
                onClick={() => onOpenSymbol(item.symbol)}
            >
                開啟個股詳情
            </button>
        </>
    );
}
