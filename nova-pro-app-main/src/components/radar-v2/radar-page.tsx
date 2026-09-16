import { useEffect, useMemo, useState } from 'react';
import { sortHeating, sortPullback, sortStrong, eventLabel } from './helpers';
import * as s from './radar.css';
import { CompactStockRow } from './stock-cards';
import { radarColor } from './tokens';
import type { RadarFeed } from './use-radar-feed';

type RadarInnerTab = 'strong' | 'heating' | 'pullback' | 'events';

export function RadarPage({
    feed,
    initialTab = 'strong',
    selectedSymbol,
    onOpenSymbol,
    onOpenSearch,
}: {
    feed: RadarFeed;
    initialTab?: RadarInnerTab | string;
    selectedSymbol?: string | null;
    onOpenSymbol: (symbol: string) => void;
    onOpenSearch?: () => void;
}) {
    const [tab, setTab] = useState<RadarInnerTab>('strong');
    const [filterOpen, setFilterOpen] = useState(false);
    const [minC, setMinC] = useState(0);
    const [minHeat, setMinHeat] = useState(0);

    useEffect(() => {
        if (
            initialTab === 'strong' ||
            initialTab === 'heating' ||
            initialTab === 'pullback' ||
            initialTab === 'events'
        ) {
            setTab(initialTab);
        }
    }, [initialTab]);

    const filtered = useMemo(() => {
        return feed.items.filter(
            (i) =>
                i.intraday_score >= minC && (i.heat_score ?? 0) >= minHeat,
        );
    }, [feed.items, minC, minHeat]);

    const list = useMemo(() => {
        if (tab === 'strong') return sortStrong(filtered);
        if (tab === 'heating') return sortHeating(filtered);
        if (tab === 'pullback') {
            const pb = sortPullback(filtered);
            return pb.length ? pb : sortStrong(filtered).slice(0, 15);
        }
        return [];
    }, [tab, filtered]);

    return (
        <>
            <div className={s.sectionRow}>
                <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                    盤中強攻雷達
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                    <button
                        type="button"
                        className={s.iconBtn}
                        aria-label="重新整理"
                        onClick={() => feed.refresh()}
                    >
                        ↻
                    </button>
                    <button
                        type="button"
                        className={s.iconBtn}
                        aria-label="篩選"
                        onClick={() => setFilterOpen(true)}
                    >
                        ⚙
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
            </div>

            <div className={s.stickyTabs}>
                {(
                    [
                        ['strong', '最強'],
                        ['heating', '升溫'],
                        ['pullback', '回踩'],
                        ['events', '事件'],
                    ] as const
                ).map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        className={`${s.tabChip} ${tab === id ? s.tabChipOn : ''}`}
                        onClick={() => setTab(id)}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {tab === 'events' ? (
                <EventsList feed={feed} onOpenSymbol={onOpenSymbol} />
            ) : list.length === 0 ? (
                <div className={s.empty}>
                    此分頁暫無標的
                    <button
                        type="button"
                        className={s.quickBtn}
                        style={{ marginTop: 12, width: '100%' }}
                        onClick={() => {
                            setMinC(0);
                            setMinHeat(0);
                            feed.refresh();
                        }}
                    >
                        重設篩選並重新整理
                    </button>
                </div>
            ) : (
                list.map((item, i) => (
                    <CompactStockRow
                        key={item.symbol}
                        item={item}
                        rank={i + 1}
                        selected={selectedSymbol === item.symbol}
                        onOpen={onOpenSymbol}
                        enrich={{
                            bp: feed.bpBySymbol[item.symbol] ?? null,
                            sectorName:
                                feed.sectorBySymbol[item.symbol]?.name ?? null,
                            sectorRank:
                                feed.sectorBySymbol[item.symbol]?.rank ?? null,
                            sectorHeat:
                                feed.sectorBySymbol[item.symbol]?.heat ?? null,
                            sectorState:
                                feed.sectorBySymbol[item.symbol]?.state ?? null,
                            taiwanRegime: feed.taiwanRegime,
                            eventConfirmed: false,
                            decision: feed.dsBySymbol[item.symbol] ?? null,
                        }}
                    />
                ))
            )}

            {filterOpen && (
                <div
                    className={s.sheetMask}
                    role="presentation"
                    onClick={() => setFilterOpen(false)}
                >
                    <div
                        className={s.sheet}
                        role="dialog"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className={s.sheetTitle}>雷達篩選</div>
                        <label style={{ display: 'block', marginBottom: 12 }}>
                            <div style={{ fontSize: 13, marginBottom: 6 }}>
                                最低強度分數：{minC}
                            </div>
                            <input
                                type="range"
                                min={0}
                                max={90}
                                value={minC}
                                onChange={(e) => setMinC(Number(e.target.value))}
                                style={{ width: '100%' }}
                            />
                        </label>
                        <label style={{ display: 'block', marginBottom: 12 }}>
                            <div style={{ fontSize: 13, marginBottom: 6 }}>
                                最低熱度：{minHeat}
                            </div>
                            <input
                                type="range"
                                min={0}
                                max={95}
                                value={minHeat}
                                onChange={(e) =>
                                    setMinHeat(Number(e.target.value))
                                }
                                style={{ width: '100%' }}
                            />
                        </label>
                        <div className={s.sheetActions}>
                            <button
                                type="button"
                                className={s.btnGhost}
                                onClick={() => {
                                    setMinC(0);
                                    setMinHeat(0);
                                }}
                            >
                                重設
                            </button>
                            <button
                                type="button"
                                className={s.btnPrimary}
                                onClick={() => setFilterOpen(false)}
                            >
                                套用
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

function EventsList({
    feed,
    onOpenSymbol,
}: {
    feed: RadarFeed;
    onOpenSymbol: (symbol: string) => void;
}) {
    const [filter, setFilter] = useState<string | null>(null);
    const filters = [
        'SURGE',
        'BREAKOUT',
        'REBREAK',
        'RANK_JUMP',
        'PULLBACK_READY',
    ];
    const rows = feed.events.filter(
        (e) => !filter || e.event_type === filter,
    );

    return (
        <>
            <div className={s.hScroll} style={{ marginBottom: 12 }}>
                <button
                    type="button"
                    className={`${s.tabChip} ${!filter ? s.tabChipOn : ''}`}
                    onClick={() => setFilter(null)}
                >
                    全部
                </button>
                {filters.map((f) => (
                    <button
                        key={f}
                        type="button"
                        className={`${s.tabChip} ${filter === f ? s.tabChipOn : ''}`}
                        onClick={() => setFilter(f)}
                    >
                        {eventLabel(f)}
                    </button>
                ))}
            </div>
            {rows.length === 0 ? (
                <div className={s.empty}>尚無事件</div>
            ) : (
                rows.map((e, idx) => {
                    const t = new Date(e.timestamp);
                    const hh = t.toLocaleTimeString('zh-TW', {
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false,
                        timeZone: 'Asia/Taipei',
                    });
                    const icon =
                        e.event_type === 'SURGE'
                            ? '🔥'
                            : e.event_type === 'COOLING'
                              ? '⚠'
                              : '●';
                    return (
                        <button
                            key={`${e.symbol}-${e.timestamp}-${idx}`}
                            type="button"
                            className={s.eventRow}
                            style={{
                                width: '100%',
                                textAlign: 'left',
                                background: 'transparent',
                                border: 'none',
                                borderBottom: `1px solid ${radarColor.glassBorder}`,
                                color: 'inherit',
                                cursor: 'pointer',
                                minHeight: 56,
                            }}
                            onClick={() => onOpenSymbol(e.symbol)}
                        >
                            <div className={s.eventTime}>{hh}</div>
                            <div style={{ fontWeight: 700, fontSize: 15 }}>
                                {icon} {eventLabel(e.event_type)}
                            </div>
                            <div style={{ fontSize: 14, marginTop: 2 }}>
                                {e.symbol}
                                {e.rank != null ? ` · #${e.rank}` : ''}
                            </div>
                        </button>
                    );
                })
            )}
        </>
    );
}
