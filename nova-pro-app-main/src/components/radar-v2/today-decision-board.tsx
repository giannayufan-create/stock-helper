// src/components/radar-v2/today-decision-board.tsx
// One merged answer: what to look at today, and what to do about it.

import { useEffect, useState } from 'react';
import {
    fetchTodayDecision,
    TODAY_ACTION_COLOR,
    type TodayDecisionBoardDto,
    type TodayDecisionItemDto,
} from '../../lib/today';
import { vars } from '../../theme.css';
import * as s from './radar.css';
import { RegulatoryChip, TrapChips } from './stock-flags';

const CONFIDENCE_LABEL: Record<'HIGH' | 'MEDIUM' | 'LOW', string> = {
    HIGH: '資料完整',
    MEDIUM: '資料部分',
    LOW: '資料不足',
};

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

            {item.risk.length > 0 && (
                <div
                    style={{
                        marginTop: 4,
                        fontSize: 12,
                        color: vars.color.down,
                        lineHeight: 1.6,
                    }}
                >
                    {item.risk.map((r) => (
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
            void fetchTodayDecision(12)
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
        const t = setInterval(load, 10_000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

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

    return (
        <section className={s.section}>
            <div className={s.sectionRow}>
                <div className={s.sectionTitle}>今天看這幾支</div>
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
                {board.overnight?.available && (
                    <div
                        style={{
                            marginTop: 4,
                            fontSize: 12,
                            color: vars.color.mutedForeground,
                            lineHeight: 1.6,
                        }}
                    >
                        昨夜：{board.overnight.headline}
                    </div>
                )}
                <div
                    style={{
                        marginTop: 8,
                        display: 'flex',
                        gap: 12,
                        fontSize: 11,
                        color: vars.color.mutedForeground,
                    }}
                >
                    <span>可進場 {board.counts.actionable}</span>
                    <span>觀察 {board.counts.watch}</span>
                    <span>未成形 {board.counts.wait}</span>
                    <span>避開 {board.counts.avoid}</span>
                </div>
            </div>

            {board.items.length === 0 ? (
                <div className={s.empty}>
                    {board.not_ready_reason ?? '目前沒有名單'}
                </div>
            ) : (
                board.items.map((it) => (
                    <DecisionRow
                        key={it.symbol}
                        item={it}
                        onOpenSymbol={onOpenSymbol}
                    />
                ))
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
