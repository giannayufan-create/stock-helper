// src/components/radar-v2/simple-radar-page.tsx
// SIMPLE RADAR UI v2 — no frontend secondary stock picking / no UI caps.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    fetchRadarRescue,
    fetchRadarRescueRecall,
    type DailyRecallDto,
    type RescueBatchDto,
    type RescueCardDto,
} from '../../lib/radar-rescue';
import { radarColor } from './tokens';
import * as s from './radar.css';

type InnerTab = 'all' | 'active' | 'early' | 'pullback' | 'watch' | 'insufficient';

function newsLabel(state: string): string | null {
    switch (state) {
        case 'POSITIVE_CONFIRMED':
            return '📰 正向確認';
        case 'POSITIVE_UNCONFIRMED':
            return '📰 正向未確認';
        case 'NEGATIVE_CONFIRMED':
            return '📰 負向確認';
        case 'MIXED':
            return '📰 混合';
        default:
            return null;
    }
}

function layerDots(layers: RescueCardDto['layers']) {
    return (
        <span style={{ display: 'inline-flex', gap: 6, fontSize: 12 }}>
            <span title="個股">{layers.stock ? '●' : '○'} 個股</span>
            <span title="產業">{layers.sector ? '●' : '○'} 產業</span>
            <span title="市場">{layers.market ? '●' : '○'} 市場</span>
            <span title="新聞">{layers.news ? '●' : '○'} 新聞</span>
        </span>
    );
}

function dedupeCards(cards: RescueCardDto[]): RescueCardDto[] {
    const seen = new Set<string>();
    const out: RescueCardDto[] = [];
    for (const c of cards) {
        if (seen.has(c.symbol)) continue;
        seen.add(c.symbol);
        out.push(c);
    }
    return out;
}

function RescueCardView({
    card,
    mode,
    onOpen,
}: {
    card: RescueCardDto;
    mode: 'early' | 'active' | 'watch';
    onOpen: (sym: string) => void;
}) {
    const pct = card.change_pct;
    const pctStr =
        pct == null
            ? '—'
            : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    const badge =
        card.radar_state === 'EARLY'
            ? '↗ EARLY'
            : card.radar_state === 'ACTIVE'
              ? '🔥 ACTIVE'
              : card.radar_state === 'PULLBACK'
                ? '🟠 PULLBACK'
                : card.radar_state === 'INSUFFICIENT_DATA'
                  ? '⚠ 資料不足'
                  : '👀 WATCH';

    return (
        <button
            type="button"
            className={s.rowCard}
            onClick={() => onOpen(card.symbol)}
            style={{
                textAlign: 'left',
                width: '100%',
                display: 'block',
                padding: '12px 14px',
                marginBottom: 8,
                borderRadius: 12,
                border: `1px solid ${radarColor.glassBorder}`,
                background: radarColor.glass,
            }}
        >
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginBottom: 6,
                }}
            >
                <strong>
                    {badge} {card.name}{' '}
                    <span style={{ opacity: 0.7 }}>{card.symbol}</span>
                </strong>
                <span
                    style={{
                        color:
                            (pct ?? 0) >= 0
                                ? radarColor.strong
                                : radarColor.health,
                        fontWeight: 700,
                    }}
                >
                    {card.last_price ?? '—'} {pctStr}
                </span>
            </div>
            <div style={{ fontSize: 13, opacity: 0.9, marginBottom: 4 }}>
                {mode === 'early' ? (
                    <>
                        Trigger {Math.round(card.trigger_score)}
                        {card.rank != null && (
                            <>
                                {' '}
                                · Rank #{card.rank_prev ?? '—'} → #{card.rank}
                            </>
                        )}
                        {card.bp_score != null && (
                            <> · BP {Math.round(card.bp_score)}</>
                        )}
                    </>
                ) : (
                    <>
                        Opportunity {Math.round(card.opportunity_score)} · C{' '}
                        {card.c_score != null ? Math.round(card.c_score) : '—'} ·
                        BP{' '}
                        {card.bp_score != null
                            ? Math.round(card.bp_score)
                            : '—'}
                        {card.rank != null && (
                            <>
                                {' '}
                                · Rank #{card.rank}
                                {card.rank_change != null &&
                                    card.rank_change !== 0 && (
                                        <>
                                            {' '}
                                            {card.rank_change > 0 ? '↑' : '↓'}
                                            {Math.abs(card.rank_change)}
                                        </>
                                    )}
                            </>
                        )}
                        {' · '}Chase {card.chase_risk}
                    </>
                )}
            </div>
            <div style={{ marginBottom: 4 }}>{layerDots(card.layers)}</div>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
                {card.reasons.length
                    ? `原因：${card.reasons.join(' · ')}`
                    : null}
                {newsLabel(card.news_state)
                    ? ` · ${newsLabel(card.news_state)}`
                    : ''}
            </div>
        </button>
    );
}

export function SimpleRadarPage({
    onOpenSymbol,
}: {
    onOpenSymbol: (sym: string) => void;
}) {
    const [batch, setBatch] = useState<RescueBatchDto | null>(null);
    const [err, setErr] = useState<string | null>(null);
    // Default ALL — never land on an empty ACTIVE tab.
    const [tab, setTab] = useState<InnerTab>('all');
    const [recall, setRecall] = useState<DailyRecallDto | null>(null);

    const reload = useCallback(() => {
        void fetchRadarRescue()
            .then((b) => {
                setBatch(b);
                setErr(null);
            })
            .catch((e) =>
                setErr(e instanceof Error ? e.message : String(e)),
            );
        void fetchRadarRescueRecall()
            .then((r) => {
                if ('plus_3_count' in r) setRecall(r);
            })
            .catch(() => undefined);
    }, []);

    useEffect(() => {
        reload();
        const t = setInterval(reload, 8_000);
        return () => clearInterval(t);
    }, [reload]);

    const allCards = useMemo(() => {
        if (!batch) return [];
        return dedupeCards([
            ...batch.active,
            ...batch.early,
            ...batch.pullback,
            ...batch.watch,
            ...batch.insufficient,
        ]).sort(
            (a, b) =>
                (b.change_pct ?? -999) - (a.change_pct ?? -999) ||
                b.opportunity_score - a.opportunity_score,
        );
    }, [batch]);

    const focusCards = useMemo(() => {
        if (!batch) return [];
        const fromFocus = dedupeCards([
            ...batch.focus.confirmed,
            ...batch.focus.early,
        ]);
        if (fromFocus.length > 0) return fromFocus;
        // No focus slot left: show top movers from full list (no empty wall).
        return allCards.slice(0, 12);
    }, [batch, allCards]);

    const list: RescueCardDto[] = (() => {
        if (!batch) return [];
        if (tab === 'all') return allCards;
        if (tab === 'active') return batch.active;
        if (tab === 'early') return batch.early;
        if (tab === 'pullback') return batch.pullback;
        if (tab === 'watch') return batch.watch;
        return batch.insufficient;
    })();

    const sessionNote = (() => {
        if (!batch) return null;
        if (batch.market_status === 'AFTER_HOURS') {
            return '非交易時段：下方為收盤殘留名單（已取消畫面過濾上限）。';
        }
        return null;
    })();

    const totalCount = allCards.length;

    return (
        <div>
            <div
                style={{
                    padding: '10px 4px',
                    marginBottom: 8,
                    fontSize: 13,
                    opacity: 0.85,
                }}
            >
                資料 {batch?.data_status ?? '…'}
                {batch?.market_status
                    ? ` · ${
                          batch.market_status === 'CASH_LIVE'
                              ? '盤中'
                              : '休市'
                      }`
                    : ''}
                {batch?.as_of
                    ? ` · ${new Date(batch.as_of).toLocaleTimeString('zh-TW')}`
                    : ''}
                {totalCount > 0 ? ` · 共 ${totalCount} 檔` : ''}
                {err ? (
                    <div style={{ color: radarColor.healthBad }}>{err}</div>
                ) : null}
                {sessionNote ? (
                    <div
                        style={{
                            marginTop: 8,
                            padding: '8px 10px',
                            borderRadius: 8,
                            border: `1px solid ${radarColor.glassBorder}`,
                            background: radarColor.glass,
                            lineHeight: 1.45,
                        }}
                    >
                        {sessionNote}
                    </div>
                ) : null}
            </div>

            <section style={{ marginBottom: 16 }}>
                <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>
                    {batch?.market_status === 'AFTER_HOURS'
                        ? '收盤殘留｜優先觀察'
                        : '目前優先觀察'}
                </h3>
                {focusCards.length === 0 ? (
                    <div className={s.empty} style={{ padding: 16 }}>
                        {batch ? '名單載入中或尚無資料' : '讀取中…'}
                    </div>
                ) : (
                    focusCards.map((c) => (
                        <RescueCardView
                            key={`f-${c.symbol}`}
                            card={c}
                            mode={
                                c.radar_state === 'EARLY' ? 'early' : 'active'
                            }
                            onOpen={onOpenSymbol}
                        />
                    ))
                )}
            </section>

            <div className={s.quickBar} style={{ marginBottom: 12 }}>
                {(
                    [
                        ['all', '全部'],
                        ['active', '🔥 發動中'],
                        ['early', '↗ 剛轉強'],
                        ['pullback', '🟠 拉回'],
                        ['watch', '👀 觀察'],
                        ['insufficient', '⚠ 資料不足'],
                    ] as const
                ).map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        className={`${s.quickBtn} ${
                            tab === id ? s.tabChipOn : ''
                        }`}
                        onClick={() => setTab(id)}
                    >
                        {label}
                        {batch
                            ? ` ${
                                  id === 'all'
                                      ? totalCount
                                      : id === 'active'
                                        ? batch.count.active
                                        : id === 'early'
                                          ? batch.count.early
                                          : id === 'pullback'
                                            ? batch.count.pullback
                                            : id === 'watch'
                                              ? batch.count.watch
                                              : batch.insufficient.length
                              }`
                            : ''}
                    </button>
                ))}
            </div>

            {list.length === 0 ? (
                <div className={s.empty} style={{ padding: 24 }}>
                    {batch ? '此分類目前沒有標的，改看「全部」' : '讀取中…'}
                </div>
            ) : (
                list.map((c) => (
                    <RescueCardView
                        key={c.symbol}
                        card={c}
                        mode={
                            c.radar_state === 'EARLY'
                                ? 'early'
                                : c.radar_state === 'WATCH' ||
                                    c.radar_state === 'INSUFFICIENT_DATA'
                                  ? 'watch'
                                  : 'active'
                        }
                        onOpen={onOpenSymbol}
                    />
                ))
            )}

            {recall && (
                <section style={{ marginTop: 24, fontSize: 13 }}>
                    <h3 style={{ fontSize: 14 }}>今日達成率（Recall）</h3>
                    <div>+3% Truth：{recall.plus_3_count} 檔</div>
                    <div>Scanner {recall.scanner}</div>
                    <div>Discovery {recall.discovery}</div>
                    <div>Active {recall.active}</div>
                    <div>C {recall.c}</div>
                    <div>EARLY {recall.early}</div>
                    <div>ACTIVE {recall.active_state}</div>
                    <div>Focus {recall.focus}</div>
                    <div>UI {recall.ui}</div>
                    <div>
                        最大流失關卡：{recall.largest_recall_loss_stage}
                    </div>
                    {recall.missed.slice(0, 8).map((m) => (
                        <div key={m.symbol} style={{ opacity: 0.8 }}>
                            Missed {m.symbol} +{m.max_return_pct.toFixed(1)}% →{' '}
                            {m.first_drop_stage}/{m.first_drop_reason}
                        </div>
                    ))}
                </section>
            )}
        </div>
    );
}
