// src/components/radar-v2/simple-radar-page.tsx
// SIMPLE RADAR UI v2 — no frontend secondary stock picking.

import { useCallback, useEffect, useState } from 'react';
import {
    fetchRadarRescue,
    fetchRadarRescueRecall,
    type DailyRecallDto,
    type RescueBatchDto,
    type RescueCardDto,
} from '../../lib/radar-rescue';
import { radarColor } from './tokens';
import * as s from './radar.css';

type InnerTab = 'active' | 'early' | 'pullback' | 'watch' | 'all';

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
    const [tab, setTab] = useState<InnerTab>('active');
    const [recall, setRecall] = useState<DailyRecallDto | null>(null);
    const [showAdvanced, setShowAdvanced] = useState(false);

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

    useEffect(() => {
        if (!batch) return;
        // After hours / empty ACTIVE: default to 觀察 so radar is not a blank page.
        if (
            tab === 'active' &&
            batch.count.active === 0 &&
            batch.count.watch > 0
        ) {
            setTab('watch');
        }
    }, [batch, tab]);

    const sessionNote = (() => {
        if (!batch) return null;
        if (batch.market_status === 'AFTER_HOURS') {
            return '非交易時段：下面是收盤殘留觀察，開盤後才會出現「發動中／可進場」。';
        }
        if (
            batch.data_status === 'DEGRADED' &&
            batch.count.active === 0 &&
            batch.count.watch > 0
        ) {
            return '資料降級中：先看觀察名單；條件齊全後會進「發動中」。';
        }
        return null;
    })();

    const list: RescueCardDto[] = (() => {
        if (!batch) return [];
        if (tab === 'active') return batch.active;
        if (tab === 'early') return batch.early;
        if (tab === 'pullback') return batch.pullback;
        if (tab === 'watch') return batch.watch;
        return [
            ...batch.active,
            ...batch.early,
            ...batch.pullback,
            ...batch.watch,
        ];
    })();

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

            {/* Focus */}
            <section style={{ marginBottom: 16 }}>
                <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>
                    {batch?.market_status === 'AFTER_HOURS'
                        ? '收盤殘留｜優先觀察'
                        : '目前優先觀察'}
                </h3>
                {(batch?.focus.confirmed.length ?? 0) === 0 &&
                (batch?.focus.early.length ?? 0) === 0 ? (
                    <div className={s.empty} style={{ padding: 16 }}>
                        {batch
                            ? '目前沒有符合條件的優先標的'
                            : '讀取中…'}
                    </div>
                ) : (
                    <>
                        {batch?.focus.confirmed.map((c) => (
                            <RescueCardView
                                key={`f-${c.symbol}`}
                                card={c}
                                mode="active"
                                onOpen={onOpenSymbol}
                            />
                        ))}
                        {batch?.focus.early.map((c) => (
                            <RescueCardView
                                key={`fe-${c.symbol}`}
                                card={c}
                                mode="early"
                                onOpen={onOpenSymbol}
                            />
                        ))}
                    </>
                )}
            </section>

            <div className={s.quickBar} style={{ marginBottom: 12 }}>
                {(
                    [
                        ['active', '🔥 發動中'],
                        ['early', '↗ 剛轉強'],
                        ['pullback', '🟠 拉回'],
                        ['watch', '👀 觀察'],
                        ['all', '全部'],
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
                                  id === 'active'
                                      ? batch.count.active
                                      : id === 'early'
                                        ? batch.count.early
                                        : id === 'pullback'
                                          ? batch.count.pullback
                                          : id === 'watch'
                                            ? batch.count.watch
                                            : batch.count.active +
                                              batch.count.early +
                                              batch.count.pullback +
                                              batch.count.watch
                              }`
                            : ''}
                    </button>
                ))}
            </div>

            {list.length === 0 ? (
                <div className={s.empty} style={{ padding: 24 }}>
                    目前沒有符合條件
                </div>
            ) : (
                list.map((c) => (
                    <RescueCardView
                        key={c.symbol}
                        card={c}
                        mode={
                            c.radar_state === 'EARLY'
                                ? 'early'
                                : c.radar_state === 'WATCH'
                                  ? 'watch'
                                  : 'active'
                        }
                        onOpen={onOpenSymbol}
                    />
                ))
            )}

            {(batch?.insufficient.length ?? 0) > 0 && (
                <section style={{ marginTop: 20, opacity: 0.55 }}>
                    <h3 style={{ fontSize: 14 }}>⚠ 資料不足</h3>
                    {batch!.insufficient.slice(0, 20).map((c) => (
                        <div key={c.symbol} style={{ fontSize: 12, padding: 4 }}>
                            {c.name} {c.symbol} · {c.radar_state}
                        </div>
                    ))}
                </section>
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
                    {recall.missed.slice(0, 5).map((m) => (
                        <div key={m.symbol} style={{ opacity: 0.8 }}>
                            Missed {m.symbol} +{m.max_return_pct.toFixed(1)}% →{' '}
                            {m.first_drop_stage}/{m.first_drop_reason}
                        </div>
                    ))}
                </section>
            )}

            <div style={{ marginTop: 16 }}>
                <button
                    type="button"
                    className={s.linkBtn}
                    onClick={() => setShowAdvanced((v) => !v)}
                >
                    {showAdvanced ? '收合進階篩選' : '進階篩選（預設關閉）'}
                </button>
                {showAdvanced && (
                    <div
                        style={{
                            fontSize: 12,
                            opacity: 0.7,
                            padding: 8,
                        }}
                    >
                        legacy onlyHot / minC / minHeat / looksLikeBoardMover
                        已移出主雷達，預設 OFF。切回舊 UI：設
                        VITE_RADAR_MODE=legacy。
                    </div>
                )}
            </div>
        </div>
    );
}
