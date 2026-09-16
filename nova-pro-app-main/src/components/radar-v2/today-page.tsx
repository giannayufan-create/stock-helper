import { useEffect, useState } from 'react';
import {
    deltaLabel,
    fetchMiOverview,
    type MiOverview,
} from '../../lib/market-intelligence';
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
import type { RadarFeed } from './use-radar-feed';

const toneWeak = '#6b8cae';
const toneStrong = radarColor.strong;

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

    const [mi, setMi] = useState<MiOverview | null>(null);
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
            void fetchMiOverview()
                .then((ov) => {
                    if (!cancelled) setMi(ov);
                })
                .catch(() => undefined);
        load();
        const t = setInterval(load, 30_000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

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
                const top = (res.items ?? []).slice(0, 4);
                setEvents(top);
                const extras: typeof eventExtra = {};
                await Promise.all(
                    top.map(async (ev) => {
                        try {
                            const d = await fetchEventDetail(ev.event_id);
                            extras[ev.event_id] = {
                                confirmation: d.confirmation,
                                impact: d.impact,
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
                // soft-fail
            }
        };
        void load();
        const t = setInterval(() => void load(), 90_000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

    const sectors = (mi?.top_sectors ?? [])
        .filter((x) => x.eligible_for_ranking !== false)
        .slice(0, 5);
    const themes = (mi?.top_themes ?? [])
        .filter((x) => x.eligible_for_ranking !== false)
        .slice(0, 5);
    const sox = mi?.global_markets?.find((a) => a.id === 'sox');
    const nasdaq = mi?.global_markets?.find((a) => a.id === 'nasdaq');

    const tw = mc?.taiwan_regime;
    const dirArrow = (d: string | undefined) =>
        d === 'UP' ? '↑' : d === 'DOWN' ? '↓' : d === 'FLAT' ? '→' : '·';

    return (
        <>
            <div className={s.marketStrip}>
                <span style={{ fontSize: 22, lineHeight: 1 }}>{regime.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                        style={{
                            fontSize: 18,
                            fontWeight: 800,
                            color: regime.tone,
                        }}
                    >
                        {regime.label}{' '}
                        <span
                            style={{
                                fontFamily: vars.font.mono,
                                fontSize: 18,
                            }}
                        >
                            {Math.round(feed.marketScore)}
                        </span>
                    </div>
                    <div
                        style={{
                            fontSize: 12,
                            color: vars.color.mutedForeground,
                            marginTop: 2,
                        }}
                    >
                        加權 {fmtPctSigned(feed.taiexPct)} · 櫃買{' '}
                        {fmtPctSigned(feed.tpexPct)} · 開盤通過 {feed.passCount}{' '}
                        · 強勢 {feed.strong} · 升溫 {feed.heating}
                    </div>
                </div>
                <button
                    type="button"
                    className={s.iconBtn}
                    aria-label="重新整理"
                    onClick={() => feed.refresh()}
                >
                    ↻
                </button>
            </div>

            {cal && (
                <button
                    type="button"
                    className={s.glass}
                    style={{
                        padding: 14,
                        marginBottom: 12,
                        width: '100%',
                        textAlign: 'left',
                        cursor: 'pointer',
                        border: 'none',
                    }}
                    onClick={() => setCalOpen((v) => !v)}
                >
                    <div className={s.sectionRow}>
                        <strong style={{ fontSize: 15 }}>今日重要日曆</strong>
                        <span
                            style={{
                                fontSize: 11,
                                color: vars.color.mutedForeground,
                                fontFamily: vars.font.mono,
                            }}
                        >
                            {cal.date.slice(5).replace('-', '/')}
                        </span>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.55 }}>
                        {cal.monthly_expiry.is_monthly_expiry_day ? (
                            <div>
                                <span style={{ color: '#c45c26', fontWeight: 700 }}>
                                    台指期月結算
                                </span>
                                <span
                                    style={{
                                        marginLeft: 8,
                                        fontSize: 12,
                                        color: vars.color.mutedForeground,
                                    }}
                                >
                                    {EXPIRY_PHASE_LABEL[cal.monthly_expiry.expiry_phase]}
                                    {cal.monthly_expiry.institutional_roll_sensitive
                                        ? ' · 法人轉倉敏感期'
                                        : ''}
                                </span>
                            </div>
                        ) : (
                            <div>
                                台指期距月結算{' '}
                                <b>{cal.monthly_expiry.days_to_monthly_expiry}</b> 日
                                <span
                                    style={{
                                        marginLeft: 8,
                                        fontSize: 12,
                                        color: vars.color.mutedForeground,
                                    }}
                                >
                                    {EXPIRY_PHASE_LABEL[cal.monthly_expiry.expiry_phase]}
                                    {cal.monthly_expiry.institutional_roll_sensitive
                                        ? ' · 法人轉倉敏感期'
                                        : ''}
                                </span>
                            </div>
                        )}
                        <div style={{ marginTop: 4, fontSize: 13 }}>
                            除權息：{cal.corporate_action_count} 檔
                            {' · '}重大事件：{cal.major_event_count}
                        </div>
                    </div>

                    {calOpen && (
                        <div
                            style={{
                                marginTop: 12,
                                paddingTop: 10,
                                borderTop: `1px solid ${vars.color.border}`,
                                fontSize: 13,
                            }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div style={{ fontWeight: 700, marginBottom: 6 }}>
                                Derivatives Calendar
                            </div>
                            <div
                                style={{
                                    fontFamily: vars.font.mono,
                                    fontSize: 12,
                                    color: vars.color.mutedForeground,
                                    marginBottom: 10,
                                }}
                            >
                                台指期 MONTHLY · 距結算{' '}
                                {cal.monthly_expiry.days_to_monthly_expiry} 天 ·{' '}
                                {cal.monthly_expiry.expiry_phase}
                                <div style={{ marginTop: 4 }}>
                                    （非多空結論）
                                </div>
                            </div>
                            <div style={{ fontWeight: 700, marginBottom: 6 }}>
                                今日除權息
                            </div>
                            {cal.corporate_actions_today.length === 0 ? (
                                <div style={{ color: vars.color.mutedForeground }}>
                                    無
                                </div>
                            ) : (
                                cal.corporate_actions_today.slice(0, 12).map((a) => (
                                    <div
                                        key={`${a.symbol}-${a.action_date}`}
                                        style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            gap: 8,
                                            padding: '4px 0',
                                        }}
                                    >
                                        <button
                                            type="button"
                                            style={{
                                                background: 'none',
                                                border: 'none',
                                                padding: 0,
                                                cursor: 'pointer',
                                                color: 'inherit',
                                                font: 'inherit',
                                                textAlign: 'left',
                                            }}
                                            onClick={() => onOpenSymbol(a.symbol)}
                                        >
                                            {a.symbol} {a.name}
                                        </button>
                                        <span style={{ color: vars.color.mutedForeground }}>
                                            {ACTION_TYPE_LABEL[a.action_type] ??
                                                a.action_type}
                                            {a.cash_dividend != null
                                                ? ` ${a.cash_dividend}`
                                                : ''}
                                        </span>
                                    </div>
                                ))
                            )}
                        </div>
                    )}
                </button>
            )}

            {mc && tw && (
                <div className={s.glass} style={{ padding: 14, marginBottom: 12 }}>
                    <div className={s.sectionRow}>
                        <strong style={{ fontSize: 15 }}>市場風向</strong>
                        <span
                            style={{
                                fontSize: 11,
                                color: vars.color.mutedForeground,
                                fontFamily: vars.font.mono,
                            }}
                        >
                            {tw.meta.realtime_level} · 覆蓋{' '}
                            {mc.breadth.coverage_pct.toFixed(0)}%
                        </span>
                    </div>
                    <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.5 }}>
                        台股風向：
                        <b style={{ marginLeft: 6 }}>
                            {TW_REGIME_LABEL[tw.state] ?? tw.state}
                        </b>
                        <span
                            style={{
                                marginLeft: 8,
                                fontSize: 12,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            GLOBAL {mc.global_regime.state}
                        </span>
                    </div>
                    <div
                        style={{
                            marginTop: 6,
                            fontSize: 13,
                            fontFamily: vars.font.mono,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        加權 {dirArrow(tw.taiex_direction)}
                        {tw.taiex_change_pct != null
                            ? ` ${tw.taiex_change_pct >= 0 ? '+' : ''}${tw.taiex_change_pct.toFixed(2)}%`
                            : ''}
                        {' · '}櫃買 {dirArrow(tw.tpex_direction)}
                        {tw.tpex_change_pct != null
                            ? ` ${tw.tpex_change_pct >= 0 ? '+' : ''}${tw.tpex_change_pct.toFixed(2)}%`
                            : ''}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 13 }}>
                        上漲家數占比：
                        <b>
                            {tw.market_breadth_advance_pct != null
                                ? `${tw.market_breadth_advance_pct.toFixed(0)}%`
                                : '—'}
                        </b>
                        {' · '}成交動能：
                        <b>{tw.turnover_acceleration}</b>
                    </div>
                    <div
                        style={{
                            marginTop: 8,
                            fontSize: 11,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        廣域樣本 {mc.broad_universe.broad_universe_size} 檔（非
                        BP active 80）· 法人籌碼{' '}
                        {mc.institutional_eod.realtime_level}（Previous Day）
                    </div>
                </div>
            )}

            {mc && mc.top_rotating.length > 0 && (
                <section className={s.section}>
                    <div className={s.sectionRow}>
                        <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                            產業輪動 · 資金關注度
                        </div>
                    </div>
                    <div
                        style={{
                            fontSize: 11,
                            color: vars.color.mutedForeground,
                            marginBottom: 8,
                        }}
                    >
                        成交額占比移動（非淨流入）
                    </div>
                    {mc.top_rotating.slice(0, 5).map((sec, idx) => {
                        const sharePct = (sec.turnover_share * 100).toFixed(1);
                        const prevPct =
                            sec.turnover_share_prev != null
                                ? (sec.turnover_share_prev * 100).toFixed(1)
                                : null;
                        const rankLine =
                            sec.sector_rank_prev != null && sec.sector_rank != null
                                ? `Rank #${sec.sector_rank_prev} → #${sec.sector_rank}`
                                : sec.sector_rank != null
                                  ? `Rank #${sec.sector_rank}`
                                  : '';
                        return (
                            <div
                                key={sec.sector}
                                className={s.glass}
                                style={{
                                    padding: '10px 12px',
                                    marginBottom: 6,
                                    minHeight: 44,
                                }}
                            >
                                <div
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        gap: 8,
                                    }}
                                >
                                    <span style={{ fontWeight: 800 }}>
                                        {idx + 1} {sec.sector}
                                    </span>
                                    <span
                                        style={{
                                            fontWeight: 700,
                                            color:
                                                sec.state === 'ROTATING_IN' ||
                                                sec.state === 'HOT'
                                                    ? toneStrong
                                                    : sec.state === 'ROTATING_OUT' ||
                                                        sec.state === 'COLD'
                                                      ? toneWeak
                                                      : vars.color.foreground,
                                        }}
                                    >
                                        {sec.state === 'ROTATING_IN' ? '🔥 ' : ''}
                                        {ROTATION_LABEL[sec.state] ?? sec.state}
                                    </span>
                                </div>
                                <div
                                    style={{
                                        marginTop: 4,
                                        fontSize: 12,
                                        color: vars.color.mutedForeground,
                                        fontFamily: vars.font.mono,
                                    }}
                                >
                                    {rankLine}
                                    {rankLine ? ' · ' : ''}
                                    Share{' '}
                                    {prevPct != null
                                        ? `${prevPct} → ${sharePct}%`
                                        : `${sharePct}%`}
                                    {sec.breadth != null
                                        ? ` · Breadth ${(sec.breadth * 100).toFixed(0)}%`
                                        : ''}
                                </div>
                                {sec.high_concentration && (
                                    <div
                                        style={{
                                            marginTop: 4,
                                            fontSize: 11,
                                            color: toneWeak,
                                        }}
                                    >
                                        HIGH_CONCENTRATION · 非整體產業轉強
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </section>
            )}

            {events.length > 0 && (
                <section className={s.section}>
                    <div className={s.sectionRow}>
                        <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                            重大事件
                        </div>
                        <span
                            style={{
                                fontSize: 11,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            假設＋市場確認 · 非法買訊號
                        </span>
                    </div>
                    {events.map((ev) => {
                        const extra = eventExtra[ev.event_id];
                        const conf = extra?.confirmation;
                        const hyps = (extra?.impact?.sector_hypotheses ?? []).slice(
                            0,
                            3,
                        );
                        const typeLabel =
                            EVENT_TYPE_LABEL[ev.event_type] ?? ev.event_type;
                        return (
                            <div
                                key={ev.event_id}
                                className={s.glass}
                                style={{
                                    padding: '12px 14px',
                                    marginBottom: 8,
                                }}
                            >
                                <div style={{ fontWeight: 800, fontSize: 14 }}>
                                    {typeLabel}
                                </div>
                                <div style={{ marginTop: 4, fontSize: 14 }}>
                                    {ev.title}
                                </div>
                                <div
                                    style={{
                                        marginTop: 6,
                                        fontSize: 12,
                                        color: vars.color.mutedForeground,
                                        fontFamily: vars.font.mono,
                                    }}
                                >
                                    來源 {ev.sources_count} · 可信度{' '}
                                    {ev.confidence} · Freshness {ev.freshness}
                                    {' · '}Relevance {ev.event_relevance}
                                </div>
                                {hyps.length > 0 && (
                                    <div style={{ marginTop: 8, fontSize: 13 }}>
                                        <div
                                            style={{
                                                fontSize: 11,
                                                color: vars.color.mutedForeground,
                                                marginBottom: 4,
                                            }}
                                        >
                                            可能影響（hypothesis）
                                        </div>
                                        {hyps.map((h) => (
                                            <div key={h.sector_or_theme}>
                                                {h.sector_or_theme} · Relevance{' '}
                                                {h.relevance} · {h.direction}
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {conf && (
                                    <div style={{ marginTop: 8, fontSize: 13 }}>
                                        <div style={{ fontWeight: 700 }}>
                                            市場確認{' '}
                                            {CONFIRM_LABEL[conf.status] ??
                                                conf.status}
                                        </div>
                                        <div
                                            style={{
                                                marginTop: 4,
                                                fontSize: 12,
                                                fontFamily: vars.font.mono,
                                                color: vars.color.mutedForeground,
                                            }}
                                        >
                                            Confirmation{' '}
                                            {conf.market_confirmation_score}
                                            {conf.sector_rank_prev != null &&
                                            conf.sector_rank != null
                                                ? ` · Rank #${conf.sector_rank_prev} → #${conf.sector_rank}`
                                                : ''}
                                            {conf.turnover_share != null
                                                ? ` · Share ${(
                                                      (conf.turnover_share_prev ??
                                                          0) * 100
                                                  ).toFixed(1)} → ${(
                                                      conf.turnover_share * 100
                                                  ).toFixed(1)}%`
                                                : ''}
                                            {conf.breadth != null
                                                ? ` · Breadth ${(
                                                      conf.breadth * 100
                                                  ).toFixed(0)}%`
                                                : ''}
                                        </div>
                                        <div
                                            style={{
                                                marginTop: 4,
                                                fontSize: 11,
                                                color: vars.color.mutedForeground,
                                            }}
                                        >
                                            Event Relevance 與 Market Confirmation
                                            分開顯示 · 法人籌碼為 PREVIOUS_DAY
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </section>
            )}

            {mi?.market_context && (
                <div className={s.glass} style={{ padding: 14, marginBottom: 12 }}>
                    <div
                        style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                        }}
                    >
                        <strong style={{ fontSize: 15 }}>今日情報</strong>
                        {onGoIntel && (
                            <button
                                type="button"
                                className={s.linkBtn}
                                onClick={onGoIntel}
                            >
                                查看完整情報 ›
                            </button>
                        )}
                    </div>
                    <div style={{ fontSize: 13, marginTop: 8, lineHeight: 1.45 }}>
                        市場環境 <b>{mi.market_context.risk_environment}</b>
                        {' · '}科技 {mi.market_context.tech_context}
                        {' · '}半導體 {mi.market_context.semiconductor_context}
                    </div>
                    <div
                        style={{
                            fontSize: 12,
                            fontFamily: vars.font.mono,
                            marginTop: 6,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        SOX{' '}
                        {sox?.change_pct != null
                            ? `${sox.change_pct >= 0 ? '+' : ''}${sox.change_pct.toFixed(1)}%`
                            : '—'}
                        {' · '}NASDAQ{' '}
                        {nasdaq?.change_pct != null
                            ? `${nasdaq.change_pct >= 0 ? '+' : ''}${nasdaq.change_pct.toFixed(1)}%`
                            : '—'}
                    </div>
                </div>
            )}

            {sectors.length > 0 && (
                <section className={s.section}>
                    <div className={s.sectionRow}>
                        <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                            熱門產業
                        </div>
                        {onGoIntel && (
                            <button
                                type="button"
                                className={s.linkBtn}
                                onClick={onGoIntel}
                            >
                                全部 ›
                            </button>
                        )}
                    </div>
                    {sectors.map((sec) => (
                        <div
                            key={sec.sector}
                            className={s.glass}
                            style={{
                                padding: '10px 12px',
                                marginBottom: 6,
                                display: 'flex',
                                justifyContent: 'space-between',
                            }}
                        >
                            <span style={{ fontWeight: 700 }}>{sec.sector}</span>
                            <span style={{ fontFamily: vars.font.mono }}>
                                <b style={{ color: radarColor.strong }}>
                                    {sec.heat_score != null
                                        ? Math.round(sec.heat_score)
                                        : '—'}
                                </b>{' '}
                                <span style={{ color: radarColor.heating }}>
                                    {deltaLabel(sec.heat_delta_5m)}
                                </span>
                            </span>
                        </div>
                    ))}
                </section>
            )}

            {themes.length > 0 && (
                <section className={s.section}>
                    <div className={s.sectionTitle}>熱門題材</div>
                    {themes.map((th) => (
                        <div
                            key={th.theme_id}
                            className={s.glass}
                            style={{
                                padding: '10px 12px',
                                marginBottom: 6,
                                display: 'flex',
                                justifyContent: 'space-between',
                            }}
                        >
                            <span style={{ fontWeight: 700 }}>{th.theme}</span>
                            <span style={{ fontFamily: vars.font.mono }}>
                                <b style={{ color: radarColor.strong }}>
                                    {th.heat_score != null
                                        ? Math.round(th.heat_score)
                                        : '—'}
                                </b>{' '}
                                <span style={{ color: radarColor.heating }}>
                                    {deltaLabel(th.heat_delta_5m)}
                                </span>
                            </span>
                        </div>
                    ))}
                </section>
            )}

            <div className={s.quickBar}>
                <button
                    type="button"
                    className={s.quickBtn}
                    onClick={() => onGoRadar('strong')}
                >
                    看雷達
                </button>
                <button type="button" className={s.quickBtn} onClick={onGoWatch}>
                    開盤通過
                </button>
                <button
                    type="button"
                    className={s.quickBtn}
                    onClick={onSearch}
                    disabled={!onSearch}
                >
                    搜尋
                </button>
            </div>

            <section className={s.section}>
                <div className={s.sectionRow}>
                    <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                        現在最值得看
                    </div>
                    <button
                        type="button"
                        className={s.linkBtn}
                        onClick={() => onGoRadar('strong')}
                    >
                        全部 ›
                    </button>
                </div>

                {feed.loading && !top.length ? (
                    <div className={s.empty}>載入中…</div>
                ) : !top.length ? (
                    <div className={s.empty}>
                        目前沒有雷達資料
                        <br />
                        <button
                            type="button"
                            className={s.quickBtn}
                            style={{ marginTop: 12, width: '100%' }}
                            onClick={() => feed.refresh()}
                        >
                            重新整理
                        </button>
                    </div>
                ) : (
                    top.map((item, i) => (
                        <CompactStockRow
                            key={item.symbol}
                            item={item}
                            rank={i + 1}
                            selected={selectedSymbol === item.symbol}
                            onOpen={onOpenSymbol}
                        />
                    ))
                )}
            </section>

            {heating.length > 0 && (
                <section className={s.section}>
                    <div className={s.sectionRow}>
                        <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                            正在升溫
                        </div>
                        <button
                            type="button"
                            className={s.linkBtn}
                            onClick={() => onGoRadar('heating')}
                        >
                            全部 ›
                        </button>
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
                </section>
            )}

            {pullbacks.length > 0 && (
                <section className={s.section}>
                    <div className={s.sectionRow}>
                        <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                            回踩機會
                        </div>
                        <button
                            type="button"
                            className={s.linkBtn}
                            onClick={() => onGoRadar('pullback')}
                        >
                            全部 ›
                        </button>
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
                </section>
            )}
        </>
    );
}
