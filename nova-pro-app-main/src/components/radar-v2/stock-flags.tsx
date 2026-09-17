// src/components/radar-v2/stock-flags.tsx
// Shared 注意股 / 處置股 / 騙線 chips — keep labels in one place.

import type { CSSProperties } from 'react';
import { useRegulatoryFlag } from '../../lib/regulatory';
import { vars } from '../../theme.css';

export const TRAP_FLAG_LABEL: Record<string, string> = {
    FADE_FROM_HIGH: '開高走低',
    FAILED_BREAKOUT: '假突破',
    THIN_BREAKOUT: '無量突破',
    NEAR_LIMIT_UP: '接近漲停',
    UPPER_WICK: '上影線誘多',
};

export const BP_EVENT_LABEL: Record<string, string> = {
    EARLY_ENTER: '買盤轉早',
    BUY_SURGE: '買盤湧現',
    ASK_EATING: '吃賣單',
    ASK_CANCEL: '賣單抽單',
    BID_CANCEL: '買單抽單（誘多）',
    VOLUME_BREAKOUT: '放量突破',
    LARGE_BID_APPEAR: '大額委買',
    RANK_ACCELERATION: '排名加速',
    OVERHEATED: '過熱',
    COOLING: '轉弱',
};

const chipBase: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 999,
    padding: '1px 8px',
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: '0.02em',
    whiteSpace: 'nowrap',
};

export function RegulatoryChip({ symbol }: { symbol: string }) {
    const flag = useRegulatoryFlag(symbol);
    if (!flag) return null;
    const punish = flag === 'punish';
    return (
        <span
            style={{
                ...chipBase,
                background: punish ? '#7f1d1d' : '#78350f',
                color: punish ? '#fecaca' : '#fde68a',
                border: `1px solid ${punish ? '#f87171' : '#fbbf24'}`,
            }}
        >
            {punish ? '處置股' : '注意股'}
        </span>
    );
}

export function TrapChips({
    flags,
    penalty,
}: {
    flags?: string[] | null;
    penalty?: number | null;
}) {
    if (!flags?.length) return null;
    return (
        <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
            {flags.map((f) => (
                <span
                    key={f}
                    style={{
                        ...chipBase,
                        background: '#3f1d1d',
                        color: '#fecaca',
                        border: `1px solid ${vars.color.down}88`,
                    }}
                >
                    {TRAP_FLAG_LABEL[f] ?? f}
                </span>
            ))}
            {penalty != null && penalty > 0 ? (
                <span
                    style={{
                        ...chipBase,
                        color: vars.color.mutedForeground,
                        border: `1px solid ${vars.color.border}`,
                    }}
                >
                    騙線 −{penalty}
                </span>
            ) : null}
        </span>
    );
}

export function RiskLines({ risks }: { risks?: string[] | null }) {
    if (!risks?.length) return null;
    return (
        <div
            style={{
                marginTop: 6,
                fontSize: 12,
                color: vars.color.down,
                lineHeight: 1.55,
            }}
        >
            {risks.slice(0, 4).map((r) => (
                <div key={r}>⚠ {r}</div>
            ))}
        </div>
    );
}
