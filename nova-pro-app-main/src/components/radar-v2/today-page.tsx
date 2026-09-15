import { useEffect, useState } from 'react';
import {
    deltaLabel,
    fetchMiOverview,
    type MiOverview,
} from '../../lib/market-intelligence';
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

    const sectors = (mi?.top_sectors ?? [])
        .filter((x) => x.eligible_for_ranking !== false)
        .slice(0, 5);
    const themes = (mi?.top_themes ?? [])
        .filter((x) => x.eligible_for_ranking !== false)
        .slice(0, 5);
    const sox = mi?.global_markets?.find((a) => a.id === 'sox');
    const nasdaq = mi?.global_markets?.find((a) => a.id === 'nasdaq');

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
                    style={{ width: 40, height: 40 }}
                >
                    ↻
                </button>
            </div>

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
