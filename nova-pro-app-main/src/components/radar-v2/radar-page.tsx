import { useEffect, useMemo, useState } from 'react';
import {
    fetchRadarInterpretationScore,
    requestRadarInterpretation,
    type RadarAIInterpretationDto,
} from '../../lib/ai-interpretation';
import { getApiPhase } from '../../lib/api-ready';
import {
    momentumLabel,
} from '../../lib/radar-quality';
import { vars } from '../../theme.css';
import {
    eventLabel,
    looksLikeBoardMover,
} from './helpers';
import * as s from './radar.css';
import { CompactStockRow } from './stock-cards';
import { radarColor } from './tokens';
import type { RadarFeed } from './use-radar-feed';

type RadarInnerTab = 'active' | 'pullback' | 'watch' | 'all' | 'events';
type InstFilter =
    | 'ALL'
    | 'FOREIGN_YDAY'
    | 'CONTINUATION'
    | 'DIVERGENCE';

export function RadarPage({
    feed,
    initialTab = 'active',
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
    const [tab, setTab] = useState<RadarInnerTab>('active');
    const [filterOpen, setFilterOpen] = useState(false);
    const [minC, setMinC] = useState(50);
    const [minHeat, setMinHeat] = useState(45);
    const [onlyHot, setOnlyHot] = useState(false);
    const [instFilter, setInstFilter] = useState<InstFilter>('ALL');
    const [radarAi, setRadarAi] = useState<RadarAIInterpretationDto | null>(
        null,
    );
    const [radarNarrative, setRadarNarrative] = useState<string | null>(null);
    const [radarAiLoading, setRadarAiLoading] = useState(false);
    const [radarAiError, setRadarAiError] = useState<string | null>(null);
    const [radarAiAt, setRadarAiAt] = useState<number | null>(null);
    const [radarSheetOpen, setRadarSheetOpen] = useState(false);

    useEffect(() => {
        const map: Record<string, RadarInnerTab> = {
            strong: 'active',
            heating: 'watch',
            pullback: 'pullback',
            events: 'events',
            active: 'active',
            watch: 'watch',
            all: 'all',
            buy: 'active',
        };
        if (initialTab && map[initialTab]) setTab(map[initialTab]!);
    }, [initialTab]);

    const filtered = useMemo(() => {
        return feed.items.filter((i) => {
            if (i.intraday_score < minC || (i.heat_score ?? 0) < minHeat) {
                return false;
            }
            if (
                onlyHot &&
                !looksLikeBoardMover({
                    changePct: i.adjusted_change_pct ?? i.change_pct,
                    heat: i.heat_score,
                    state: i.state,
                    bpState: feed.bpBySymbol[i.symbol]?.primary_state,
                })
            ) {
                return false;
            }
            const q = feed.rqBySymbol[i.symbol];
            if (instFilter === 'FOREIGN_YDAY') {
                const bg = q?.institutional?.background ?? '';
                return (
                    bg === 'FOREIGN_STRONG_ACCUMULATION' ||
                    bg === 'FOREIGN_ACCUMULATION' ||
                    bg === 'TRUST_ACCUMULATION'
                );
            }
            if (instFilter === 'CONTINUATION') {
                return (
                    q?.institutional?.continuation ===
                    'CONFIRMED_CONTINUATION'
                );
            }
            if (instFilter === 'DIVERGENCE') {
                const c = q?.institutional?.continuation;
                return c === 'DIVERGENCE' || c === 'REJECTED';
            }
            return true;
        });
    }, [
        feed.items,
        feed.rqBySymbol,
        feed.bpBySymbol,
        minC,
        minHeat,
        instFilter,
        onlyHot,
    ]);

    const list = useMemo(() => {
        const withQ = filtered.map((i) => ({
            item: i,
            q: feed.rqBySymbol[i.symbol],
        }));
        if (tab === 'active') {
            return withQ
                .filter(
                    (x) =>
                        x.q?.momentum_state === 'ACTIVE' ||
                        x.q?.momentum_state === 'PULLBACK',
                )
                .filter((x) => {
                    // Default ACTIVE tab: ACTIVE + clear PULLBACK_READY only
                    if (x.q?.momentum_state === 'ACTIVE') return true;
                    const ev = (x.item.events ?? []).map((e) =>
                        String(e).toUpperCase(),
                    );
                    return (
                        x.q?.momentum_state === 'PULLBACK' &&
                        (ev.includes('PULLBACK_READY') ||
                            (x.item.metrics?.pullback_state ?? '')
                                .toUpperCase()
                                .includes('READY'))
                    );
                })
                .sort(
                    (a, b) =>
                        (b.q?.focus_score ?? 0) - (a.q?.focus_score ?? 0),
                )
                .map((x) => x.item);
        }
        if (tab === 'pullback') {
            return withQ
                .filter((x) => x.q?.momentum_state === 'PULLBACK')
                .map((x) => x.item);
        }
        if (tab === 'watch') {
            return withQ
                .filter((x) => x.q?.momentum_state === 'WATCH')
                .map((x) => x.item);
        }
        if (tab === 'all') {
            return withQ
                .filter((x) => {
                    const m = x.q?.momentum_state;
                    if (onlyHot) {
                        return (
                            m === 'ACTIVE' ||
                            m === 'PULLBACK' ||
                            m === 'WATCH'
                        );
                    }
                    return (
                        m === 'ACTIVE' ||
                        m === 'PULLBACK' ||
                        m === 'WATCH' ||
                        m === 'INACTIVE' ||
                        !x.q
                    );
                })
                .sort(
                    (a, b) =>
                        (b.q?.focus_score ?? -1) - (a.q?.focus_score ?? -1),
                )
                .map((x) => x.item);
        }
        return [];
    }, [tab, filtered, feed.rqBySymbol, onlyHot]);

    const filterPayload = useMemo(
        () => ({
            tab,
            min_c: minC,
            min_heat: minHeat,
            only_hot: onlyHot,
            inst_filter: instFilter,
        }),
        [tab, minC, minHeat, instFilter, onlyHot],
    );

    const counts = feed.rqCounts;

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
        if (getApiPhase() !== 'ready' || list.length === 0) {
            setRadarAiError(
                getApiPhase() !== 'ready'
                    ? '後端還沒連上，請稍候再按'
                    : '目前沒有雷達標的',
            );
            return;
        }
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
            setRadarAiError(null);
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
                        ['active', '🔥 正在發動'],
                        ['pullback', '🟠 回踩'],
                        ['watch', '👀 等待'],
                        ['all', '全部'],
                        ['events', '事件'],
                    ] as const
                ).map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        className={`${s.tabChip} ${tab === id ? s.tabChipOn : ''}`}
                        onClick={() => setTab(id)}
                        style={{ minHeight: 44 }}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {tab !== 'events' && feed.focusTop3.length > 0 && (
                <div className={s.section} style={{ marginTop: 4 }}>
                    <div className={s.sectionTitle}>目前優先觀察</div>
                    {feed.focusTop3.map((f) => {
                        const item = feed.items.find(
                            (i) => i.symbol === f.symbol,
                        );
                        if (!item) {
                            return (
                                <button
                                    key={f.symbol}
                                    type="button"
                                    className={s.radarCard}
                                    style={{ minHeight: 44 }}
                                    onClick={() => onOpenSymbol(f.symbol)}
                                >
                                    <strong>
                                        FOCUS #{f.focus_rank} {f.symbol}{' '}
                                        {f.name}
                                    </strong>
                                    <div
                                        style={{
                                            fontSize: 12,
                                            color: vars.color.mutedForeground,
                                            marginTop: 4,
                                        }}
                                    >
                                        {momentumLabel(f.momentum_state)} · Raw
                                        Rank{' '}
                                        {f.raw_rank != null
                                            ? `#${f.raw_rank}`
                                            : '—'}
                                    </div>
                                    <div
                                        style={{
                                            fontSize: 12,
                                            marginTop: 4,
                                        }}
                                    >
                                        {f.reasons.slice(0, 4).join(' · ')}
                                    </div>
                                </button>
                            );
                        }
                        return (
                            <CompactStockRow
                                key={f.symbol}
                                item={item}
                                rank={f.focus_rank}
                                selected={selectedSymbol === f.symbol}
                                onOpen={onOpenSymbol}
                                enrich={{
                                    bp: feed.bpBySymbol[f.symbol] ?? null,
                                    sectorName:
                                        feed.sectorBySymbol[f.symbol]?.name ??
                                        null,
                                    sectorRank:
                                        feed.sectorBySymbol[f.symbol]?.rank ??
                                        null,
                                    sectorHeat:
                                        feed.sectorBySymbol[f.symbol]?.heat ??
                                        null,
                                    sectorState:
                                        feed.sectorBySymbol[f.symbol]?.state ??
                                        null,
                                    taiwanRegime: feed.taiwanRegime,
                                    decision: feed.dsBySymbol[f.symbol] ?? null,
                                    quality: feed.rqBySymbol[f.symbol] ?? null,
                                }}
                            />
                        );
                    })}
                </div>
            )}

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
                    {counts && (
                        <div
                            style={{
                                fontSize: 13,
                                color: vars.color.mutedForeground,
                                marginBottom: 8,
                                lineHeight: 1.5,
                            }}
                        >
                            符合篩選約 {filtered.length} 檔；ACTIVE{' '}
                            {counts.active} · PULLBACK {counts.pullback} ·
                            WATCH {counts.watch} · INACTIVE {counts.inactive}
                            。並非全部都在轉強。
                        </div>
                    )}
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
                                {counts
                                    ? ` · 其中 ACTIVE ${counts.active}`
                                    : ''}
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
                        style={{ marginTop: 12, minHeight: 44 }}
                        disabled={
                            radarAiLoading ||
                            list.length === 0 ||
                            feed.liveStatus === 'WAKING' ||
                            feed.liveStatus === 'DISCONNECTED'
                        }
                        onClick={() => void runRadarAi()}
                    >
                        {radarAiLoading
                            ? '解讀中…'
                            : feed.liveStatus === 'WAKING'
                              ? '載入中…'
                              : feed.liveStatus === 'DISCONNECTED'
                                ? '尚未連上後端'
                                : list.length === 0
                                  ? '目前沒有雷達標的'
                                  : '✨ AI 解讀目前雷達'}
                    </button>
                </div>
            )}

            {tab === 'events' ? (
                <EventsList feed={feed} onOpenSymbol={onOpenSymbol} />
            ) : list.length === 0 ? (
                <div className={s.empty}>
                    {feed.liveStatus === 'WAKING'
                        ? '正在載入雷達'
                        : feed.liveStatus === 'DISCONNECTED'
                          ? '還沒連上後端，請到「今日」按重新連線'
                          : '此分頁暫無標的'}
                    <button
                        type="button"
                        className={s.quickBtn}
                        style={{ marginTop: 12, width: '100%', minHeight: 44 }}
                        onClick={() => {
                            if (
                                feed.liveStatus === 'DISCONNECTED' ||
                                feed.liveStatus === 'WAKING'
                            ) {
                                feed.refresh();
                                return;
                            }
                            setOnlyHot(false);
                            setMinC(0);
                            setMinHeat(0);
                            setInstFilter('ALL');
                            feed.refresh();
                        }}
                    >
                        {feed.liveStatus === 'DISCONNECTED'
                            ? '重新連線'
                            : feed.liveStatus === 'WAKING'
                              ? '重新整理'
                              : '顯示全部標的'}
                    </button>
                </div>
            ) : (
                list.map((item, i) => (
                    <CompactStockRow
                        key={item.symbol}
                        item={item}
                        rank={item.rank ?? i + 1}
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
                            quality: feed.rqBySymbol[item.symbol] ?? null,
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
                        <button
                            type="button"
                            className={`${s.quickBtn} ${onlyHot ? s.tabChipOn : ''}`}
                            style={{ marginBottom: 12, minHeight: 44 }}
                            onClick={() => setOnlyHot((v) => !v)}
                        >
                            {onlyHot ? '只要強勢（已開）' : '只要強勢（已關）'}
                        </button>
                        <label style={{ display: 'block', marginBottom: 12 }}>
                            <div style={{ fontSize: 13, marginBottom: 6 }}>
                                法人續強
                            </div>
                            <div
                                style={{
                                    display: 'flex',
                                    flexWrap: 'wrap',
                                    gap: 8,
                                }}
                            >
                                {(
                                    [
                                        ['ALL', '全部'],
                                        ['FOREIGN_YDAY', '昨日外資大買'],
                                        ['CONTINUATION', '今日續強確認'],
                                        ['DIVERGENCE', '法人背景背離'],
                                    ] as const
                                ).map(([id, label]) => (
                                    <button
                                        key={id}
                                        type="button"
                                        className={`${s.tabChip} ${instFilter === id ? s.tabChipOn : ''}`}
                                        style={{ minHeight: 44 }}
                                        onClick={() => setInstFilter(id)}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                            <div
                                style={{
                                    fontSize: 11,
                                    color: vars.color.mutedForeground,
                                    marginTop: 6,
                                }}
                            >
                                昨日官方法人資料（Previous-Day），非即時外資身份；不改
                                Raw Rank。
                            </div>
                        </label>
                        <div className={s.sheetActions}>
                            <button
                                type="button"
                                className={s.btnGhost}
                                style={{ minHeight: 44 }}
                                onClick={() => {
                                    setMinC(50);
                                    setMinHeat(45);
                                    setOnlyHot(true);
                                    setInstFilter('ALL');
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
