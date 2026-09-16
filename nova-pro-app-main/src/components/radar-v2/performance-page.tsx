import { useEffect, useState } from 'react';
import { vars } from '../../theme.css';
import {
    fetchContextCombinations,
    fetchContextEvents,
    fetchContextMarket,
    fetchContextOverview,
    fetchContextSectors,
    type CohortStatDto,
    type ContextOverviewDto,
} from '../../lib/context-research';
import * as s from './radar.css';
import { radarColor } from './tokens';

type PerfTab = 'signals' | 'shadow' | 'context' | 'history';
type ContextSub = 'market' | 'sector' | 'events' | 'combo';

/** 績效頁 — 訊號／影子／Context Lab／歷史 */
export function PerformancePage() {
    const [tab, setTab] = useState<PerfTab>('signals');
    const [ctxSub, setCtxSub] = useState<ContextSub>('combo');
    const [overview, setOverview] = useState<ContextOverviewDto | null>(null);
    const [rows, setRows] = useState<CohortStatDto[]>([]);
    const [signalType, setSignalType] = useState('SURGE');

    useEffect(() => {
        if (tab !== 'context') return;
        let cancelled = false;
        const params = { signal_type: signalType };
        void (async () => {
            try {
                const ov = await fetchContextOverview(params);
                if (!cancelled) setOverview(ov);
                if (ctxSub === 'market') {
                    const r = await fetchContextMarket(params);
                    if (!cancelled) setRows(r.items ?? []);
                } else if (ctxSub === 'sector') {
                    const r = await fetchContextSectors(params);
                    if (!cancelled) setRows(r.items ?? []);
                } else if (ctxSub === 'events') {
                    const r = await fetchContextEvents(params);
                    if (!cancelled) setRows(r.confirmation ?? []);
                } else {
                    const r = await fetchContextCombinations(params);
                    if (!cancelled) setRows(r.shadow ?? r.items ?? []);
                }
            } catch {
                if (!cancelled) {
                    setOverview(null);
                    setRows([]);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [tab, ctxSub, signalType]);

    return (
        <>
            <div className={s.sectionTitle}>訊號驗證</div>
            <div className={s.stickyTabs}>
                {(
                    [
                        ['signals', '訊號結果'],
                        ['shadow', '影子實驗'],
                        ['context', 'Context Lab'],
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
                </div>
            )}

            {tab === 'context' && (
                <div className={s.glass} style={{ padding: 16 }}>
                    <div style={{ fontWeight: 800, fontSize: 16 }}>Context Lab</div>
                    <div
                        style={{
                            fontSize: 12,
                            color: vars.color.mutedForeground,
                            marginTop: 4,
                            marginBottom: 10,
                        }}
                    >
                        Research / Shadow cohorts only · 不標 Winner · 不改正式策略
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                        <select
                            value={signalType}
                            onChange={(e) => setSignalType(e.target.value)}
                            style={{
                                minHeight: 44,
                                padding: '8px 10px',
                                borderRadius: 8,
                                background: vars.color.background,
                                color: vars.color.foreground,
                                border: `1px solid ${vars.color.border}`,
                            }}
                        >
                            {[
                                'OPEN_PASS',
                                'STRONG_ENTER',
                                'SURGE',
                                'BREAKOUT',
                                'REBREAK',
                                'RANK_JUMP',
                                'PULLBACK_READY',
                            ].map((t) => (
                                <option key={t} value={t}>
                                    {t}
                                </option>
                            ))}
                        </select>
                        {(
                            [
                                ['combo', '組合'],
                                ['market', '市場'],
                                ['sector', '產業'],
                                ['events', '事件'],
                            ] as const
                        ).map(([id, label]) => (
                            <button
                                key={id}
                                type="button"
                                className={`${s.quickBtn} ${ctxSub === id ? s.dockBtnOn : ''}`}
                                onClick={() => setCtxSub(id)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    {overview && (
                        <div
                            style={{
                                fontSize: 12,
                                fontFamily: vars.font.mono,
                                color: vars.color.mutedForeground,
                                marginBottom: 10,
                            }}
                        >
                            Signals {overview.signal_count}
                            {overview.daily?.context_coverage_pct != null
                                ? ` · Coverage ${overview.daily.context_coverage_pct}%`
                                : ''}
                            {' · '}Aligned {overview.daily?.market_aligned ?? 0}
                            {' · '}ROTATING_IN{' '}
                            {overview.daily?.sector_rotating_in ?? 0}
                            {' · '}Event Confirmed{' '}
                            {overview.daily?.event_confirmed ?? 0}
                        </div>
                    )}
                    <div style={{ display: 'grid', gap: 8 }}>
                        {rows.map((r) => (
                            <div
                                key={r.cohort_id}
                                className={s.glass}
                                style={{ padding: 12 }}
                            >
                                <div style={{ fontWeight: 700 }}>{r.label}</div>
                                <div
                                    style={{
                                        marginTop: 6,
                                        fontSize: 12,
                                        fontFamily: vars.font.mono,
                                        color: vars.color.mutedForeground,
                                    }}
                                >
                                    n={r.n} · {r.sample_guard}
                                    {' · '}15m Pos{' '}
                                    {r.positive_15m_rate != null
                                        ? `${r.positive_15m_rate}%`
                                        : '—'}
                                    {' · '}Med Ret{' '}
                                    {r.median_forward_return_15m ?? '—'}
                                    {' · '}MFE {r.median_mfe_15m ?? '—'}
                                    {' · '}MAE {r.median_mae_15m ?? '—'}
                                    {' · '}Inv{' '}
                                    {r.invalid_hit_rate != null
                                        ? `${r.invalid_hit_rate}%`
                                        : '—'}
                                </div>
                                {r.coverage_note && (
                                    <div
                                        style={{
                                            marginTop: 4,
                                            fontSize: 11,
                                            color: vars.color.mutedForeground,
                                        }}
                                    >
                                        {r.coverage_note}
                                    </div>
                                )}
                            </div>
                        ))}
                        {!rows.length && (
                            <div
                                style={{
                                    fontSize: 13,
                                    color: vars.color.mutedForeground,
                                }}
                            >
                                尚無足夠帶 context_snapshot 的訊號樣本（歷史不足維持
                                PARTIAL）
                            </div>
                        )}
                    </div>
                </div>
            )}

            {tab === 'history' && (
                <div className={s.empty}>
                    歷史訊號「當時背景」可經{' '}
                    <code>/api/v1/research/context/signals/:id</code> 查詢；列表 UI
                    後續接線
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
