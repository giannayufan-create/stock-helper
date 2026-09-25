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
import {
    fetchEarlyDailyReportList,
    type EarlyDailyReportDto,
    type EarlyMetricBucketDto,
    type EarlyReportSource,
} from '../../lib/radar-rescue';
import * as s from './radar.css';
import { radarColor } from './tokens';

type PerfTab = 'signals' | 'early' | 'shadow' | 'context' | 'history';
type ContextSub = 'market' | 'sector' | 'events' | 'combo';

function taipeiToday(): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
    }).format(new Date());
}

function BucketBlock({
    title,
    bucket,
    upgradeNote,
    rateNoun = '成功率',
}: {
    title: string;
    bucket: EarlyMetricBucketDto;
    upgradeNote?: string;
    /** ACTIVE uses 狀態升級率 — never call it trading win-rate. */
    rateNoun?: string;
}) {
    return (
        <div className={s.glass} style={{ padding: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{title}</div>
            {upgradeNote && (
                <div
                    style={{
                        marginTop: 4,
                        fontSize: 11,
                        color: vars.color.mutedForeground,
                    }}
                >
                    {upgradeNote}
                </div>
            )}
            <div
                style={{
                    marginTop: 8,
                    fontSize: 12,
                    fontFamily: vars.font.mono,
                    color: vars.color.mutedForeground,
                    lineHeight: 1.6,
                }}
            >
                SUCCESS {bucket.success} · FAIL {bucket.fail} · INCOMPLETE{' '}
                {bucket.incomplete} · UNKNOWN {bucket.unknown}
                <br />
                有效分母 {bucket.denominator} · {rateNoun}{' '}
                <strong style={{ color: vars.color.foreground }}>
                    {bucket.rate_label}
                </strong>
            </div>
        </div>
    );
}
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
    const [earlyDate, setEarlyDate] = useState(taipeiToday);
    const [earlySource, setEarlySource] = useState<EarlyReportSource | ''>('');
    const [earlyReports, setEarlyReports] = useState<EarlyDailyReportDto[]>([]);
    const [earlyPartials, setEarlyPartials] = useState<EarlyDailyReportDto[]>(
        [],
    );
    const [earlySources, setEarlySources] = useState<EarlyReportSource[]>([]);
    const [earlyLiveMsg, setEarlyLiveMsg] = useState<string | null>(null);
    const [earlyErr, setEarlyErr] = useState<string | null>(null);
    const [earlyOpenId, setEarlyOpenId] = useState<string | null>(null);
    const [earlyRunId, setEarlyRunId] = useState<string | null>(null);

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
        if (tab !== 'early') return;
        let cancelled = false;
        void fetchEarlyDailyReportList(earlyDate)
            .then((d) => {
                if (cancelled) return;
                setEarlySources(d.sources ?? []);
                setEarlyReports(d.reports ?? []);
                setEarlyPartials(d.partial_reports ?? []);
                setEarlyLiveMsg(
                    d.live_pipeline?.wired
                        ? null
                        : (d.live_pipeline?.message ?? '實盤日報尚未接入'),
                );
                setEarlyErr(null);
                const nextSource =
                    earlySource && d.sources?.includes(earlySource)
                        ? earlySource
                        : (d.sources?.[0] ?? '');
                setEarlySource(nextSource);
                const forSource = (d.reports ?? []).filter(
                    (r) => r.source === nextSource,
                );
                setEarlyRunId(forSource[0]?.run_id ?? null);
            })
            .catch(() => {
                if (cancelled) return;
                setEarlyReports([]);
                setEarlyPartials([]);
                setEarlySources([]);
                setEarlyLiveMsg(null);
                setEarlyRunId(null);
                setEarlyErr('EARLY 日報暫時無法載入');
            });
        return () => {
            cancelled = true;
        };
    }, [tab, earlyDate]);

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
                        ['early', 'EARLY 日報'],
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

            {tab === 'early' && (
                <div className={s.glass} style={{ padding: 16 }}>
                    <div style={{ fontSize: 14, color: vars.color.mutedForeground }}>
                        EARLY 每日驗證（預設完整可評估日報；來源分開，不可混算）
                    </div>
                    {earlyLiveMsg && (
                        <div
                            style={{
                                marginTop: 10,
                                padding: '8px 10px',
                                borderRadius: 8,
                                border: `1px solid ${vars.color.border}`,
                                fontSize: 13,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            {earlyLiveMsg}（不會顯示實盤成功率）
                        </div>
                    )}
                    <div
                        style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: 10,
                            marginTop: 12,
                            alignItems: 'center',
                        }}
                    >
                        <label style={{ fontSize: 13 }}>
                            日期{' '}
                            <input
                                type="date"
                                value={earlyDate}
                                onChange={(e) => setEarlyDate(e.target.value)}
                                style={{
                                    marginLeft: 6,
                                    padding: '4px 8px',
                                    borderRadius: 6,
                                    border: `1px solid ${vars.color.border}`,
                                    background: 'transparent',
                                    color: vars.color.foreground,
                                }}
                            />
                        </label>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {earlySources.length === 0 && (
                                <span
                                    style={{
                                        fontSize: 12,
                                        color: vars.color.mutedForeground,
                                    }}
                                >
                                    尚無完整日報來源
                                </span>
                            )}
                            {earlySources.map((src) => (
                                <button
                                    key={src}
                                    type="button"
                                    className={`${s.tabChip} ${earlySource === src ? s.tabChipOn : ''}`}
                                    onClick={() => {
                                        setEarlySource(src);
                                        const forSrc = earlyReports.filter(
                                            (r) => r.source === src,
                                        );
                                        setEarlyRunId(
                                            forSrc[0]?.run_id ?? null,
                                        );
                                    }}
                                >
                                    {src === 'replay'
                                        ? '歷史重播'
                                        : src === 'synthetic'
                                          ? '模擬資料'
                                          : '實盤歷史'}
                                </button>
                            ))}
                        </div>
                    </div>
                    {earlyErr && (
                        <p
                            style={{
                                marginTop: 12,
                                fontSize: 13,
                                color: '#fca5a5',
                            }}
                        >
                            {earlyErr}
                        </p>
                    )}
                    {(() => {
                        const candidates = earlyReports.filter(
                            (r) => r.source === earlySource,
                        );
                        const report =
                            candidates.find((r) => r.run_id === earlyRunId) ??
                            candidates[0] ??
                            null;
                        if (!report) {
                            return (
                                <div
                                    className={s.empty}
                                    style={{ marginTop: 14, padding: 8 }}
                                >
                                    此日期尚無完整可評估的 EARLY
                                    日報。請先執行完整歷史重播（寫入
                                    early_daily_reports/…/full/）。
                                    {earlyLiveMsg
                                        ? ` ${earlyLiveMsg}。`
                                        : ''}
                                </div>
                            );
                        }
                        return (
                            <>
                                {candidates.length > 1 && (
                                    <div
                                        style={{
                                            marginTop: 12,
                                            display: 'flex',
                                            flexWrap: 'wrap',
                                            gap: 6,
                                        }}
                                    >
                                        {candidates.map((r) => (
                                            <button
                                                key={r.run_id}
                                                type="button"
                                                className={`${s.tabChip} ${earlyRunId === r.run_id ? s.tabChipOn : ''}`}
                                                onClick={() =>
                                                    setEarlyRunId(r.run_id)
                                                }
                                            >
                                                run {r.run_id.slice(-8)}
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <div
                                    className={s.twoCol}
                                    style={{ marginTop: 14 }}
                                >
                                    <Metric
                                        lab="來源"
                                        val={report.source_label}
                                    />
                                    <Metric
                                        lab="涵蓋"
                                        val="完整（可評估）"
                                    />
                                    <Metric
                                        lab="run_id"
                                        val={report.run_id}
                                    />
                                    <Metric
                                        lab="股票範圍"
                                        val={
                                            report.symbols?.length
                                                ? report.symbols.join(',')
                                                : '—'
                                        }
                                    />
                                    <Metric
                                        lab="訊號數"
                                        val={String(report.signal_count)}
                                    />
                                    <Metric
                                        lab="不同股票"
                                        val={String(
                                            report.unique_symbol_count,
                                        )}
                                    />
                                    <Metric
                                        lab="資料完整率"
                                        val={report.data_completeness_label}
                                    />
                                    <Metric
                                        lab="觀測截止"
                                        val={report.observation_cutoff_iso}
                                    />
                                </div>
                                <div
                                    style={{
                                        display: 'grid',
                                        gap: 8,
                                        marginTop: 12,
                                    }}
                                >
                                    <BucketBlock
                                        title="當日 +3%"
                                        bucket={report.day_plus_3pct}
                                    />
                                    <BucketBlock
                                        title="當日 +5%"
                                        bucket={report.day_plus_5pct}
                                    />
                                    <BucketBlock
                                        title="觸發後再漲 3%"
                                        bucket={report.post_trigger_plus_3pct}
                                    />
                                    <BucketBlock
                                        title="觸發後再漲 5%"
                                        bucket={report.post_trigger_plus_5pct}
                                    />
                                    <BucketBlock
                                        title="升級 ACTIVE"
                                        bucket={report.active_upgrade}
                                        upgradeNote="狀態升級率（不是交易勝率）"
                                        rateNoun="狀態升級率"
                                    />
                                </div>
                                <p
                                    style={{
                                        marginTop: 12,
                                        fontSize: 12,
                                        color: vars.color.mutedForeground,
                                        lineHeight: 1.5,
                                    }}
                                >
                                    {report.note}
                                </p>
                                <div
                                    style={{
                                        marginTop: 14,
                                        fontSize: 13,
                                        fontWeight: 700,
                                    }}
                                >
                                    訊號明細（點開查看）
                                </div>
                                <div
                                    style={{
                                        display: 'grid',
                                        gap: 8,
                                        marginTop: 8,
                                    }}
                                >
                                    {report.signals.map((sig) => {
                                        const open =
                                            earlyOpenId === sig.signal_id;
                                        return (
                                            <div
                                                key={sig.signal_id}
                                                className={s.glass}
                                                style={{ padding: 12 }}
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        setEarlyOpenId(
                                                            open
                                                                ? null
                                                                : sig.signal_id,
                                                        )
                                                    }
                                                    style={{
                                                        all: 'unset',
                                                        cursor: 'pointer',
                                                        display: 'block',
                                                        width: '100%',
                                                    }}
                                                >
                                                    <div
                                                        style={{
                                                            fontWeight: 700,
                                                        }}
                                                    >
                                                        {sig.symbol}{' '}
                                                        <span
                                                            style={{
                                                                fontSize: 12,
                                                                fontWeight: 500,
                                                                color: vars
                                                                    .color
                                                                    .mutedForeground,
                                                            }}
                                                        >
                                                            {sig.signal_id}
                                                        </span>
                                                    </div>
                                                    <div
                                                        style={{
                                                            marginTop: 4,
                                                            fontSize: 12,
                                                            fontFamily:
                                                                vars.font.mono,
                                                            color: vars.color
                                                                .mutedForeground,
                                                        }}
                                                    >
                                                        當日+3{' '}
                                                        {
                                                            sig.day_plus_3pct
                                                                .verdict
                                                        }
                                                        {' · '}觸發後+3{' '}
                                                        {
                                                            sig
                                                                .post_trigger_plus_3pct
                                                                .verdict
                                                        }
                                                        {' · '}ACTIVE{' '}
                                                        {
                                                            sig.active_upgrade
                                                                .verdict
                                                        }
                                                    </div>
                                                </button>
                                                {open && (
                                                    <div
                                                        style={{
                                                            marginTop: 10,
                                                            fontSize: 12,
                                                            fontFamily:
                                                                vars.font.mono,
                                                            color: vars.color
                                                                .mutedForeground,
                                                            lineHeight: 1.7,
                                                        }}
                                                    >
                                                        觸發時間{' '}
                                                        {sig.triggered_at}
                                                        <br />
                                                        觸發價{' '}
                                                        {sig.trigger_price}
                                                        {' · '}當日基準{' '}
                                                        {sig.day_reference_price ??
                                                            '—（UNKNOWN）'}
                                                        <br />
                                                        當日+3{' '}
                                                        {
                                                            sig.day_plus_3pct
                                                                .verdict
                                                        }
                                                        {sig.day_plus_3pct
                                                            .first_hit_after_min !=
                                                        null
                                                            ? ` @${sig.day_plus_3pct.first_hit_after_min}分`
                                                            : ''}
                                                        {' · '}當日+5{' '}
                                                        {
                                                            sig.day_plus_5pct
                                                                .verdict
                                                        }
                                                        {sig.day_plus_5pct
                                                            .first_hit_after_min !=
                                                        null
                                                            ? ` @${sig.day_plus_5pct.first_hit_after_min}分`
                                                            : ''}
                                                        <br />
                                                        觸發後+3{' '}
                                                        {
                                                            sig
                                                                .post_trigger_plus_3pct
                                                                .verdict
                                                        }
                                                        {sig
                                                            .post_trigger_plus_3pct
                                                            .first_hit_after_min !=
                                                        null
                                                            ? ` @${sig.post_trigger_plus_3pct.first_hit_after_min}分`
                                                            : ''}
                                                        {' · '}觸發後+5{' '}
                                                        {
                                                            sig
                                                                .post_trigger_plus_5pct
                                                                .verdict
                                                        }
                                                        <br />
                                                        ACTIVE 升級{' '}
                                                        {
                                                            sig.active_upgrade
                                                                .verdict
                                                        }
                                                        {sig.active_upgrade
                                                            .reached
                                                            ? '（已到達）'
                                                            : ''}
                                                        {' · '}終態{' '}
                                                        {sig.terminal_state}
                                                        {' · '}最高{' '}
                                                        {sig.max_price ?? '—'}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                    {!report.signals.length && (
                                        <div
                                            style={{
                                                fontSize: 13,
                                                color: vars.color
                                                    .mutedForeground,
                                            }}
                                        >
                                            此來源當日無 EARLY 訊號。
                                        </div>
                                    )}
                                </div>
                            </>
                        );
                    })()}
                    {earlyPartials.length > 0 && (
                        <div style={{ marginTop: 20 }}>
                            <div
                                style={{
                                    fontSize: 13,
                                    fontWeight: 700,
                                    color: '#fbbf24',
                                }}
                            >
                                部分重播（不可與上方完整成功率混算）
                            </div>
                            <div
                                style={{
                                    display: 'grid',
                                    gap: 8,
                                    marginTop: 8,
                                }}
                            >
                                {earlyPartials.map((p) => (
                                    <div
                                        key={p.run_id}
                                        className={s.glass}
                                        style={{
                                            padding: 12,
                                            borderLeft: '3px solid #fbbf24',
                                        }}
                                    >
                                        <div style={{ fontWeight: 700 }}>
                                            【部分】{p.source_label} ·{' '}
                                            {p.run_id}
                                        </div>
                                        <div
                                            style={{
                                                marginTop: 4,
                                                fontSize: 12,
                                                fontFamily: vars.font.mono,
                                                color: vars.color
                                                    .mutedForeground,
                                                lineHeight: 1.6,
                                            }}
                                        >
                                            until={p.until_label ?? '—'} · 截止{' '}
                                            {p.observation_cutoff_iso}
                                            <br />
                                            股票{' '}
                                            {p.symbols?.join(',') || '—'} ·
                                            訊號 {p.signal_count} · 當日+3{' '}
                                            {p.day_plus_3pct.rate_label}
                                            （僅供對照，非預設成功率）
                                        </div>
                                    </div>
                                ))}
                            </div>
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
