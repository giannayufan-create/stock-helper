import { useEffect, useState } from 'react';
import {
    fetchMarketContextOverview,
    ROTATION_LABEL,
    TW_REGIME_LABEL,
    type MarketContextOverviewDto,
} from '../../lib/market-context';
import {
    CONFIRM_LABEL,
    EVENT_TYPE_LABEL,
    fetchActiveEvents,
    fetchEventDetail,
    type EventConfirmationDto,
    type EventImpactDto,
    type MarketEventDto,
} from '../../lib/events';
import {
    ACTION_TYPE_LABEL,
    EXPIRY_PHASE_LABEL,
    fetchCalendarToday,
    type CalendarTodayDto,
    type CorporateActionDto,
} from '../../lib/calendar';
import { displayIndustryName } from '../../lib/industry-names';
import { vars } from '../../theme.css';
import { ConfirmLayersRow } from './confirm-layers';
import { FreshnessBadge } from './freshness-badge';
import {
    fmtPctSigned,
    looksLikeBoardMover,
    liveStatusLabel,
    regimeMeta,
    sortHeating,
    sortPullback,
} from './helpers';
import * as s from './radar.css';
import { MiniHeatCard, MiniPullbackCard } from './stock-cards';
import { TodayDecisionBoard } from './today-decision-board';
import { radarColor } from './tokens';
import { SECTOR_STATE_LABEL } from './ui-context';
import type { RadarFeed } from './use-radar-feed';

function dirArrow(d: string) {
    if (d === 'UP') return '↑';
    if (d === 'DOWN') return '↓';
    return '→';
}

function mdLabel(ymd: string) {
    return ymd.slice(5).replace('-', '/');
}

function monthZh(ym: string | undefined, fallback: string) {
    if (!ym || ym.length < 7) return fallback;
    const n = Number(ym.slice(5, 7));
    return Number.isFinite(n) ? `${n}月` : fallback;
}

function CorporateActionRows({
    items,
    onOpenSymbol,
}: {
    items: CorporateActionDto[];
    onOpenSymbol: (symbol: string) => void;
}) {
    if (!items.length) {
        return (
            <div
                style={{
                    fontSize: 13,
                    color: vars.color.mutedForeground,
                    padding: '6px 0',
                }}
            >
                此區間暫無除權息
            </div>
        );
    }
    return (
        <>
            {items.map((a) => (
                <div
                    key={`${a.symbol}-${a.action_date}`}
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 8,
                        padding: '6px 0',
                        minHeight: 40,
                        alignItems: 'center',
                    }}
                >
                    <button
                        type="button"
                        style={{
                            background: 'none',
                            border: 'none',
                            color: 'inherit',
                            font: 'inherit',
                            textAlign: 'left',
                            padding: 0,
                            cursor: 'pointer',
                            minWidth: 0,
                        }}
                        onClick={() => onOpenSymbol(a.symbol)}
                    >
                        <span
                            style={{
                                color: vars.color.mutedForeground,
                                marginRight: 8,
                                fontFamily: vars.font.mono,
                                fontSize: 12,
                            }}
                        >
                            {mdLabel(a.action_date)}
                        </span>
                        {a.symbol} {a.name}
                    </button>
                    <span
                        style={{
                            color: vars.color.mutedForeground,
                            fontSize: 12,
                            flexShrink: 0,
                        }}
                    >
                        {ACTION_TYPE_LABEL[a.action_type] ?? a.action_type}
                    </span>
                </div>
            ))}
        </>
    );
}

export function TodayPage({
    feed,
    selectedSymbol,
    onOpenSymbol,
    onGoRadar,
    onGoWatch,
    onSearch,
    onGoIntel,
}: {
    feed: RadarFeed;
    selectedSymbol?: string | null;
    onOpenSymbol: (symbol: string) => void;
    onGoRadar: (tab?: string) => void;
    onGoWatch: () => void;
    onSearch?: () => void;
    onGoIntel?: () => void;
}) {
    const regime = regimeMeta(feed.marketRegime, feed.marketScore);
    const heating = sortHeating(feed.items)
        .filter(
            (i) =>
                (i.state === 'HEATING' ||
                    i.state === 'EMERGING' ||
                    (i.heat_score ?? 0) >= 65) &&
                looksLikeBoardMover({
                    changePct: i.adjusted_change_pct ?? i.change_pct,
                    heat: i.heat_score,
                    state: i.state,
                }),
        )
        .slice(0, 8);
    const pullbacks = sortPullback(feed.items).slice(0, 6);

    const [mc, setMc] = useState<MarketContextOverviewDto | null>(null);
    const [mcStatus, setMcStatus] = useState<'loading' | 'ready' | 'error'>(
        'loading',
    );
    const [cal, setCal] = useState<CalendarTodayDto | null>(null);
    const [events, setEvents] = useState<MarketEventDto[]>([]);
    const [eventExtra, setEventExtra] = useState<
        Record<
            string,
            { confirmation: EventConfirmationDto | null; impact: EventImpactDto | null }
        >
    >({});

    useEffect(() => {
        let cancelled = false;
        const load = () =>
            void fetchMarketContextOverview()
                .then((ov) => {
                    if (cancelled) return;
                    setMc(ov);
                    setMcStatus('ready');
                })
                .catch(() => {
                    if (!cancelled) setMcStatus((prev) => (prev === 'ready' ? prev : 'error'));
                });
        load();
        const t = setInterval(load, 60_000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        const load = () =>
            void fetchCalendarToday()
                .then((ov) => {
                    if (!cancelled) setCal(ov);
                })
                .catch(() => undefined);
        load();
        const t = setInterval(load, 5 * 60_000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const res = await fetchActiveEvents();
                if (cancelled) return;
                const topEv = (res.items ?? []).slice(0, 4);
                setEvents(topEv);
                const extras: typeof eventExtra = {};
                await Promise.all(
                    topEv.map(async (ev) => {
                        try {
                            const d = await fetchEventDetail(ev.event_id);
                            extras[ev.event_id] = {
                                confirmation: d.confirmation ?? null,
                                impact: d.impact ?? null,
                            };
                        } catch {
                            extras[ev.event_id] = {
                                confirmation: null,
                                impact: null,
                            };
                        }
                    }),
                );
                if (!cancelled) setEventExtra(extras);
            } catch {
                /* soft */
            }
        };
        void load();
        const t = setInterval(() => void load(), 60_000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

    const tw = mc?.taiwan_regime;

    return (
        <>
            {/* 0 One merged answer — read this first */}
            <TodayDecisionBoard onOpenSymbol={onOpenSymbol} />

            {/* 1 Market Status / Data Health */}
            <div className={s.healthStrip}>
                <div>
                    <div style={{ fontSize: 12, color: vars.color.mutedForeground }}>
                        盤中狀態
                    </div>
                    <div
                        style={{
                            fontWeight: 800,
                            fontSize: 15,
                            color:
                                feed.liveStatus === 'LIVE'
                                    ? radarColor.live
                                    : feed.liveStatus === 'WAKING' ||
                                        feed.liveStatus === 'DATA STALE'
                                      ? radarColor.healthWarn
                                      : radarColor.healthBad,
                        }}
                    >
                        {liveStatusLabel(feed.liveStatus)}
                    </div>
                </div>
                <FreshnessBadge
                    level={
                        feed.liveStatus === 'LIVE'
                            ? 'REALTIME'
                            : feed.liveStatus === 'WAKING'
                              ? 'STALE'
                              : feed.liveStatus === 'DATA STALE'
                                ? 'STALE'
                                : 'DELAYED'
                    }
                />
            </div>
            {feed.healthNote ? (
                <div className={s.banner} style={{ marginBottom: 12 }}>
                    {feed.healthNote}
                    {(feed.liveStatus === 'DISCONNECTED' ||
                        feed.liveStatus === 'WAKING') && (
                        <button
                            type="button"
                            className={s.quickBtn}
                            style={{
                                marginTop: 10,
                                width: '100%',
                                minHeight: 44,
                            }}
                            onClick={() => feed.refresh()}
                        >
                            {feed.liveStatus === 'WAKING'
                                ? '重新整理'
                                : '重新連線'}
                        </button>
                    )}
                </div>
            ) : null}

            {/* 2 Taiwan Market Regime / 市場風向 */}
            <div className={s.zoneBlock}>
                <div className={s.sectionRow}>
                    <div className={s.zoneTitle} style={{ marginBottom: 0 }}>
                        市場風向
                    </div>
                    {tw?.meta && (
                        <FreshnessBadge level={tw.meta.realtime_level} compact />
                    )}
                </div>
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 10,
                        marginTop: 4,
                    }}
                >
                    <span style={{ fontSize: 22 }}>{regime.icon}</span>
                    <span
                        style={{
                            fontSize: 20,
                            fontWeight: 800,
                            color: regime.tone,
                        }}
                    >
                        {tw
                            ? TW_REGIME_LABEL[tw.state] ?? tw.state
                            : regime.label}
                    </span>
                    <span
                        style={{
                            marginLeft: 'auto',
                            fontFamily: vars.font.mono,
                            fontSize: 22,
                            fontWeight: 800,
                        }}
                    >
                        {Math.round(feed.marketScore)}
                    </span>
                </div>
                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: 10,
                        marginTop: 12,
                    }}
                >
                    <div>
                        <div className={s.cardMetaLab}>加權</div>
                        <div
                            className={
                                (tw?.taiex_change_pct ?? feed.taiexPct ?? 0) >= 0
                                    ? s.toneUp
                                    : s.toneDown
                            }
                            style={{
                                fontFamily: vars.font.mono,
                                fontWeight: 700,
                                fontSize: 15,
                            }}
                        >
                            {dirArrow(tw?.taiex_direction ?? '')}{' '}
                            {fmtPctSigned(
                                tw?.taiex_change_pct ?? feed.taiexPct,
                            )}
                        </div>
                    </div>
                    <div>
                        <div className={s.cardMetaLab}>櫃買</div>
                        <div
                            className={
                                (tw?.tpex_change_pct ?? feed.tpexPct ?? 0) >= 0
                                    ? s.toneUp
                                    : s.toneDown
                            }
                            style={{
                                fontFamily: vars.font.mono,
                                fontWeight: 700,
                                fontSize: 15,
                            }}
                        >
                            {dirArrow(tw?.tpex_direction ?? '')}{' '}
                            {fmtPctSigned(tw?.tpex_change_pct ?? feed.tpexPct)}
                        </div>
                    </div>
                    <div>
                        <div className={s.cardMetaLab}>上漲家數</div>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>
                            {tw?.market_breadth_advance_pct != null
                                ? `${tw.market_breadth_advance_pct.toFixed(0)}%`
                                : mc?.breadth?.advance_pct != null
                                  ? `${mc.breadth.advance_pct.toFixed(0)}%`
                                  : '—'}
                        </div>
                        {mc?.breadth && (
                            <div
                                style={{
                                    fontSize: 11,
                                    color: vars.color.mutedForeground,
                                    marginTop: 2,
                                }}
                            >
                                ↑{mc.breadth.advancers} ↓{mc.breadth.decliners}{' '}
                                —{mc.breadth.unchanged}
                            </div>
                        )}
                    </div>
                    <div>
                        <div className={s.cardMetaLab}>成交量動能</div>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>
                            {tw?.turnover_acceleration === 'ACCELERATING'
                                ? '加速'
                                : tw?.turnover_acceleration === 'DECELERATING'
                                  ? '減速'
                                  : tw?.turnover_acceleration === 'FLAT'
                                    ? '持平'
                                    : '—'}
                        </div>
                    </div>
                </div>
                {mc?.institutional_eod && (
                    <div
                        style={{
                            marginTop: 12,
                            paddingTop: 10,
                            borderTop: `1px solid ${radarColor.glassBorder}`,
                            fontSize: 12,
                            color: vars.color.mutedForeground,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            flexWrap: 'wrap',
                        }}
                    >
                        <span>法人背景</span>
                        <FreshnessBadge level="PREVIOUS_DAY" compact />
                        <span>前一日 · 非即時外資動態</span>
                    </div>
                )}
            </div>

            {mc?.gap_layers ? (
                <div className={s.zoneBlock}>
                    <div className={s.zoneTitle}>延伸情境層</div>
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr 1fr',
                            gap: 8,
                            fontSize: 12,
                        }}
                    >
                        <div>
                            亞洲{' '}
                            {mc.gap_layers.asia_regime?.data?.state ?? '—'}
                            {mc.gap_layers.asia_regime?.data?.vs_taiwan
                                ? ` · ${mc.gap_layers.asia_regime.data.vs_taiwan}`
                                : ''}
                        </div>
                        <div>
                            集中度{' '}
                            {mc.gap_layers.index_concentration?.data?.state ??
                                '—'}
                            {mc.gap_layers.index_concentration?.proxy
                                ? '（代理）'
                                : ''}
                        </div>
                        <div>
                            期貨領先{' '}
                            {mc.gap_layers.futures_lead?.data?.state ?? '—'}
                        </div>
                        <div>
                            擁擠{' '}
                            {mc.gap_layers.crowding?.data?.state ?? '—'}
                        </div>
                        <div>
                            大事{' '}
                            {mc.gap_layers.macro_event_calendar?.data?.nearest
                                ?.event_type ?? '—'}
                        </div>
                        <div>
                            盤前競價{' '}
                            {mc.gap_layers.preopen_auction?.data?.state ?? '—'}
                        </div>
                    </div>
                    <div
                        style={{
                            marginTop: 8,
                            fontSize: 11,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        僅供情境，不改分數
                    </div>
                </div>
            ) : null}

            {/* 3 Capital / Sector Rotation */}
            <div className={s.section}>
                <div className={s.sectionRow}>
                    <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                        哪個產業成交最熱
                    </div>
                </div>
                <div
                    style={{
                        fontSize: 12,
                        color: vars.color.mutedForeground,
                        marginBottom: 10,
                        lineHeight: 1.55,
                    }}
                >
                    這不是外資買超，也不是淨流入。數字是這個產業今天成交金額佔全市場的比重。排名愈前面，盤面上愈多人在這類股票成交。
                </div>
                {(mc?.top_rotating ?? []).slice(0, 3).map((row) => {
                    const leaders = (row.leaders ?? [])
                        .slice(0, 3)
                        .map((l) =>
                            l.name ? `${l.symbol} ${l.name}` : l.symbol,
                        )
                        .join('、');
                    const rankMove =
                        row.sector_rank_change != null &&
                        row.sector_rank_change !== 0
                            ? row.sector_rank_change > 0
                                ? `升 ${row.sector_rank_change}`
                                : `降 ${Math.abs(row.sector_rank_change)}`
                            : '持平';
                    const shareDelta =
                        row.turnover_share_delta != null &&
                        Math.abs(row.turnover_share_delta) >= 0.0005
                            ? `${row.turnover_share_delta >= 0 ? '+' : ''}${(row.turnover_share_delta * 100).toFixed(1)} 百分點`
                            : null;
                    return (
                        <div
                            key={row.sector}
                            className={s.glass}
                            style={{ padding: 12, marginBottom: 8 }}
                        >
                            <div
                                style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    gap: 8,
                                }}
                            >
                                <strong style={{ fontSize: 14 }}>
                                    {displayIndustryName(row.sector)}
                                </strong>
                                <span
                                    style={{
                                        fontSize: 12,
                                        fontWeight: 700,
                                        color: radarColor.heating,
                                    }}
                                >
                                    {SECTOR_STATE_LABEL[row.state] ??
                                        ROTATION_LABEL[row.state] ??
                                        row.state}
                                </span>
                            </div>
                            <div
                                style={{
                                    marginTop: 8,
                                    display: 'grid',
                                    gridTemplateColumns: '1fr 1fr 1fr',
                                    gap: 6,
                                    fontSize: 12,
                                }}
                            >
                                <div>
                                    <div className={s.cardMetaLab}>成交排名</div>
                                    #{row.sector_rank ?? '—'} {rankMove}
                                </div>
                                <div>
                                    <div className={s.cardMetaLab}>
                                        佔全市場成交
                                    </div>
                                    {(row.turnover_share * 100).toFixed(1)}%
                                    {shareDelta ? ` ${shareDelta}` : ''}
                                </div>
                                <div>
                                    <div className={s.cardMetaLab}>
                                        上漲家數占比
                                    </div>
                                    {row.breadth != null
                                        ? `${(row.breadth * 100).toFixed(0)}%`
                                        : '—'}
                                </div>
                            </div>
                            {leaders ? (
                                <div
                                    style={{
                                        marginTop: 8,
                                        fontSize: 12,
                                        color: vars.color.mutedForeground,
                                    }}
                                >
                                    成交較多：{leaders}
                                </div>
                            ) : null}
                        </div>
                    );
                })}
                {!mc?.top_rotating?.length && (
                    <div className={s.empty}>
                        {mcStatus === 'loading'
                            ? '產業輪動資料載入中'
                            : mcStatus === 'error'
                              ? '產業輪動暫時無法載入'
                              : '目前尚無產業輪動資料'}
                    </div>
                )}
            </div>

            {/* 4 Heating / pullback — not a second ranked buy list */}
            <div className={s.section}>
                <div className={s.sectionRow}>
                    <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                        盤中熱度（僅供參考）
                    </div>
                    <button
                        type="button"
                        className={s.linkBtn}
                        onClick={() => onGoRadar('strong')}
                    >
                        雷達 ›
                    </button>
                </div>
                <div
                    style={{
                        fontSize: 12,
                        color: vars.color.mutedForeground,
                        marginBottom: 8,
                    }}
                >
                    要買哪檔請看最上方「今天看這幾支」，這裡只是熱度變化。
                </div>
                {heating.length > 0 && (
                    <>
                        <div
                            style={{
                                fontSize: 13,
                                fontWeight: 700,
                                margin: '14px 0 8px',
                                color: vars.color.mutedForeground,
                            }}
                        >
                            正在升溫
                        </div>
                        <div className={s.hScroll}>
                            {heating.map((item) => (
                                <MiniHeatCard
                                    key={item.symbol}
                                    item={item}
                                    onOpen={onOpenSymbol}
                                />
                            ))}
                        </div>
                    </>
                )}
                {pullbacks.length > 0 && (
                    <>
                        <div
                            style={{
                                fontSize: 13,
                                fontWeight: 700,
                                margin: '14px 0 8px',
                                color: vars.color.mutedForeground,
                            }}
                        >
                            回踩觀察
                        </div>
                        <div className={s.hScroll}>
                            {pullbacks.map((item) => (
                                <MiniPullbackCard
                                    key={item.symbol}
                                    item={item}
                                    onOpen={onOpenSymbol}
                                />
                            ))}
                        </div>
                    </>
                )}
            </div>

            {/* 5 Major Event */}
            <div className={s.section}>
                <div className={s.sectionTitle}>重大事件</div>
                {events.length === 0 ? (
                    <div className={s.empty}>目前無重大事件</div>
                ) : (
                    events.map((ev) => {
                        const conf = eventExtra[ev.event_id]?.confirmation;
                        return (
                            <div
                                key={ev.event_id}
                                className={s.glass}
                                style={{ padding: 12, marginBottom: 8 }}
                            >
                                <div
                                    style={{
                                        fontSize: 12,
                                        color: vars.color.mutedForeground,
                                    }}
                                >
                                    {EVENT_TYPE_LABEL[ev.event_type] ??
                                        ev.event_type}
                                </div>
                                <div style={{ fontWeight: 700, marginTop: 4 }}>
                                    {ev.title}
                                </div>
                                {conf && (
                                    <div
                                        style={{
                                            marginTop: 6,
                                            fontSize: 12,
                                            color: radarColor.aiSoft,
                                        }}
                                    >
                                        {CONFIRM_LABEL[conf.status] ??
                                            conf.status}
                                    </div>
                                )}
                                <div style={{ marginTop: 8 }}>
                                    <ConfirmLayersRow
                                        size="sm"
                                        layers={{
                                            stock: (conf?.c_strong_count ?? 0) > 0,
                                            sector:
                                                conf?.sector_rank != null &&
                                                conf.sector_rank_prev != null &&
                                                conf.sector_rank <
                                                    conf.sector_rank_prev,
                                            market:
                                                conf?.status ===
                                                'EVENT_MARKET_CONFIRMED',
                                            event:
                                                conf?.status ===
                                                    'EVENT_MARKET_CONFIRMED' ||
                                                conf?.status === 'EVENT_WATCH',
                                        }}
                                    />
                                </div>
                            </div>
                        );
                    })
                )}
                {onGoIntel && (
                    <button
                        type="button"
                        className={s.linkBtn}
                        onClick={onGoIntel}
                    >
                        更多情報 ›
                    </button>
                )}
            </div>

            {/* 6 Market Calendar */}
            {cal && (
                <div className={s.zoneBlock}>
                    <div className={s.sectionRow}>
                        <div className={s.zoneTitle} style={{ marginBottom: 0 }}>
                            重要日曆
                        </div>
                        <span
                            style={{
                                fontSize: 12,
                                fontFamily: vars.font.mono,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            {cal.date.slice(5).replace('-', '/')}
                        </span>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.5 }}>
                        {cal.monthly_expiry.is_monthly_expiry_day ? (
                            <div style={{ fontWeight: 800, color: '#e8a87c' }}>
                                台指期月結算 ·{' '}
                                {EXPIRY_PHASE_LABEL[
                                    cal.monthly_expiry.expiry_phase
                                ]}
                            </div>
                        ) : (
                            <div>
                                台指期{' '}
                                {EXPIRY_PHASE_LABEL[
                                    cal.monthly_expiry.expiry_phase
                                ]}
                                · 距結算{' '}
                                {cal.monthly_expiry.days_to_monthly_expiry} 日
                                {cal.monthly_expiry.institutional_roll_sensitive
                                    ? ' · 法人轉倉敏感期'
                                    : ''}
                            </div>
                        )}
                        <div
                            style={{
                                marginTop: 4,
                                fontSize: 13,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            今日除權息 {cal.corporate_action_count} · 本月{' '}
                            {cal.corporate_actions_this_month?.length ??
                                cal.corporate_action_count}{' '}
                            · 下月{' '}
                            {cal.corporate_actions_next_month?.length ?? 0} ·
                            重大事件 {cal.major_event_count}
                        </div>
                        <div
                            style={{
                                marginTop: 6,
                                fontSize: 11,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            （結算日、除權息不是多空結論，方便安排進出）
                        </div>
                    </div>
                    <div
                        style={{
                            marginTop: 12,
                            paddingTop: 10,
                            borderTop: `1px solid ${radarColor.glassBorder}`,
                        }}
                    >
                        <div
                            style={{
                                fontSize: 13,
                                fontWeight: 700,
                                marginBottom: 4,
                            }}
                        >
                            本月除權息（{monthZh(cal.this_month, '本月')}）
                        </div>
                        <div
                            style={{
                                maxHeight: 220,
                                overflowY: 'auto',
                            }}
                        >
                            <CorporateActionRows
                                items={
                                    cal.corporate_actions_this_month ??
                                    cal.corporate_actions_today
                                }
                                onOpenSymbol={onOpenSymbol}
                            />
                        </div>
                        <div
                            style={{
                                fontSize: 13,
                                fontWeight: 700,
                                margin: '14px 0 4px',
                            }}
                        >
                            下月除權息（{monthZh(cal.next_month, '下月')}）
                        </div>
                        <div
                            style={{
                                maxHeight: 220,
                                overflowY: 'auto',
                            }}
                        >
                            <CorporateActionRows
                                items={cal.corporate_actions_next_month ?? []}
                                onOpenSymbol={onOpenSymbol}
                            />
                        </div>
                    </div>
                </div>
            )}

            <div className={s.quickBar}>
                <button
                    type="button"
                    className={s.quickBtn}
                    onClick={() => onGoRadar()}
                >
                    看雷達
                </button>
                <button
                    type="button"
                    className={s.quickBtn}
                    onClick={onGoWatch}
                >
                    觀察清單
                </button>
                {onSearch && (
                    <button
                        type="button"
                        className={s.quickBtn}
                        onClick={onSearch}
                    >
                        搜尋
                    </button>
                )}
            </div>
            <div className={s.pageEnd} />
        </>
    );
}
