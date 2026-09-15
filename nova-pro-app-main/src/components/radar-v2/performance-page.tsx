import { useState } from 'react';
import { vars } from '../../theme.css';
import * as s from './radar.css';
import { radarColor } from './tokens';

/** 績效頁殼層 — 訊號／影子實驗／歷史（後續接線） */
export function PerformancePage() {
    const [tab, setTab] = useState<'signals' | 'shadow' | 'history'>('signals');

    return (
        <>
            <div className={s.sectionTitle}>訊號驗證</div>
            <div className={s.stickyTabs}>
                {(
                    [
                        ['signals', '訊號結果'],
                        ['shadow', '影子實驗'],
                        ['history', '歷史紀錄'],
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
                        過去 30 日訊號結果（後續接線）
                    </div>
                    <div className={s.twoCol} style={{ marginTop: 14 }}>
                        <Metric lab="訊號數" val="—" />
                        <Metric lab="15 分正向率" val="—" />
                        <Metric lab="平均有利波動" val="—" />
                        <Metric lab="平均不利波動" val="—" />
                    </div>
                    <p
                        style={{
                            marginTop: 14,
                            fontSize: 13,
                            color: vars.color.mutedForeground,
                            lineHeight: 1.5,
                        }}
                    >
                        顯示正向率與訊號結果，不顯示勝率或獲利率。
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
                        影子實驗室
                    </div>
                    <div style={{ fontSize: 13, color: vars.color.mutedForeground }}>
                        正式版 vs 候選版 · 研究模式
                        <br />
                        不影響正式判斷
                    </div>
                    <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
                        {[
                            '開盤閘門 B  78 → 81',
                            '盤中強度 C  80/74 → 82/76',
                            'B+C  合併實驗',
                        ].map((label) => (
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
                                    資料不足 · 天數 —/10 · 合格樣本 —/200
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {tab === 'history' && (
                <div className={s.empty}>歷史／回放將於後續版本接入</div>
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
