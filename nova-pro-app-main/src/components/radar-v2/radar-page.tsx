import { useEffect, useMemo, useState } from 'react';
import {
    fetchRadarInterpretationScore,
    requestRadarInterpretation,
    type RadarAIInterpretationDto,
} from '../../lib/ai-interpretation';
import { vars } from '../../theme.css';
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
    const [radarAi, setRadarAi] = useState<RadarAIInterpretationDto | null>(
        null,
    );
    const [radarNarrative, setRadarNarrative] = useState<string | null>(null);
    const [radarAiLoading, setRadarAiLoading] = useState(false);
    const [radarAiError, setRadarAiError] = useState<string | null>(null);
    const [radarAiAt, setRadarAiAt] = useState<number | null>(null);
    const [radarSheetOpen, setRadarSheetOpen] = useState(false);

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

    const filterPayload = useMemo(
        () => ({
            tab,
            min_c: minC,
            min_heat: minHeat,
        }),
        [tab, minC, minHeat],
    );

    useEffect(() => {
        let cancelled = false;
        const symbols = list.map((i) => i.symbol);
        void fetchRadarInterpretationScore({
            filter: filterPayload,
            symbols,
        }).then((d) => {
            if (!cancelled && d) {
                setRadarAi(d);
                setRadarNarrative(null);
                setRadarAiError(null);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [list, filterPayload]);

    const runRadarAi = async () => {
        setRadarAiLoading(true);
        setRadarAiError(null);
        try {
            const result = await requestRadarInterpretation({
                filter: filterPayload,
                symbols: list.map((i) => i.symbol),
                snapshot_id: radarAi?.snapshot_id,
                with_llm: true,
            });
            if (!result) {
                setRadarAiError('AI 文字解讀暫時無法使用');
                return;
            }
            setRadarAi(result);
            setRadarNarrative(result.narrative ?? null);
            if (result.llm_error) setRadarAiError(result.llm_error);
            setRadarAiAt(Date.now());
            setRadarSheetOpen(true);
        } catch {
            setRadarAiError('AI 文字解讀暫時無法使用');
        } finally {
            setRadarAiLoading(false);
        }
    };

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

            {tab !== 'events' && (
                <div className={s.aiCard} style={{ margin: '8px 16px 12px' }}>
                    <div
                        style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: 8,
                            flexWrap: 'wrap',
                            marginBottom: 6,
                        }}
                    >
                        <strong style={{ color: radarColor.aiSoft }}>
                            ✨ AI 雷達綜合解讀
                        </strong>
                        <span
                            className={s.tag}
                            style={{ color: radarColor.aiSoft }}
                        >
                            不影響正式分數
                        </span>
                    </div>
                    {radarAi ? (
                        <>
                            <div
                                style={{
                                    fontSize: 32,
                                    fontWeight: 800,
                                    color: radarColor.aiSoft,
                                    lineHeight: 1.1,
                                }}
                            >
                                {radarAi.score.toFixed(1)}{' '}
                                <span style={{ fontSize: 16 }}>/ 10</span>
                            </div>
                            <div
                                style={{
                                    marginTop: 6,
                                    fontSize: 13,
                                    color: vars.color.mutedForeground,
                                }}
                            >
                                Confidence：{radarAi.confidence} · 符合{' '}
                                {radarAi.matched_count} 檔
                            </div>
                            <div
                                style={{
                                    marginTop: 8,
                                    fontSize: 14,
                                    lineHeight: 1.5,
                                }}
                            >
                                {radarAi.headline}
                            </div>
                            {radarAi.aggregate?.status_distribution && (
                                <div
                                    style={{
                                        marginTop: 10,
                                        fontSize: 12,
                                        color: vars.color.mutedForeground,
                                        display: 'grid',
                                        gridTemplateColumns: '1fr 1fr',
                                        gap: 4,
                                    }}
                                >
                                    <span>
                                        Confirmed{' '}
                                        {radarAi.aggregate.status_distribution
                                            .CONFIRMED_STRENGTH ?? 0}
                                    </span>
                                    <span>
                                        Watch{' '}
                                        {radarAi.aggregate.status_distribution
                                            .WATCH ?? 0}
                                    </span>
                                    <span>
                                        Extended{' '}
                                        {radarAi.aggregate.status_distribution
                                            .EXTENDED ?? 0}
                                    </span>
                                    <span>
                                        Not Ready{' '}
                                        {radarAi.aggregate.status_distribution
                                            .NOT_READY ?? 0}
                                    </span>
                                </div>
                            )}
                        </>
                    ) : (
                        <div
                            style={{
                                fontSize: 13,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            雷達解讀分數計算中…
                        </div>
                    )}
                    {radarAiError && (
                        <div
                            style={{
                                marginTop: 8,
                                fontSize: 13,
                                color: '#fca5a5',
                            }}
                        >
                            {radarAiError}
                        </div>
                    )}
                    <button
                        type="button"
                        className={s.aiBtn}
                        style={{ marginTop: 12 }}
                        disabled={radarAiLoading || list.length === 0}
                        onClick={() => void runRadarAi()}
                    >
                        {radarAiLoading
                            ? '解讀中…'
                            : '✨ AI 解讀目前雷達'}
                    </button>
                </div>
            )}

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

            {radarSheetOpen && radarAi && (
                <div
                    className={s.sheetMask}
                    role="presentation"
                    onClick={() => setRadarSheetOpen(false)}
                >
                    <div
                        className={s.sheet}
                        role="dialog"
                        onClick={(e) => e.stopPropagation()}
                        style={{
                            maxHeight: '85vh',
                            overflowY: 'auto',
                            paddingBottom: 'max(24px, env(safe-area-inset-bottom))',
                        }}
                    >
                        <div className={s.sheetTitle}>AI 雷達解讀</div>
                        <div
                            style={{
                                fontSize: 28,
                                fontWeight: 800,
                                color: radarColor.aiSoft,
                            }}
                        >
                            {radarAi.score.toFixed(1)} / 10
                        </div>
                        <div
                            style={{
                                marginTop: 6,
                                fontSize: 13,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            Confidence {radarAi.confidence} · 符合{' '}
                            {radarAi.matched_count} 檔
                            {radarAiAt
                                ? ` · ${new Date(radarAiAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`
                                : ''}
                        </div>
                        <p style={{ marginTop: 10, lineHeight: 1.55 }}>
                            {radarAi.headline}
                        </p>
                        <div style={{ marginTop: 12, fontSize: 13 }}>
                            <strong>篩選</strong>
                            <div>{radarAi.filter_summary}</div>
                        </div>
                        <div style={{ marginTop: 12, fontSize: 13 }}>
                            <strong>結構</strong>
                            <div>{radarAi.group_structure}</div>
                        </div>
                        <div style={{ marginTop: 12, fontSize: 13 }}>
                            <strong>共同優勢</strong>
                            <ul className={s.reasonList}>
                                {radarAi.common_strengths.map((x) => (
                                    <li key={x}>✓ {x}</li>
                                ))}
                            </ul>
                        </div>
                        <div style={{ marginTop: 12, fontSize: 13 }}>
                            <strong>尚缺確認</strong>
                            <ul className={s.reasonList}>
                                {radarAi.missing_confirmations.map((x) => (
                                    <li key={x}>△ {x}</li>
                                ))}
                            </ul>
                        </div>
                        <div style={{ marginTop: 12, fontSize: 13 }}>
                            <strong>產業</strong>
                            <div>{radarAi.sector_summary}</div>
                        </div>
                        <div style={{ marginTop: 12, fontSize: 13 }}>
                            <strong>市場</strong>
                            <div>{radarAi.market_summary}</div>
                        </div>
                        <div style={{ marginTop: 12, fontSize: 13 }}>
                            <strong>背離</strong>
                            <ul className={s.reasonList}>
                                {radarAi.divergence_flags.map((x) => (
                                    <li key={x}>⚠ {x}</li>
                                ))}
                            </ul>
                        </div>
                        <div style={{ marginTop: 12, fontSize: 13 }}>
                            <strong>資料</strong>
                            <div>{radarAi.data_quality_summary}</div>
                        </div>
                        {radarNarrative && (
                            <div
                                style={{
                                    marginTop: 14,
                                    fontSize: 14,
                                    lineHeight: 1.55,
                                    whiteSpace: 'pre-wrap',
                                }}
                            >
                                <strong>AI 解讀</strong>
                                <br />
                                {radarNarrative}
                            </div>
                        )}
                        <button
                            type="button"
                            className={s.aiBtn}
                            style={{ marginTop: 16 }}
                            onClick={() => void runRadarAi()}
                        >
                            重新解讀
                        </button>
                        <button
                            type="button"
                            className={s.btnGhost}
                            style={{ marginTop: 8, width: '100%', minHeight: 44 }}
                            onClick={() => setRadarSheetOpen(false)}
                        >
                            關閉
                        </button>
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
