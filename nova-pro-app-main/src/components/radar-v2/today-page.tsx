import {
    fmtPctSigned,
    regimeMeta,
    sortHeating,
    sortPullback,
    sortStrong,
} from './helpers';
import * as s from './radar.css';
import { CompactStockRow, MiniHeatCard, MiniPullbackCard } from './stock-cards';
import type { RadarFeed } from './use-radar-feed';
import { vars } from '../../theme.css';

export function TodayPage({
    feed,
    selectedSymbol,
    onOpenSymbol,
    onGoRadar,
    onGoWatch,
    onSearch,
}: {
    feed: RadarFeed;
    selectedSymbol?: string | null;
    onOpenSymbol: (symbol: string) => void;
    onGoRadar: (tab?: string) => void;
    onGoWatch: () => void;
    onSearch?: () => void;
}) {
    const regime = regimeMeta(feed.marketRegime, feed.marketScore);
    // Always show strongest by C score — never leave first screen empty if data exists
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
                        {fmtPctSigned(feed.tpexPct)} · B{feed.passCount} C
                        {feed.strong} H{feed.heating}
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

            <div className={s.quickBar}>
                <button
                    type="button"
                    className={s.quickBtn}
                    onClick={() => onGoRadar('strong')}
                >
                    看雷達
                </button>
                <button type="button" className={s.quickBtn} onClick={onGoWatch}>
                    OPEN PASS
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
                        {onSearch && (
                            <button
                                type="button"
                                className={s.quickBtn}
                                style={{ marginTop: 8, width: '100%' }}
                                onClick={onSearch}
                            >
                                搜尋股票代碼
                            </button>
                        )}
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
                        <div
                            className={s.sectionTitle}
                            style={{ marginBottom: 0 }}
                        >
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
                        <div
                            className={s.sectionTitle}
                            style={{ marginBottom: 0 }}
                        >
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
