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
} from '../../lib/calendar';
import { vars } from '../../theme.css';
import { ConfirmLayersRow } from './confirm-layers';
import { FreshnessBadge } from './freshness-badge';
import {
    fmtPctSigned,
    regimeMeta,
    sortHeating,
    sortPullback,
    sortStrong,
} from './helpers';
import * as s from './radar.css';
import { CompactStockRow, MiniHeatCard, MiniPullbackCard } from './stock-cards';
import { radarColor } from './tokens';
import { SECTOR_STATE_LABEL } from './ui-context';
import type { RadarFeed } from './use-radar-feed';

function dirArrow(d: string) {
    if (d === 'UP') return '↑';
    if (d === 'DOWN') return '↓';
    return '→';
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
    const top = sortStrong(feed.items).slice(0, 5);
    const heating = sortHeating(feed.items)
        .filter(
            (i) =>
                i.state === 'HEATING' ||
                i.state === 'EMERGING' ||
                (i.heat_score ?? 0) >= 65,
        )
        .slice(0, 8);
    const pullbacks = sortPullback(feed.items).slice(0, 6);

    const [mc, setMc] = useState<MarketContextOverviewDto | null>(null);
    const [cal, setCal] = useState<CalendarTodayDto | null>(null);
    const [calOpen, setCalOpen] = useState(false);
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
                    if (!cancelled) setMc(ov);
                })
                .catch(() => undefined);
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
    const hasMarketConfirmed = Object.values(eventExtra).some(
        (v) => v.confirmation?.status === 'EVENT_MARKET_CONFIRMED',
    );

    const enrichFor = (symbol: string) => {
        const sec = feed.sectorBySymbol[symbol];
        const rot = mc?.top_rotating?.find((r) => r.sector === sec?.name);
        return {
            bp: feed.bpBySymbol[symbol] ?? null,
            sectorName: sec?.name ?? null,
            sectorRank: sec?.rank ?? rot?.sector_rank ?? null,
            sectorState: rot?.state ?? null,
            sectorHeat: sec?.heat ?? null,
            taiwanRegime: tw?.state ?? null,
            eventConfirmed: hasMarketConfirmed && Boolean(sec),
        };
    };

    return (
        <>
            {/* 1 Market Status / Data Health */}
            <div className={s.healthStrip}>
                <div>
                    <div style={{ fontSize: 12, color: vars.color.mutedForeground }}>
                        Market Status
                    </div>
                    <div
                        style={{
                            fontWeight: 800,
                            fontSize: 15,
                            color:
                                feed.liveStatus === 'LIVE'
                                    ? radarColor.live
                                    : feed.liveStatus === 'DATA STALE'
                                      ? radarColor.healthWarn
                                      : radarColor.healthBad,
                        }}
                    >
                        {feed.liveStatus}
                    </div>
                </div>
                <FreshnessBadge
                    level={
                        feed.liveStatus === 'LIVE'
                            ? 'REALTIME'
                            : feed.liveStatus === 'DATA STALE'
                              ? 'STALE'
                              : 'DELAYED'
                    }
                />
            </div>
            {feed.healthNote ? (
                <div className={s.banner} style={{ marginBottom: 12 }}>
                    {feed.healthNote}
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
                        <div className={s.cardMetaLab}>TAIEX</div>
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
                        <div className={s.cardMetaLab}>TPEX</div>
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
                        <div className={s.cardMetaLab}>Market Breadth</div>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>
                            {tw?.market_breadth_advance_pct != null
                                ? `${tw.market_breadth_advance_pct.toFixed(0)}%`
                                : mc?.breadth.advance_pct != null
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
                        <div className={s.cardMetaLab}>Turnover Accel</div>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>
                            {tw?.turnover_acceleration ?? '—'}
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
                        <span>PREVIOUS DAY · 非即時外資動態</span>
                    </div>
                )}
            </div>

            {/* 3 Capital / Sector Rotation */}
            <div className={s.section}>
                <div className={s.sectionRow}>
                    <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                        資金關注度輪動
                    </div>
                    <span
                        style={{
                            fontSize: 11,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        非淨流入
                    </span>
                </div>
                {(mc?.top_rotating ?? []).slice(0, 3).map((row) => (
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
                            <strong style={{ fontSize: 14 }}>{row.sector}</strong>
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
                                fontFamily: vars.font.mono,
                            }}
                        >
                            <div>
                                <div className={s.cardMetaLab}>Rank</div>
                                #{row.sector_rank ?? '—'}
                                {row.sector_rank_change != null
                                    ? ` (${row.sector_rank_change > 0 ? '+' : ''}${row.sector_rank_change})`
                                    : ''}
                            </div>
                            <div>
                                <div className={s.cardMetaLab}>Share</div>
                                {(row.turnover_share * 100).toFixed(1)}%
                                {row.turnover_share_delta != null
                                    ? ` ${row.turnover_share_delta >= 0 ? '+' : ''}${(row.turnover_share_delta * 100).toFixed(1)}`
                                    : ''}
                            </div>
                            <div>
                                <div className={s.cardMetaLab}>Breadth</div>
                                {row.breadth != null
                                    ? `${(row.breadth * 100).toFixed(0)}%`
                                    : '—'}
                            </div>
                        </div>
                    </div>
                ))}
                {!mc?.top_rotating?.length && (
                    <div className={s.empty}>產業輪動資料載入中</div>
                )}
            </div>

            {/* 4 Top Stocks Now */}
            <div className={s.section}>
                <div className={s.sectionRow}>
                    <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                        現在最值得看
                    </div>
                    <button
                        type="button"
                        className={s.linkBtn}
                        onClick={() => onGoRadar('strong')}
                    >
                        雷達 ›
                    </button>
                </div>
                {top.map((item, i) => (
                    <CompactStockRow
                        key={item.symbol}
                        item={item}
                        rank={i + 1}
                        selected={selectedSymbol === item.symbol}
                        onOpen={onOpenSymbol}
                        enrich={enrichFor(item.symbol)}
                    />
                ))}
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
                <button
                    type="button"
                    className={s.zoneBlock}
                    style={{
                        width: '100%',
                        textAlign: 'left',
                        cursor: 'pointer',
                        border: 'none',
                        color: 'inherit',
                    }}
                    onClick={() => setCalOpen((v) => !v)}
                >
                    <div className={s.sectionRow}>
                        <div className={s.zoneTitle} style={{ marginBottom: 0 }}>
                            今日重要日曆
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
                            除權息 {cal.corporate_action_count} · 重大事件{' '}
                            {cal.major_event_count}
                        </div>
                        <div
                            style={{
                                marginTop: 6,
                                fontSize: 11,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            （結算日非多空結論）
                        </div>
                    </div>
                    {calOpen && (
                        <div
                            style={{
                                marginTop: 12,
                                paddingTop: 10,
                                borderTop: `1px solid ${radarColor.glassBorder}`,
                            }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            {cal.corporate_actions_today.slice(0, 10).map((a) => (
                                <div
                                    key={`${a.symbol}-${a.action_date}`}
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        padding: '6px 0',
                                        minHeight: 44,
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
                                        }}
                                        onClick={() => onOpenSymbol(a.symbol)}
                                    >
                                        {a.symbol} {a.name}
                                    </button>
                                    <span
                                        style={{
                                            color: vars.color.mutedForeground,
                                            fontSize: 12,
                                        }}
                                    >
                                        {ACTION_TYPE_LABEL[a.action_type] ??
                                            a.action_type}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </button>
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
