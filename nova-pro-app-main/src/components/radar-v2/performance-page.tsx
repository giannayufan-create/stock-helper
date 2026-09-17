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
import {
    fetchOutcomeSummary,
    numLabel,
    pctLabel,
    weightedRate,
    type OutcomeSummaryDto,
} from '../../lib/outcomes';
import * as s from './radar.css';
import { radarColor } from './tokens';

type PerfTab = 'signals' | 'shadow' | 'context' | 'history';
type ContextSub = 'market' | 'sector' | 'events' | 'combo';

const SIGNAL_TYPE_LABEL: Record<string, string> = {
    OPEN_PASS: '開盤通過',
    STRONG_ENTER: '強勢進場',
    SURGE: '急漲',
    BREAKOUT: '突破',
    REBREAK: '再突破',
    RANK_JUMP: '排名躍升',
    PULLBACK_READY: '回踩就緒',
};

/** 績效頁 — 訊號／影子／Context Lab／歷史 */
export function PerformancePage() {
    const [tab, setTab] = useState<PerfTab>('signals');
    const [ctxSub, setCtxSub] = useState<ContextSub>('combo');
    const [overview, setOverview] = useState<ContextOverviewDto | null>(null);
    const [rows, setRows] = useState<CohortStatDto[]>([]);
    const [signalType, setSignalType] = useState('SURGE');
    const [outcomes, setOutcomes] = useState<OutcomeSummaryDto | null>(null);
    const [outcomesErr, setOutcomesErr] = useState<string | null>(null);

    useEffect(() => {
        if (tab !== 'signals') return;
        let cancelled = false;
        void fetchOutcomeSummary()
            .then((d) => {
                if (cancelled) return;
                setOutcomes(d);
                setOutcomesErr(null);
            })
            .catch(() => {
                if (cancelled) return;
                setOutcomes(null);
                setOutcomesErr('績效資料暫時無法載入');
            });
        return () => {
            cancelled = true;
        };
    }, [tab]);

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

    const pos15 = weightedRate(
        (outcomes?.by_signal_type ?? []).map((r) => ({
            count: r.count,
            value: r.positive_15m_rate,
        })),
    );
    const mfe = weightedRate(
        (outcomes?.by_signal_type ?? []).map((r) => ({
            count: r.count,
            value: r.avg_MFE_15m,
        })),
    );
    const mae = weightedRate(
        (outcomes?.by_signal_type ?? []).map((r) => ({
            count: r.count,
            value: r.avg_MAE_15m,
        })),
    );

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
                        過去 30 日訊號後的市場路徑
                        {outcomes?.window
                            ? `（${outcomes.window.from} ～ ${outcomes.window.to}）`
                            : ''}
                    </div>
                    <div className={s.twoCol} style={{ marginTop: 14 }}>
                        <Metric
                            lab="訊號數"
                            val={
                                outcomes
                                    ? String(outcomes.coverage.signals)
                                    : '—'
                            }
                        />
                        <Metric lab="15 分正向率" val={pctLabel(pos15, 1)} />
                        <Metric lab="平均有利波動" val={numLabel(mfe)} />
                        <Metric lab="平均不利波動" val={numLabel(mae)} />
                    </div>
                    {outcomesErr && (
                        <p
                            style={{
                                marginTop: 12,
                                fontSize: 13,
                                color: '#fca5a5',
                            }}
                        >
                            {outcomesErr}
                        </p>
                    )}
                    {outcomes && (
                        <p
                            style={{
                                marginTop: 10,
                                fontSize: 12,
                                color: vars.color.mutedForeground,
                                lineHeight: 1.5,
                            }}
                        >
                            已量測 {outcomes.coverage.measured}／
                            {outcomes.coverage.signals} 筆（覆蓋{' '}
                            {outcomes.coverage.coverage_pct}%）
                            {outcomes.tracker?.enabled
                                ? ` · 追蹤中 ${outcomes.tracker.tracked} 檔`
                                : ''}
                            {outcomes.tracker?.last_error
                                ? ` · 追蹤錯誤：${outcomes.tracker.last_error}`
                                : ''}
                        </p>
                    )}
                    <p
                        style={{
                            marginTop: 10,
                            fontSize: 13,
                            color: vars.color.mutedForeground,
                            lineHeight: 1.5,
                        }}
                    >
                        {outcomes?.note ??
                            '顯示正向率與訊號結果，不顯示勝率或獲利率。'}
                    </p>
                    {outcomes && outcomes.by_signal_type.length > 0 && (
                        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
                            {outcomes.by_signal_type.map((r) => (
                                <div
                                    key={r.signal_type}
                                    className={s.glass}
                                    style={{ padding: 12 }}
                                >
                                    <div style={{ fontWeight: 700 }}>
                                        {SIGNAL_TYPE_LABEL[r.signal_type] ??
                                            r.signal_type}
                                        <span
                                            style={{
                                                marginLeft: 8,
                                                fontSize: 12,
                                                fontWeight: 500,
                                                color: vars.color
                                                    .mutedForeground,
                                            }}
                                        >
                                            {r.count} 筆
                                        </span>
                                    </div>
                                    <div
                                        style={{
                                            marginTop: 6,
                                            fontSize: 12,
                                            fontFamily: vars.font.mono,
                                            color: vars.color.mutedForeground,
                                        }}
                                    >
                                        15 分正向 {pctLabel(r.positive_15m_rate, 1)}
                                        {' · '}有利 {numLabel(r.avg_MFE_15m)}
                                        {' · '}不利 {numLabel(r.avg_MAE_15m)}
                                        {' · '}15 分報酬{' '}
                                        {numLabel(r.avg_forward_return_15m)}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    {outcomes && outcomes.by_c_score.length > 0 && (
                        <>
                            <div
                                style={{
                                    marginTop: 16,
                                    fontSize: 13,
                                    fontWeight: 700,
                                }}
                            >
                                依盤中排序分
                            </div>
                            <div
                                style={{
                                    display: 'grid',
                                    gap: 8,
                                    marginTop: 8,
                                }}
                            >
                                {outcomes.by_c_score.map((r) => (
                                    <div
                                        key={r.bucket}
                                        className={s.glass}
                                        style={{ padding: 12 }}
                                    >
                                        <div style={{ fontWeight: 700 }}>
                                            {r.bucket}
                                            <span
                                                style={{
                                                    marginLeft: 8,
                                                    fontSize: 12,
                                                    fontWeight: 500,
                                                    color: vars.color
                                                        .mutedForeground,
                                                }}
                                            >
                                                {r.count} 筆
                                            </span>
                                        </div>
                                        <div
                                            style={{
                                                marginTop: 6,
                                                fontSize: 12,
                                                fontFamily: vars.font.mono,
                                                color: vars.color
                                                    .mutedForeground,
                                            }}
                                        >
                                            15 分正向{' '}
                                            {pctLabel(r.positive_15m_rate, 1)}
                                            {' · '}報酬 {numLabel(r.avg_return_15m)}
                                            {' · '}有利 {numLabel(r.avg_MFE_15m)}
                                            {' · '}不利 {numLabel(r.avg_MAE_15m)}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                    {outcomes &&
                        outcomes.coverage.signals === 0 &&
                        !outcomesErr && (
                            <div
                                className={s.empty}
                                style={{ marginTop: 12, padding: 8 }}
                            >
                                尚無已量測訊號。追蹤啟動後，盤中訊號才會累積到這裡。
                            </div>
                        )}
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
                                    {SIGNAL_TYPE_LABEL[t] ?? t}
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
                            訊號 {overview.signal_count}
                            {overview.daily?.context_coverage_pct != null
                                ? ` · 覆蓋 ${overview.daily.context_coverage_pct}%`
                                : ''}
                            {' · '}同向 {overview.daily?.market_aligned ?? 0}
                            {' · '}輪入{' '}
                            {overview.daily?.sector_rotating_in ?? 0}
                            {' · '}事件確認{' '}
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
                                    {' · '}15 分正向{' '}
                                    {r.positive_15m_rate != null
                                        ? `${r.positive_15m_rate}%`
                                        : '—'}
                                    {' · '}中位報酬{' '}
                                    {r.median_forward_return_15m ?? '—'}
                                    {' · '}有利 {r.median_mfe_15m ?? '—'}
                                    {' · '}不利 {r.median_mae_15m ?? '—'}
                                    {' · '}失效{' '}
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
