// src/components/radar-v2/today-decision-board.tsx
// One merged answer: what to look at today, and what to do about it.

import { useEffect, useMemo, useState } from 'react';
import {
    fetchTodayDecision,
    TODAY_ACTION_COLOR,
    type TodayDecisionBoardDto,
    type TodayDecisionItemDto,
} from '../../lib/today';
import { vars } from '../../theme.css';
import * as s from './radar.css';
import { RegulatoryChip, TrapChips } from './stock-flags';
import { openConfirmLabel } from './helpers';

const BOARD_TITLE: Record<string, string> = {
    PREOPEN: '盤前：夜盤結論＋開盤預想',
    OPENING: '開盤看這幾支',
    INTRADAY: '今天看這幾支',
    CLOSING: '今天看這幾支',
    AFTER_HOURS: '夜盤結論＋明日預備',
};

const CONFIDENCE_LABEL: Record<'HIGH' | 'MEDIUM' | 'LOW', string> = {
    HIGH: '資料完整',
    MEDIUM: '資料部分',
    LOW: '資料不足',
};

const CASH_IDS = new Set(['nasdaq', 'sox', 'spx', 'dow']);
const FUT_IDS = new Set(['nq_fut', 'es_fut', 'txf_night', 'twf_cme']);

function OvernightTape({
    overnight,
}: {
    overnight: TodayDecisionBoardDto['overnight'];
}) {
    const assets = overnight?.assets ?? [];
    const cash = assets.filter((a) => CASH_IDS.has(a.id));
    const fut = assets.filter((a) => FUT_IDS.has(a.id));
    const other = assets.filter(
        (a) => !CASH_IDS.has(a.id) && !FUT_IDS.has(a.id),
    );
    const hasTxf = fut.some((a) => a.id === 'txf_night');
    return (
        <div
            style={{
                marginTop: 10,
                paddingTop: 10,
                borderTop: `1px solid ${vars.color.border}`,
            }}
        >
            <div
                style={{
                    fontSize: 12,
                    fontWeight: 800,
                    marginBottom: 6,
                }}
            >
                夜盤動向
            </div>
            <div
                style={{
                    fontSize: 13,
                    fontWeight: 700,
                    lineHeight: 1.5,
                    color: overnight?.available
                        ? vars.color.foreground
                        : vars.color.mutedForeground,
                }}
            >
                {overnight?.headline ?? '夜盤指數尚未就緒'}
            </div>
            <AssetRow label="美股現貨收盤" items={cash} />
            <AssetRow label="夜盤期貨" items={fut} />
            <AssetRow label="其他" items={other} />
            {!hasTxf && (
                <div
                    style={{
                        marginTop: 6,
                        fontSize: 11,
                        color: vars.color.mutedForeground,
                    }}
                >
                    台指夜盤未接入（永豐夜盤報價尚未回來；海外台指期僅供參考）
                </div>
            )}
        </div>
    );
}

function AssetRow({
    label,
    items,
}: {
    label: string;
    items: Array<{ id: string; name?: string; change_pct: number | null }>;
}) {
    if (!items.length) return null;
    return (
        <div style={{ marginTop: 8 }}>
            <div
                style={{
                    fontSize: 11,
                    color: vars.color.mutedForeground,
                    marginBottom: 4,
                }}
            >
                {label}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {items.map((a) => {
                    const up = (a.change_pct ?? 0) >= 0;
                    return (
                        <span
                            key={a.id}
                            style={{
                                fontSize: 12,
                                fontFamily: vars.font.mono,
                                color:
                                    a.change_pct == null
                                        ? vars.color.mutedForeground
                                        : up
                                          ? vars.color.up
                                          : vars.color.down,
                            }}
                        >
                            {a.name ?? a.id}{' '}
                            {a.change_pct == null
                                ? '—'
                                : `${up ? '+' : ''}${a.change_pct.toFixed(2)}%`}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

function pct(v: number | null): string {
    if (v == null) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function ActionChip({ item }: { item: TodayDecisionItemDto }) {
    const color = TODAY_ACTION_COLOR[item.action];
    return (
        <span
            style={{
                background: `${color}1a`,
                color,
                border: `1px solid ${color}55`,
                borderRadius: 999,
                padding: '3px 10px',
                fontSize: 12,
                fontWeight: 800,
                whiteSpace: 'nowrap',
            }}
        >
            {item.action_label}
        </span>
    );
}

function DecisionRow({
    item,
    onOpenSymbol,
}: {
    item: TodayDecisionItemDto;
    onOpenSymbol: (symbol: string) => void;
}) {
    const color = TODAY_ACTION_COLOR[item.action];
    const up = (item.change_pct ?? 0) >= 0;
    return (
        <button
            type="button"
            onClick={() => onOpenSymbol(item.symbol)}
            style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                background: vars.color.panel,
                border: `1px solid ${vars.color.border}`,
                borderLeft: `4px solid ${color}`,
                borderRadius: 12,
                padding: '10px 12px',
                marginBottom: 8,
                cursor: 'pointer',
            }}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                }}
            >
                <span
                    style={{
                        fontSize: 13,
                        fontWeight: 800,
                        color: vars.color.mutedForeground,
                        minWidth: 18,
                    }}
                >
                    {item.rank}
                </span>
                <span style={{ fontSize: 16, fontWeight: 800 }}>
                    {item.symbol}
                </span>
                <span
                    style={{
                        fontSize: 13,
                        color: vars.color.mutedForeground,
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {item.name}
                </span>
                <RegulatoryChip symbol={item.symbol} />
                <TrapChips
                    flags={item.trap_flags}
                    penalty={item.trap_penalty}
                />
                <span
                    style={{
                        fontSize: 14,
                        fontWeight: 800,
                        color: up ? vars.color.up : vars.color.down,
                    }}
                >
                    {pct(item.change_pct)}
                </span>
                <ActionChip item={item} />
            </div>
            {item.sources.open_confirm && (
                <div
                    style={{
                        marginTop: 4,
                        fontSize: 11,
                        color: vars.color.mutedForeground,
                    }}
                >
                    開盤確認：{openConfirmLabel(item.sources.open_confirm)}
                </div>
            )}

            <div
                style={{
                    marginTop: 6,
                    fontSize: 13,
                    fontWeight: 600,
                    color: vars.color.foreground,
                }}
            >
                {item.action_hint}
            </div>

            {item.why.length > 0 && (
                <div
                    style={{
                        marginTop: 6,
                        fontSize: 12,
                        color: vars.color.mutedForeground,
                        lineHeight: 1.6,
                    }}
                >
                    {item.why.map((w) => (
                        <div key={w}>· {w}</div>
                    ))}
                </div>
            )}

            {item.risk.filter((r) => !r.includes('INSTITUTIONAL_RISK_PROXY'))
                .length > 0 && (
                <div
                    style={{
                        marginTop: 4,
                        fontSize: 12,
                        color: vars.color.down,
                        lineHeight: 1.6,
                    }}
                >
                    {item.risk
                        .filter((r) => !r.includes('INSTITUTIONAL_RISK_PROXY'))
                        .map((r) => (
                            <div key={r}>⚠ {r}</div>
                        ))}
                </div>
            )}

            <div
                style={{
                    marginTop: 8,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontSize: 11,
                    color: vars.color.mutedForeground,
                }}
            >
                <span
                    style={{
                        flex: 1,
                        height: 4,
                        borderRadius: 2,
                        background: vars.color.border,
                        overflow: 'hidden',
                    }}
                >
                    <span
                        style={{
                            display: 'block',
                            width: `${item.conviction}%`,
                            height: '100%',
                            background: color,
                        }}
                    />
                </span>
                <span>把握度 {item.conviction}</span>
                <span>{CONFIDENCE_LABEL[item.data_confidence]}</span>
            </div>

            {item.next_check && (
                <div
                    style={{
                        marginTop: 4,
                        fontSize: 11,
                        color: vars.color.mutedForeground,
                    }}
                >
                    下一步看：{item.next_check}
                </div>
            )}
        </button>
    );
}

export function TodayDecisionBoard({
    onOpenSymbol,
}: {
    onOpenSymbol: (symbol: string) => void;
}) {
    const [board, setBoard] = useState<TodayDecisionBoardDto | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = () =>
            void fetchTodayDecision(30)
                .then((b) => {
                    if (cancelled) return;
                    setBoard(b);
                    setError(null);
                })
                .catch((e: unknown) => {
                    if (cancelled) return;
                    setError(e instanceof Error ? e.message : '連線失敗');
                });
        load();
        const t = setInterval(load, 15_000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

    const hotItems = useMemo(() => {
        if (!board) return [];
        // No frontend secondary filter — trust backend actions.
        return board.items.slice(0, 16);
    }, [board]);

    const grouped = useMemo(() => {
        const buckets: Record<string, TodayDecisionItemDto[]> = {
            ACTIONABLE: [],
            WATCH: [],
            WAIT: [],
            AVOID: [],
        };
        for (const it of hotItems) {
            (buckets[it.action] ??= []).push(it);
        }
        return buckets;
    }, [hotItems]);

    if (!board) {
        return (
            <section className={s.section}>
                <div className={s.sectionTitle}>今天看這幾支</div>
                <div className={s.empty}>
                    {error ? `讀取失敗：${error}` : '讀取中…'}
                </div>
            </section>
        );
    }

    const isPreopen =
        board.mode === 'PREOPEN' || board.mode === 'AFTER_HOURS';

    return (
        <section className={s.section}>
            <div className={s.sectionRow}>
                <div className={s.sectionTitle}>
                    {BOARD_TITLE[board.mode] ?? '今天看這幾支'}
                </div>
                <span
                    style={{
                        fontSize: 11,
                        color: vars.color.mutedForeground,
                    }}
                >
                    {board.mode_label}
                </span>
            </div>

            <div
                className={s.glass}
                style={{
                    padding: '12px 14px',
                    borderRadius: 14,
                    marginBottom: 10,
                }}
            >
                {isPreopen && (
                    <div
                        style={{
                            fontSize: 12,
                            fontWeight: 800,
                            marginBottom: 6,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        ① 夜盤結論
                    </div>
                )}
                <div style={{ fontSize: 15, fontWeight: 800, lineHeight: 1.5 }}>
                    {board.headline}
                </div>
                <div
                    style={{
                        marginTop: 6,
                        fontSize: 12,
                        color: vars.color.mutedForeground,
                        lineHeight: 1.6,
                    }}
                >
                    {board.market_note}
                </div>
                <OvernightTape overnight={board.overnight} />
                <div
                    style={{
                        marginTop: 8,
                        display: 'flex',
                        gap: 12,
                        fontSize: 11,
                        color: vars.color.mutedForeground,
                        flexWrap: 'wrap',
                    }}
                >
                    {isPreopen ? (
                        <span>
                            {board.mode === 'PREOPEN'
                                ? '開盤預想'
                                : '明日預備'}{' '}
                            {board.items.length} 檔
                        </span>
                    ) : (
                        <>
                            <span>
                                可進場 {board.counts.actionable}
                            </span>
                            <span>只觀察 {board.counts.watch}</span>
                            <span>還沒成形 {board.counts.wait}</span>
                            <span>不要碰 {board.counts.avoid}</span>
                        </>
                    )}
                </div>
            </div>

            {isPreopen && (
                <div
                    style={{
                        fontSize: 13,
                        fontWeight: 800,
                        margin: '4px 0 8px',
                    }}
                >
                    ②{' '}
                    {board.mode === 'PREOPEN'
                        ? '開盤預想清單'
                        : '明日預備名單'}
                </div>
            )}

            {hotItems.length === 0 ? (
                <div className={s.empty}>
                    {board.not_ready_reason ?? '目前沒有符合條件的標的'}
                </div>
            ) : isPreopen ? (
                hotItems.map((it) => (
                    <DecisionRow
                        key={it.symbol}
                        item={it}
                        onOpenSymbol={onOpenSymbol}
                    />
                ))
            ) : (
                (
                    [
                        ['ACTIONABLE', '可進場'],
                        ['WATCH', '只觀察'],
                        ['WAIT', '還沒成形'],
                        ['AVOID', '不要碰'],
                    ] as const
                ).map(([key, label]) => {
                    const list = grouped[key] ?? [];
                    if (!list.length) return null;
                    return (
                        <div key={key} style={{ marginBottom: 12 }}>
                            <div
                                style={{
                                    fontSize: 12,
                                    fontWeight: 800,
                                    marginBottom: 6,
                                    color: TODAY_ACTION_COLOR[key],
                                }}
                            >
                                {label} · {list.length}
                            </div>
                            {list.map((it) => (
                                <DecisionRow
                                    key={it.symbol}
                                    item={it}
                                    onOpenSymbol={onOpenSymbol}
                                />
                            ))}
                        </div>
                    );
                })
            )}

            <div
                style={{
                    marginTop: 4,
                    fontSize: 11,
                    color: vars.color.mutedForeground,
                }}
            >
                {board.disclaimer}
            </div>
        </section>
    );
}
