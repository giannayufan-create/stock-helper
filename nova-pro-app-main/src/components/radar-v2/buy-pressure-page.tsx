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
import { BP_EVENT_LABEL, RegulatoryChip } from './stock-flags';

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
    OVERHEATED: { icon: '⚠', label: '過熱強勢' },
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
    onOpenSymbol: (symbol: string, item?: BuyPressureItemDto) => void;
}) {
    const [pricePreset, setPricePreset] = useState<PricePreset>('ALL');
    const [customMin, setCustomMin] = useState('');
    const [customMax, setCustomMax] = useState('');
    const [market, setMarket] = useState<MarketPreset>('ALL');
    const [stateFilter, setStateFilter] = useState<
        BuyPressureState | 'ALL' | 'OVERHEATED_STRONG'
    >('ALL');
    /** User opt-in only — default false so OVERHEATED stays visible. */
    const [onlyNotOverheated, setOnlyNotOverheated] = useState(false);
    const [showPricePanel, setShowPricePanel] = useState(false);
    const [showMarketPanel, setShowMarketPanel] = useState(false);
    const [sortMode, setSortMode] = useState<
        | 'strongest'
        | 'early'
        | 'rank_surge'
        | 'volume_surge'
        | 'ask_eating'
        | 'overheated_strong'
    >('strongest');
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
            overheated: onlyNotOverheated ? false : undefined,
            sort: sortMode,
            limit: 40,
        };
    }, [
        pricePreset,
        customMin,
        customMax,
        stateFilter,
        market,
        onlyNotOverheated,
        sortMode,
    ]);

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
                        {staleGlobal ? '⚠ 資料過舊' : '● 即時'}
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
                        ['PRICE', '價格'],
                        ['MARKET', '市場'],
                    ] as const
                ).map(([id, lab]) => (
                    <button
                        key={id}
                        type="button"
                        className={`${s.quickBtn} ${
                            (id === 'ALL' &&
                                pricePreset === 'ALL' &&
                                !showPricePanel &&
                                !showMarketPanel) ||
                            (id === 'LT100' && pricePreset === 'LT100') ||
                            (id === 'PRICE' && showPricePanel) ||
                            (id === 'MARKET' && showMarketPanel)
                                ? s.tabChipOn
                                : ''
                        }`}
                        onClick={() => {
                            if (id === 'ALL') {
                                setPricePreset('ALL');
                                setShowPricePanel(false);
                                setShowMarketPanel(false);
                            } else if (id === 'LT100') {
                                setPricePreset('LT100');
                                setShowPricePanel(false);
                            } else if (id === 'PRICE') {
                                setShowPricePanel((v) => !v);
                                setShowMarketPanel(false);
                            } else {
                                setShowMarketPanel((v) => !v);
                                setShowPricePanel(false);
                            }
                        }}
                    >
                        {lab}
                    </button>
                ))}
            </div>

            <div className={s.quickBar} style={{ marginBottom: 8 }}>
                {(
                    [
                        ['ALL', '全部狀態'],
                        ['EARLY', '🟡 開始轉強'],
                        ['BUY_SURGE', '🔥 買盤加速'],
                        ['ASK_EATING', '⚡ 正在吃單'],
                        ['VOLUME_BREAKOUT', '🚀 放量突破'],
                        ['OVERHEATED_STRONG', '⚠ 過熱強勢'],
                    ] as const
                ).map(([id, lab]) => (
                    <button
                        key={id}
                        type="button"
                        className={`${s.quickBtn} ${
                            stateFilter === id ? s.tabChipOn : ''
                        }`}
                        onClick={() => {
                            setStateFilter(
                                id as BuyPressureState | 'ALL' | 'OVERHEATED_STRONG',
                            );
                            if (id === 'OVERHEATED_STRONG') {
                                setSortMode('overheated_strong');
                            } else if (id === 'EARLY') {
                                setSortMode('early');
                            } else if (id === 'ASK_EATING') {
                                setSortMode('ask_eating');
                            } else if (sortMode === 'overheated_strong' || sortMode === 'early' || sortMode === 'ask_eating') {
                                setSortMode('strongest');
                            }
                        }}
                    >
                        {lab}
                    </button>
                ))}
            </div>

            <div className={s.quickBar} style={{ marginBottom: 8 }}>
                {(
                    [
                        ['strongest', '買盤最強'],
                        ['early', '剛開始轉強'],
                        ['rank_surge', 'Rank暴衝'],
                        ['volume_surge', '量能暴增'],
                        ['ask_eating', '正在吃單'],
                        ['overheated_strong', '過熱強勢'],
                    ] as const
                ).map(([id, lab]) => (
                    <button
                        key={id}
                        type="button"
                        className={`${s.quickBtn} ${
                            sortMode === id ? s.tabChipOn : ''
                        }`}
                        onClick={() => {
                            setSortMode(id);
                            if (id === 'overheated_strong') {
                                setStateFilter('OVERHEATED_STRONG');
                            } else if (id === 'early') {
                                setStateFilter('EARLY');
                            } else if (id === 'ask_eating') {
                                setStateFilter('ASK_EATING');
                            }
                        }}
                    >
                        {lab}
                    </button>
                ))}
            </div>

            <div className={s.quickBar} style={{ marginBottom: 10 }}>
                <button
                    type="button"
                    className={`${s.quickBtn} ${
                        onlyNotOverheated ? s.tabChipOn : ''
                    }`}
                    onClick={() => setOnlyNotOverheated((v) => !v)}
                >
                    僅未過熱
                </button>
            </div>

            {(showPricePanel || showMarketPanel) && (
                <div
                    className={s.glass}
                    style={{ padding: 12, marginBottom: 12 }}
                >
                    {showPricePanel && (
                        <>
                            <div
                                style={{
                                    fontSize: 13,
                                    fontWeight: 700,
                                    marginBottom: 8,
                                }}
                            >
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
                                        onChange={(e) =>
                                            setCustomMin(e.target.value)
                                        }
                                        inputMode="decimal"
                                    />
                                    <input
                                        style={inputStyle}
                                        placeholder="max"
                                        value={customMax}
                                        onChange={(e) =>
                                            setCustomMax(e.target.value)
                                        }
                                        inputMode="decimal"
                                    />
                                </div>
                            )}
                        </>
                    )}
                    {showMarketPanel && (
                        <>
                            <div
                                style={{
                                    fontSize: 13,
                                    fontWeight: 700,
                                    marginBottom: 8,
                                }}
                            >
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
                        </>
                    )}
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
                    更新時間{' '}
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
                            <strong
                                style={{
                                    display: 'inline-flex',
                                    gap: 6,
                                    alignItems: 'center',
                                    flexWrap: 'wrap',
                                }}
                            >
                                {it.symbol} {it.name}
                                <RegulatoryChip symbol={it.symbol} />
                            </strong>
                            {it.data_stale && (
                                <span style={{ color: '#fcd34d', fontSize: 12 }}>
                                    ⚠ 資料過舊
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
                            {it.overheated &&
                                it.primary_state !== 'OVERHEATED' && (
                                    <span
                                        style={{
                                            marginLeft: 8,
                                            color: '#fcd34d',
                                        }}
                                    >
                                        ⚠ 過熱
                                    </span>
                                )}
                        </div>
                        {(it.overheated || it.overheated_note) && (
                            <div
                                style={{
                                    marginTop: 6,
                                    fontSize: 13,
                                    color: vars.color.mutedForeground,
                                }}
                            >
                                {it.overheated_note ??
                                    '買盤強，但短線延伸較大'}
                            </div>
                        )}
                        <div
                            className={s.metricGrid}
                            style={{ marginTop: 10, fontSize: 13 }}
                        >
                            <div>
                                <span className={s.metricLab}>買盤</span>
                                {Math.round(it.buy_pressure_score)}
                            </div>
                            <div>
                                <span className={s.metricLab}>排序分</span>
                                {Math.round(it.radar_rank_score)}
                            </div>
                            <div>
                                <span className={s.metricLab}>盤中</span>
                                {it.c_score != null
                                    ? Math.round(it.c_score)
                                    : '—'}
                            </div>
                            <div>
                                <span className={s.metricLab}>熱度</span>
                                {it.heat_score != null
                                    ? Math.round(it.heat_score)
                                    : '—'}
                            </div>
                            <div>
                                <span className={s.metricLab}>追價風險</span>
                                {it.chase_risk ?? '—'}
                                {it.chase_penalty > 0
                                    ? ` −${it.chase_penalty}`
                                    : ''}
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
    onOpenSymbol: (symbol: string, item?: BuyPressureItemDto) => void;
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
                <div
                    style={{
                        fontWeight: 700,
                        marginBottom: 8,
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                    }}
                >
                    {meta.icon} {meta.label}
                    <RegulatoryChip symbol={item.symbol} />
                </div>
                <div className={s.metricGrid} style={{ fontSize: 14 }}>
                    <div>
                        <span className={s.metricLab}>買盤</span>
                        {Math.round(item.buy_pressure_score)}
                    </div>
                    <div>
                        <span className={s.metricLab}>排序分</span>
                        {item.c_score != null ? Math.round(item.c_score) : '—'}
                    </div>
                    <div>
                        <span className={s.metricLab}>熱度</span>
                        {item.heat_score != null
                            ? Math.round(item.heat_score)
                            : '—'}
                    </div>
                    <div>
                        <span className={s.metricLab}>量能加速</span>
                        {fmtNum(item.volume_acceleration, 0)}
                    </div>
                    <div>
                        <span className={s.metricLab}>相對量</span>
                        {item.rvol != null ? `${fmtNum(item.rvol)}x` : '—'}
                    </div>
                    <div>
                        <span className={s.metricLab}>主動買</span>
                        {fmtNum(item.trade_aggression, 0)}
                    </div>
                    <div>
                        <span className={s.metricLab}>委買委賣</span>
                        {fmtNum(item.bidask_imbalance, 2)}
                    </div>
                    <div>
                        <span className={s.metricLab}>均價</span>
                        {item.vwap_bucket ?? '—'}{' '}
                        {item.distance_from_vwap_pct != null
                            ? fmtPct(item.distance_from_vwap_pct)
                            : ''}
                    </div>
                    <div>
                        <span className={s.metricLab}>排名變化</span>
                        {fmtNum(item.rank_velocity, 0)}
                    </div>
                    <div>
                        <span className={s.metricLab}>動能加速</span>
                        {fmtNum(item.momentum_acceleration, 0)}
                    </div>
                    <div>
                        <span className={s.metricLab}>追價風險</span>
                        {item.chase_risk ?? '—'}
                        {item.chase_penalty > 0
                            ? ` −${item.chase_penalty}`
                            : ''}
                    </div>
                </div>
                {item.overheated && (
                    <div
                        style={{
                            marginTop: 10,
                            fontSize: 13,
                            color: '#fcd34d',
                        }}
                    >
                        ⚠ 過熱 ·{' '}
                        {item.overheated_note ?? '買盤強，但短線延伸較大'}
                    </div>
                )}
                {item.data_stale && (
                    <div style={{ marginTop: 10, color: '#fcd34d', fontSize: 13 }}>
                        ⚠ 資料過舊 · 更新於{' '}
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
                                    {BP_EVENT_LABEL[ev.event_type] ??
                                        ev.event_type}
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
                onClick={() => onOpenSymbol(item.symbol, item)}
            >
                開啟個股詳情
            </button>
        </>
    );
}
