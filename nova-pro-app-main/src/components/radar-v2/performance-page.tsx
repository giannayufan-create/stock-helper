import { useState } from 'react';
import { vars } from '../../theme.css';
import * as s from './radar.css';
import { radarColor } from './tokens';

/** Phase 3 shell — Signals / Shadow / History placeholders. */
export function PerformancePage() {
    const [tab, setTab] = useState<'signals' | 'shadow' | 'history'>('signals');

    return (
        <>
            <div className={s.sectionTitle}>訊號驗證</div>
            <div className={s.stickyTabs}>
                {(
                    [
                        ['signals', 'Signals'],
                        ['shadow', 'Shadow'],
                        ['history', 'History'],
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

            {tab === 'signals' && (
                <div className={s.glass} style={{ padding: 16 }}>
                    <div style={{ fontSize: 14, color: vars.color.mutedForeground }}>
                        過去 30 日 Outcome（Phase 3 接線）
                    </div>
                    <div className={s.twoCol} style={{ marginTop: 14 }}>
                        <Metric lab="Signals" val="—" />
                        <Metric lab="15m Positive" val="—" />
                        <Metric lab="Avg MFE" val="—" />
                        <Metric lab="Avg MAE" val="—" />
                    </div>
                    <p
                        style={{
                            marginTop: 14,
                            fontSize: 13,
                            color: vars.color.mutedForeground,
                            lineHeight: 1.5,
                        }}
                    >
                        使用 Positive Rate / Signal Outcome，不顯示勝率或獲利率。
                    </p>
                </div>
            )}

            {tab === 'shadow' && (
                <div
                    className={s.glass}
                    style={{
                        padding: 16,
                        borderColor: 'rgba(168, 85, 247, 0.4)',
                        background: radarColor.shadowDim,
                    }}
                >
                    <div
                        style={{
                            fontSize: 18,
                            fontWeight: 700,
                            color: radarColor.shadow,
                            marginBottom: 6,
                        }}
                    >
                        Shadow Lab
                    </div>
                    <div style={{ fontSize: 13, color: vars.color.mutedForeground }}>
                        正式版 vs 候選版 · Research Mode
                        <br />
                        不影響正式判斷
                    </div>
                    <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
                        {['B  78 → 81', 'C  80/74 → 82/76', 'B+C  Combined'].map(
                            (label) => (
                                <div
                                    key={label}
                                    className={s.glass}
                                    style={{ padding: 12 }}
                                >
                                    <div style={{ fontWeight: 700 }}>{label}</div>
                                    <div
                                        style={{
                                            fontSize: 12,
                                            marginTop: 6,
                                            color: vars.color.mutedForeground,
                                        }}
                                    >
                                        NEEDS MORE DATA · Day —/10 · Eligible —/200
                                    </div>
                                </div>
                            ),
                        )}
                    </div>
                </div>
            )}

            {tab === 'history' && (
                <div className={s.empty}>
                    History / Replay 將於 Phase 3 接入
                </div>
            )}
        </>
    );
}

function Metric({ lab, val }: { lab: string; val: string }) {
    return (
        <div className={s.metricTile}>
            <div className={s.metricTileLab}>{lab}</div>
            <div className={s.metricTileVal}>{val}</div>
        </div>
    );
}
