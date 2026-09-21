import { useEffect, useMemo, useState } from 'react';
import {
    fetchIntradayRankSymbol,
    fetchMarketConfig,
    type IntradayRankItemDto,
} from '../../lib/backend';
import type { BuyPressureItemDto } from '../../lib/buy-pressure';
import { useMediaQuery } from '../../hooks/use-media-query';
import type { ContractInfo } from '../../lib/types/contract';
import type { Snapshot } from '../../lib/types/market';
import { vars } from '../../theme.css';
import { loadFavorites } from './favorites';
import { liveStatusLabel, taipeiClock } from './helpers';
import { MorePage } from './more-page';
import { IntelPage } from './intel-page';
import { BrokerRadarPage } from './broker-radar-page';
import { BuyPressurePage } from './buy-pressure-page';
import { LimitUpPage } from './limit-up-page';
import {
    NotificationCenter,
    useNotificationToasts,
} from './notification-center';
import { PerformancePage } from './performance-page';
import { fetchUnreadCount } from '../../lib/notifications';
import { ensureStream, onBuyPressureNotification } from '../../lib/stream';
import * as s from './radar.css';
import { RadarPage } from './radar-page';
import { StockDetailPage } from './stock-detail';
import { TodayPage } from './today-page';
import type { LiveStatus, RadarTab } from './tokens';
import { radarColor } from './tokens';
import { useRadarFeed } from './use-radar-feed';
import { WatchPage } from './watch-page';

const NAV: Array<{ id: RadarTab; label: string; icon: string }> = [
    { id: 'today', label: '今日', icon: '◉' },
    { id: 'radar', label: '雷達', icon: '◎' },
    { id: 'watch', label: '觀察', icon: '☆' },
    { id: 'perf', label: '績效', icon: '▣' },
    { id: 'more', label: '更多', icon: '☰' },
];

export function RadarApp({
    onSelectCode,
    onOpenSearch,
}: {
    contract: ContractInfo | null;
    snapshot?: Snapshot;
    onSelectCode: (code: string) => void | Promise<void>;
    onOpenSearch?: () => void;
}) {
    const isDesktop = useMediaQuery('screen and (min-width: 1025px)');
    const feed = useRadarFeed(12_000);
    const [tab, setTab] = useState<RadarTab>('radar');
    const [radarInner, setRadarInner] = useState<string>('limit');
    const [detailSymbol, setDetailSymbol] = useState<string | null>(null);
    const [detailFetched, setDetailFetched] =
        useState<IntradayRankItemDto | null>(null);
    const [detailHint, setDetailHint] = useState<IntradayRankItemDto | null>(
        null,
    );
    const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
    const [clock, setClock] = useState(() => taipeiClock());
    const [provider, setProvider] = useState<'mock' | 'fugle' | 'shioaji' | null>(
        null,
    );
    const [showIntel, setShowIntel] = useState(false);
    const [showBrokerRadar, setShowBrokerRadar] = useState(false);
    const [showBuyPressure, setShowBuyPressure] = useState(false);
    const [showNotifications, setShowNotifications] = useState(false);
    const [unreadNotif, setUnreadNotif] = useState(0);

    useEffect(() => {
        // Defer SSE + unread so first paint can hit limit-up / rank first
        let unsub = () => undefined;
        const start = window.setTimeout(() => {
            ensureStream();
            const refresh = () => {
                void fetchUnreadCount()
                    .then((r) => setUnreadNotif(r.unread_count))
                    .catch(() => undefined);
            };
            refresh();
            unsub = onBuyPressureNotification(() => refresh());
        }, 4_000);
        const t = setInterval(() => {
            void fetchUnreadCount()
                .then((r) => setUnreadNotif(r.unread_count))
                .catch(() => undefined);
        }, 30_000);
        return () => {
            clearTimeout(start);
            clearInterval(t);
            unsub();
        };
    }, []);

    useEffect(() => {
        const t = setInterval(() => setClock(taipeiClock()), 15_000);
        return () => clearInterval(t);
    }, []);

    useEffect(() => {
        void fetchMarketConfig()
            .then((c) => setProvider(c.provider))
            .catch(() => setProvider(null));
    }, []);

    // Auto-open first stock on desktop when intensity list arrives (not 漲停板)
    useEffect(() => {
        if (!isDesktop || detailSymbol || !feed.items.length) return;
        if (tab === 'radar' && radarInner === 'limit') return;
        setDetailSymbol(feed.items[0]!.symbol);
    }, [isDesktop, feed.items, detailSymbol, tab, radarInner]);

    const detailItem = useMemo(() => {
        if (!detailSymbol) return null;
        const fromFeed = feed.items.find((i) => i.symbol === detailSymbol);
        if (fromFeed) return fromFeed;
        if (detailFetched?.symbol === detailSymbol) return detailFetched;
        if (detailHint?.symbol === detailSymbol) return detailHint;
        const bp = feed.bpBySymbol[detailSymbol];
        if (bp) return buyPressureToRankItem(bp);
        return stubRankItem(detailSymbol);
    }, [
        detailSymbol,
        feed.items,
        feed.bpBySymbol,
        detailFetched,
        detailHint,
    ]);

    useEffect(() => {
        if (!detailSymbol) {
            setDetailFetched(null);
            setDetailHint(null);
            return;
        }
        if (feed.items.some((i) => i.symbol === detailSymbol)) {
            setDetailFetched(null);
            return;
        }
        let cancelled = false;
        void fetchIntradayRankSymbol(detailSymbol)
            .then((d) => {
                if (cancelled || !d || 'error' in d) return;
                setDetailFetched(d);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [detailSymbol, feed.items]);

    const openSymbol = (
        symbol: string,
        hint?: IntradayRankItemDto | BuyPressureItemDto,
    ) => {
        setDetailSymbol(symbol);
        if (hint && 'buy_pressure_score' in hint) {
            setDetailHint(buyPressureToRankItem(hint));
        } else if (hint) {
            setDetailHint(hint);
        } else {
            setDetailHint(null);
        }
        void onSelectCode(symbol);
    };

    const toastLayer = useNotificationToasts(
        true,
        openSymbol,
        setUnreadNotif,
        (sym) => ({
            sector: feed.sectorBySymbol[sym]?.name ?? null,
            market: feed.marketRegime || null,
        }),
    );

    const closeDetail = () => setDetailSymbol(null);

    const statusLabel: LiveStatus = feed.liveStatus;
    const isSim = provider === 'mock';
    const isLiveFeed = provider === 'shioaji' || provider === 'fugle';

    const mainContent = (
        <>
            {showBrokerRadar ? (
                <BrokerRadarPage
                    onBack={() => setShowBrokerRadar(false)}
                    onOpenSymbol={(sym) => {
                        setShowBrokerRadar(false);
                        openSymbol(sym);
                    }}
                />
            ) : showBuyPressure ? (
                <BuyPressurePage
                    onBack={() => setShowBuyPressure(false)}
                    onOpenSymbol={(sym) => {
                        setShowBuyPressure(false);
                        openSymbol(sym);
                    }}
                />
            ) : showIntel ? (
                <IntelPage
                    onBack={() => {
                        setShowIntel(false);
                    }}
                />
            ) : (
                <>
            {tab === 'today' && (
                <TodayPage
                    feed={feed}
                    selectedSymbol={detailSymbol}
                    onOpenSymbol={openSymbol}
                    onGoRadar={(inner) => {
                        setRadarInner(inner ?? 'limit');
                        setTab('radar');
                        if (!isDesktop) closeDetail();
                    }}
                    onGoWatch={() => {
                        setTab('watch');
                        if (!isDesktop) closeDetail();
                    }}
                    onSearch={onOpenSearch}
                    onGoIntel={() => {
                        setShowIntel(true);
                        if (!isDesktop) closeDetail();
                    }}
                />
            )}
            {tab === 'radar' && (
                <>
                    <div className={s.quickBar} style={{ marginBottom: 10 }}>
                        <button
                            type="button"
                            className={`${s.quickBtn} ${
                                radarInner === 'limit' ? s.tabChipOn : ''
                            }`}
                            onClick={() => setRadarInner('limit')}
                        >
                            漲停板
                        </button>
                        <button
                            type="button"
                            className={`${s.quickBtn} ${
                                radarInner === 'buy' ? s.tabChipOn : ''
                            }`}
                            onClick={() => setRadarInner('buy')}
                        >
                            🔥 即時買盤
                        </button>
                        <button
                            type="button"
                            className={`${s.quickBtn} ${
                                radarInner === 'strong' ||
                                radarInner === 'heating' ||
                                radarInner === 'pullback'
                                    ? s.tabChipOn
                                    : ''
                            }`}
                            onClick={() => setRadarInner('strong')}
                        >
                            強度雷達
                        </button>
                    </div>
                    {radarInner === 'limit' ? (
                        <LimitUpPage onOpenSymbol={openSymbol} />
                    ) : radarInner === 'buy' ? (
                        <BuyPressurePage onOpenSymbol={openSymbol} />
                    ) : (
                        <RadarPage
                            feed={feed}
                            initialTab={radarInner}
                            selectedSymbol={detailSymbol}
                            onOpenSymbol={openSymbol}
                            onOpenSearch={onOpenSearch}
                        />
                    )}
                </>
            )}
            {tab === 'watch' && (
                <WatchPage
                    feed={feed}
                    favorites={favorites}
                    onOpenSymbol={openSymbol}
                    onGoBrokerRadar={() => {
                        setShowBrokerRadar(true);
                        if (!isDesktop) closeDetail();
                    }}
                />
            )}
            {tab === 'perf' && <PerformancePage />}
            {tab === 'more' && (
                <MorePage
                    feed={feed}
                    onOpenSearch={onOpenSearch}
                    onGoIntel={() => setShowIntel(true)}
                    onGoBrokerRadar={() => setShowBrokerRadar(true)}
                    onGoBuyPressure={() => setShowBuyPressure(true)}
                />
            )}
            <div className={s.pageEnd} />
                </>
            )}
        </>
    );

    const headerBlock = (
        <header className={s.header}>
            <div>
                <div className={s.brand}>
                    {isDesktop ? (
                        <>
                            股市小幫手
                            <span
                                style={{
                                    display: 'block',
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color: vars.color.mutedForeground,
                                    marginTop: 2,
                                }}
                            >
                                {tab === 'radar'
                                    ? '盤中強攻雷達'
                                    : 'AI 當沖雷達'}
                            </span>
                        </>
                    ) : tab === 'radar' ? (
                        '盤中強攻雷達'
                    ) : (
                        'AI 當沖雷達'
                    )}
                </div>
                <div className={s.headerMeta}>
                    {clock.date} {clock.time}
                    {feed.items.length > 0
                        ? ` · ${feed.items.length} 檔`
                        : ''}
                </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                    className={`${s.simBadge} ${isLiveFeed ? s.liveBadge : ''}`}
                >
                    {provider == null ? '連線中' : isSim ? '模擬' : '即時'}
                </span>
                <div
                    className={`${s.statusPill} ${s.liveVariants[statusLabel]}`}
                >
                    <span className={s.statusDot} />
                    {liveStatusLabel(statusLabel)}
                </div>
                <button
                    type="button"
                    className={s.iconBtn}
                    aria-label="通知"
                    style={{ position: 'relative', minWidth: 44, minHeight: 44 }}
                    onClick={() => setShowNotifications(true)}
                >
                    🔔
                    {unreadNotif > 0 && (
                        <span
                            style={{
                                position: 'absolute',
                                top: 4,
                                right: 4,
                                minWidth: 16,
                                height: 16,
                                borderRadius: 8,
                                background: radarColor.strong,
                                color: '#fff',
                                fontSize: 10,
                                fontWeight: 800,
                                lineHeight: '16px',
                                textAlign: 'center',
                                padding: '0 4px',
                            }}
                        >
                            {unreadNotif > 99 ? '99+' : unreadNotif}
                        </span>
                    )}
                </button>
                {onOpenSearch && (
                    <button
                        type="button"
                        className={s.iconBtn}
                        aria-label="搜尋"
                        onClick={onOpenSearch}
                    >
                        ⌕
                    </button>
                )}
            </div>
        </header>
    );

    const mockBanner = isSim ? (
        <div className={`${s.banner} ${s.bannerBad}`}>
            目前是模擬／備援資料，不是真實盤中報價。畫面可對，但不要當盤中訊號。
        </div>
    ) : null;

    const healthBanner =
        feed.healthNote && (
            <div
                className={`${s.banner} ${
                    statusLabel !== 'LIVE' ? s.bannerBad : ''
                }`}
            >
                {feed.healthNote}
                <button
                    type="button"
                    className={s.linkBtn}
                    style={{ display: 'block', padding: 0, marginTop: 4 }}
                    onClick={() => setTab('more')}
                >
                    查看詳情 ›
                </button>
            </div>
        );

    const detailInner = detailSymbol ? (
        <StockDetailPage
            item={detailItem!}
            favorite={favorites.includes(detailSymbol)}
            marketRegime={feed.taiwanRegime ?? feed.marketRegime}
            decision={feed.dsBySymbol[detailSymbol] ?? null}
            onBack={closeDetail}
            onToggleFavorite={setFavorites}
            onSelectCode={onSelectCode}
            desktop={isDesktop}
        />
    ) : null;

    const notifChrome = (
        <>
            {toastLayer}
            <NotificationCenter
                open={showNotifications}
                onClose={() => setShowNotifications(false)}
                onOpenSymbol={openSymbol}
                onUnreadChange={setUnreadNotif}
            />
        </>
    );

    if (isDesktop) {
        return (
            <>
                {notifChrome}
            <div className={s.desktopShell}>
                <aside className={s.sideNav}>
                    <div className={s.sideBrand}>
                        <div className={s.sideBrandMain}>股市小幫手</div>
                        <div className={s.sideBrandSub}>AI 當沖雷達</div>
                    </div>
                    {NAV.map((n) => (
                        <button
                            key={n.id}
                            type="button"
                            className={`${s.sideBtn} ${
                                tab === n.id ? s.sideBtnOn : ''
                            }`}
                            onClick={() => {
                                setTab(n.id);
                                if (n.id === 'radar') setRadarInner('limit');
                            }}
                        >
                            <span>{n.icon}</span>
                            {n.label}
                        </button>
                    ))}
                </aside>
                <div className={s.desktopMain}>
                    {headerBlock}
                    {mockBanner}
                    {healthBanner}
                    <div className={s.page}>{mainContent}</div>
                </div>
                <div className={s.detailPanel} style={{ minHeight: 0 }}>
                    {detailInner ?? (
                        <div className={s.empty}>
                            點選股票，詳情顯示於此
                        </div>
                    )}
                </div>
            </div>
            </>
        );
    }

    // Mobile: list OR detail (not both). Detail has fat back bar.
    if (detailSymbol) {
        return (
            <>
                {notifChrome}
            <div className={s.shell}>
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    {detailInner}
                </div>
                <div className={s.detailBackBar}>
                    <button
                        type="button"
                        className={s.btnGhost}
                        onClick={closeDetail}
                    >
                        ← 回列表
                    </button>
                    <button
                        type="button"
                        className={s.btnPrimary}
                        onClick={() => {
                            closeDetail();
                            setTab('radar');
                            setRadarInner('limit');
                        }}
                    >
                        回雷達
                    </button>
                </div>
            </div>
            </>
        );
    }

    return (
        <>
            {notifChrome}
        <div className={s.shell}>
            {headerBlock}
            {mockBanner}
            {healthBanner}
            <div className={s.page}>{mainContent}</div>
            <nav className={s.dock} aria-label="主導覽">
                {NAV.map((n) => (
                    <button
                        key={n.id}
                        type="button"
                        className={`${s.dockBtn} ${
                            tab === n.id ? s.dockBtnOn : ''
                        }`}
                        onClick={() => {
                            setTab(n.id);
                            if (n.id === 'radar') setRadarInner('limit');
                        }}
                    >
                        <span className={s.dockIcon}>{n.icon}</span>
                        {n.label}
                    </button>
                ))}
            </nav>
        </div>
        </>
    );
}

export function findRankItem(
    items: IntradayRankItemDto[],
    symbol: string,
): IntradayRankItemDto | undefined {
    return items.find((i) => i.symbol === symbol);
}

function stubRankItem(symbol: string, name?: string): IntradayRankItemDto {
    return {
        symbol,
        name: name ?? symbol,
        candidate_origin: 'lookup',
        candidate_sources: ['lookup'],
        rank: 0,
        rank_prev: null,
        rank_change: null,
        rank_velocity: null,
        intraday_score: 0,
        heat_score: 0,
        state: 'WATCH',
        change_pct: null,
        last_price: null,
        metrics: {
            return_1m: null,
            return_3m: null,
            momentum_acceleration: 0,
            volume_acceleration: null,
            vwap_pos_pct: null,
            relative_strength_score: 0,
            breakout_type: '',
            pullback_quality_score: 0,
            pullback_state: '',
        },
        risk: { chase_risk: '', invalid_price: null },
        events: [],
        reasons: ['尚無盤中即時資料'],
        risks: ['資料尚未載入，勿當即時訊號'],
        data_health: 'ok',
        data_blocked: false,
        updated_at: new Date().toISOString(),
    };
}

function buyPressureToRankItem(bp: BuyPressureItemDto): IntradayRankItemDto {
    return {
        symbol: bp.symbol,
        name: bp.name || bp.symbol,
        candidate_origin: bp.universe_source ?? 'buy_pressure',
        candidate_sources: ['buy_pressure'],
        rank: bp.rank ?? 0,
        rank_prev: bp.rank_prev,
        rank_change:
            bp.rank != null && bp.rank_prev != null
                ? bp.rank_prev - bp.rank
                : null,
        rank_velocity: bp.rank_velocity,
        intraday_score: bp.c_score ?? bp.radar_rank_score ?? 0,
        heat_score: bp.heat_score ?? 0,
        state: bp.primary_state || 'EMERGING',
        change_pct: bp.change_pct,
        last_price: bp.last_price,
        score_coverage_pct: bp.score_coverage_pct,
        score_confidence: bp.score_confidence,
        metrics: {
            return_1m: null,
            return_3m: bp.change_pct,
            momentum_acceleration: bp.momentum_acceleration ?? 0,
            volume_acceleration: bp.volume_acceleration,
            rvol_same_time: bp.rvol,
            vwap_pos_pct: bp.distance_from_vwap_pct,
            relative_strength_score: 0,
            breakout_type: bp.breakout_type ?? '',
            pullback_quality_score: 0,
            pullback_state: '',
        },
        risk: {
            chase_risk: bp.chase_risk,
            invalid_price: null,
        },
        events: (bp.events ?? []).map((e) => e.event_type),
        reasons: bp.discovery_reason ? [bp.discovery_reason] : [],
        risks: [
            ...(bp.overheated_note ? [bp.overheated_note] : []),
            ...(bp.events ?? []).some((e) => e.event_type === 'BID_CANCEL')
                ? ['買單抽單（誘多）']
                : [],
        ],
        data_health: bp.data_health || 'ok',
        data_blocked: false,
        updated_at: bp.updated_at || bp.last_updated,
    };
}
