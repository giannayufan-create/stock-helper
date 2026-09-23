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

function stateRank(s: RescueCardDto['radar_state']): number {
    switch (s) {
        case 'PRE_ATTACK':
            return 90;
        case 'EARLY':
            return 80;
        case 'ACTIVE':
        case 'NEAR_LIMIT':
        case 'LIMIT_UP':
            return 85;
        case 'STALLING':
            return 55;
        case 'WATCH':
            return 50;
        case 'PULLBACK':
            return 40;
        case 'WEAKENING':
            return 20;
        case 'EARLY_FAILED':
        case 'FAKE_BREAKOUT':
            return 15;
        default:
            return 0;
    }
}

function attackSortKey(c: RescueCardDto): number {
    return (
        stateRank(c.radar_state) * 1000 +
        (c.true_ask_eating ? 40 : 0) +
        (c.pre_plus3 ? 40 : 0) +
        (Number.isFinite(c.push_efficiency) ? (c.push_efficiency ?? 0) * 0.5 : 0) +
        (Number.isFinite(c.ask_eating_quality)
            ? (c.ask_eating_quality ?? 0) * 0.35
            : 0) +
        (Number.isFinite(c.focus_score) ? c.focus_score : 0) +
        (Number.isFinite(c.trigger_score) ? c.trigger_score * 0.15 : 0) -
        (c.data_stale ? 200 : 0)
    );
}

function stateBadge(card: RescueCardDto): string {
    // Stale: last_valid_state is historical only — never show 正在急攻.
    if (card.data_stale || card.state_label === '資料過舊') {
        return '👀 資料過舊';
    }
    if (card.state_label) {
        const icon =
            card.radar_state === 'PRE_ATTACK'
                ? '⚡⚡'
                : card.radar_state === 'EARLY'
                  ? '⚡'
                  : card.radar_state === 'ACTIVE'
                    ? '🔥'
                    : card.radar_state === 'NEAR_LIMIT'
                      ? '🚀'
                      : card.radar_state === 'LIMIT_UP'
                        ? '🔒'
                        : card.radar_state === 'STALLING'
                          ? '⚠️'
                          : card.radar_state === 'EARLY_FAILED'
                            ? '⚠️'
                            : card.radar_state === 'FAKE_BREAKOUT'
                              ? '❌'
                              : card.radar_state === 'WEAKENING'
                                ? '🔻'
                                : card.radar_state === 'WATCH'
                                  ? '👀'
                                  : '';
        const ask =
            card.ask_eating_quality != null && card.ask_eating_quality > 0
                ? ` ASK ${Math.round(card.ask_eating_quality)}`
                : '';
        return `${icon} ${card.state_label}${ask}`.trim();
    }
    switch (card.radar_state) {
        case 'PRE_ATTACK':
            return '⚡⚡ 準備發動';
        case 'EARLY':
            return card.pre_plus3 ? '⚡ 漲3%前' : '⚡ EARLY';
        case 'ACTIVE':
            return '🔥 正在急攻';
        case 'NEAR_LIMIT':
            return '🚀 接近漲停';
        case 'LIMIT_UP':
            return '🔒 漲停';
        case 'STALLING':
            return '⚠️ 攻擊停滯';
        case 'EARLY_FAILED':
            return '⚠️ 吃單無效';
        case 'FAKE_BREAKOUT':
            return '❌ 假突破';
        case 'WEAKENING':
            return '🔻 動能轉弱';
        case 'PULLBACK':
            return '🟠 回踩';
        case 'INSUFFICIENT_DATA':
        case 'DATA_INCOMPLETE':
            return '⚠ 資料不足';
        case 'DATA_STALE':
            return '👀 資料過舊';
        default:
            return card.data_stale ? '👀 資料過舊' : '👀 異常加速';
    }
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
    const badge = stateBadge(card);

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
            {card.suggested_buy_price != null && !card.data_stale ? (
                <div
                    style={{
                        fontSize: 13,
                        fontWeight: 700,
                        marginBottom: 4,
                        color: radarColor.strong,
                    }}
                >
                    建議買進{' '}
                    {card.suggested_buy_zone_low != null &&
                    card.suggested_buy_zone_high != null &&
                    card.suggested_buy_zone_low !==
                        card.suggested_buy_zone_high
                        ? `${card.suggested_buy_zone_low}～${card.suggested_buy_zone_high}`
                        : card.suggested_buy_price}
                    {card.suggested_buy_note
                        ? ` · ${card.suggested_buy_note}`
                        : ''}
                </div>
            ) : null}
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
                attackSortKey(b) - attackSortKey(a) ||
                // Within same attack quality, prefer lower day-change (not chase %)
                (a.change_pct ?? 99) - (b.change_pct ?? 99),
        );
    }, [batch]);

    const focusCards = useMemo(() => {
        if (!batch) return [];
        const launch = allCards.filter(
            (c) =>
                c.radar_state === 'PRE_ATTACK' ||
                c.radar_state === 'EARLY' ||
                c.pre_plus3,
        );
        const fromFocus = dedupeCards([
            ...launch,
            ...batch.focus.early,
            ...batch.focus.confirmed,
        ]).sort((a, b) => attackSortKey(b) - attackSortKey(a));
        if (fromFocus.length > 0) return fromFocus;
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
                        ? '收盤殘留｜歷史訊號'
                        : '⚡ 漲3%前發動'}
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
                                c.radar_state === 'EARLY' ||
                                c.radar_state === 'PRE_ATTACK'
                                    ? 'early'
                                    : 'active'
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
                        ['active', '🔥 正在急攻'],
                        ['early', '⚡ 漲3%前'],
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
                            c.radar_state === 'EARLY' ||
                            c.radar_state === 'PRE_ATTACK'
                                ? 'early'
                                : c.radar_state === 'WATCH' ||
                                    c.radar_state === 'EARLY_FAILED' ||
                                    c.radar_state === 'WEAKENING' ||
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
