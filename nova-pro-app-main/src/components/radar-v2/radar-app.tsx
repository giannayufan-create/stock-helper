import { useEffect, useMemo, useState } from 'react';
import {
    fetchMarketConfig,
    type IntradayRankItemDto,
} from '../../lib/backend';
import { useMediaQuery } from '../../hooks/use-media-query';
import type { ContractInfo } from '../../lib/types/contract';
import type { Snapshot } from '../../lib/types/market';
import { vars } from '../../theme.css';
import { loadFavorites } from './favorites';
import { liveStatusLabel, taipeiClock } from './helpers';
import { MorePage } from './more-page';
import { IntelPage } from './intel-page';
import { BrokerRadarPage } from './broker-radar-page';
import { PerformancePage } from './performance-page';
import * as s from './radar.css';
import { RadarPage } from './radar-page';
import { StockDetailPage } from './stock-detail';
import { TodayPage } from './today-page';
import type { LiveStatus, RadarTab } from './tokens';
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
    const feed = useRadarFeed(5000);
    const [tab, setTab] = useState<RadarTab>('radar');
    const [radarInner, setRadarInner] = useState<string>('strong');
    const [detailSymbol, setDetailSymbol] = useState<string | null>(null);
    const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
    const [clock, setClock] = useState(() => taipeiClock());
    const [provider, setProvider] = useState<'mock' | 'fugle' | 'shioaji' | null>(
        null,
    );
    const [showIntel, setShowIntel] = useState(false);
    const [showBrokerRadar, setShowBrokerRadar] = useState(false);

    useEffect(() => {
        const t = setInterval(() => setClock(taipeiClock()), 15_000);
        return () => clearInterval(t);
    }, []);

    useEffect(() => {
        void fetchMarketConfig()
            .then((c) => setProvider(c.provider))
            .catch(() => setProvider(null));
    }, []);

    // Auto-open first stock on desktop when list arrives
    useEffect(() => {
        if (!isDesktop || detailSymbol || !feed.items.length) return;
        setDetailSymbol(feed.items[0]!.symbol);
    }, [isDesktop, feed.items, detailSymbol]);

    const detailItem = useMemo(
        () => feed.items.find((i) => i.symbol === detailSymbol) ?? null,
        [feed.items, detailSymbol],
    );

    const openSymbol = (symbol: string) => {
        setDetailSymbol(symbol);
        void onSelectCode(symbol);
    };

    const closeDetail = () => setDetailSymbol(null);

    const statusLabel: LiveStatus = feed.liveStatus;
    const isSim = provider === 'mock' || provider == null;

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
                        setRadarInner(inner ?? 'strong');
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
                <RadarPage
                    feed={feed}
                    initialTab={radarInner}
                    selectedSymbol={detailSymbol}
                    onOpenSymbol={openSymbol}
                    onOpenSearch={onOpenSearch}
                />
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
                    className={`${s.simBadge} ${!isSim ? s.liveBadge : ''}`}
                >
                    {isSim ? '模擬' : '即時'}
                </span>
                <div
                    className={`${s.statusPill} ${s.liveVariants[statusLabel]}`}
                >
                    <span className={s.statusDot} />
                    {liveStatusLabel(statusLabel)}
                </div>
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
        detailItem ? (
            <StockDetailPage
                item={detailItem}
                favorite={favorites.includes(detailSymbol)}
                marketRegime={feed.marketRegime}
                onBack={closeDetail}
                onToggleFavorite={setFavorites}
                onSelectCode={onSelectCode}
                desktop={isDesktop}
            />
        ) : (
            <div className={isDesktop ? s.detailPanel : undefined}>
                <header className={s.detailHeader}>
                    {!isDesktop && (
                        <button
                            type="button"
                            className={s.iconBtn}
                            onClick={closeDetail}
                        >
                            ←
                        </button>
                    )}
                    <div className={s.symCode}>{detailSymbol}</div>
                </header>
                <div className={s.empty}>
                    此代號不在目前雷達池。
                    <button
                        type="button"
                        className={s.quickBtn}
                        style={{ marginTop: 12, width: '100%' }}
                        onClick={closeDetail}
                    >
                        回到列表
                    </button>
                </div>
            </div>
        )
    ) : null;

    if (isDesktop) {
        return (
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
                                if (n.id === 'radar') setRadarInner('strong');
                            }}
                        >
                            <span>{n.icon}</span>
                            {n.label}
                        </button>
                    ))}
                </aside>
                <div className={s.desktopMain}>
                    {headerBlock}
                    {healthBanner}
                    <div className={s.page}>{mainContent}</div>
                </div>
                <div className={s.detailPanel}>
                    {detailInner ?? (
                        <div className={s.empty}>
                            點選股票，詳情顯示於此
                        </div>
                    )}
                </div>
            </div>
        );
    }

    // Mobile: list OR detail (not both). Detail has fat back bar.
    if (detailSymbol) {
        return (
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
                            setRadarInner('strong');
                        }}
                    >
                        回雷達
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className={s.shell}>
            {headerBlock}
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
                            if (n.id === 'radar') setRadarInner('strong');
                        }}
                    >
                        <span className={s.dockIcon}>{n.icon}</span>
                        {n.label}
                    </button>
                ))}
            </nav>
        </div>
    );
}

export function findRankItem(
    items: IntradayRankItemDto[],
    symbol: string,
): IntradayRankItemDto | undefined {
    return items.find((i) => i.symbol === symbol);
}
