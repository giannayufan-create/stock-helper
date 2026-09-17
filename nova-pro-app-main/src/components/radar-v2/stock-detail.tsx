import { useEffect, useMemo, useState } from 'react';
import type { IntradayRankItemDto } from '../../lib/backend';
import { fetchSnapshots } from '../../lib/backend';
import { useQuote } from '../../hooks/use-stream';
import {
    fetchStockInterpretationScore,
    requestStockInterpretation,
    type StockAIInterpretationDto,
} from '../../lib/ai-interpretation';
import {
    fetchMiSymbol,
    type SymbolIntelligenceDto,
} from '../../lib/market-intelligence';
import {
    fetchBrokerSummary,
    fmtLotsShares,
    type BrokerSummaryDto,
} from '../../lib/broker-intelligence';
import {
    CONFIRM_LABEL,
    EVENT_TYPE_LABEL,
    fetchActiveEvents,
    fetchCompanyExposures,
    fetchEventDetail,
    type CompanyExposureDto,
    type EventConfirmationDto,
    type MarketEventDto,
} from '../../lib/events';
import {
    ACTION_TYPE_LABEL,
    fetchCorporateActionSymbol,
    type CorporateActionSymbolDto,
} from '../../lib/calendar';
import { fmtPct, fmtPrice } from '../../lib/utils/format';
import { vars } from '../../theme.css';
import { ConfirmLayersRow } from './confirm-layers';
import { toggleFavorite } from './favorites';
import { FreshnessBadge } from './freshness-badge';
import {
    chaseLabel,
    eventLabel,
    fmtNum,
    fmtPctSigned,
    fmtRankMove,
    primaryEvent,
    regimeMeta,
    stateLabel,
    stateTone,
    volumeLabel,
    vwapLabel,
} from './helpers';
import * as s from './radar.css';
import { radarColor } from './tokens';
import { deriveConfirmLayers } from './ui-context';
import {
    DECISION_STATUS_EMOJI,
    DECISION_STATUS_LABEL,
    type DecisionSummaryDto,
} from '../../lib/decision-summary';

const AI_STALE_MS = 4 * 60 * 1000;

export function StockDetailPage({
    item,
    favorite,
    marketRegime,
    onBack,
    onToggleFavorite,
    onSelectCode,
    desktop = false,
    decision = null,
}: {
    item: IntradayRankItemDto;
    favorite: boolean;
    marketRegime?: string | null;
    onBack: () => void;
    onToggleFavorite: (codes: string[]) => void;
    onSelectCode: (code: string) => void;
    desktop?: boolean;
    decision?: DecisionSummaryDto | null;
}) {
    const quote = useQuote(item.symbol);
    const [snapPrice, setSnapPrice] = useState<number | null>(null);
    const [snapPct, setSnapPct] = useState<number | null>(null);
    const [interp, setInterp] = useState<StockAIInterpretationDto | null>(null);
    const [interpStatus, setInterpStatus] = useState<
        'loading' | 'ready' | 'missing'
    >('loading');
    const [aiNarrative, setAiNarrative] = useState<string | null>(null);
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiAt, setAiAt] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now());
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [caInfo, setCaInfo] = useState<CorporateActionSymbolDto | null>(null);

    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(t);
    }, []);

    useEffect(() => {
        let cancelled = false;
        setCaInfo(null);
        void fetchCorporateActionSymbol(item.symbol)
            .then((d) => {
                if (!cancelled) setCaInfo(d);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [item.symbol]);

    useEffect(() => {
        setInterp(null);
        setInterpStatus('loading');
        setAiNarrative(null);
        setAiError(null);
        setAiAt(null);
        setSnapPrice(null);
        setSnapPct(null);
        let cancelled = false;
        void fetchStockInterpretationScore(item.symbol).then((d) => {
            if (cancelled) return;
            if (d) {
                setInterp(d);
                setInterpStatus('ready');
            } else {
                setInterpStatus('missing');
            }
        });
        void (async () => {
            try {
                const rows = await fetchSnapshots([
                    {
                        code: item.symbol,
                        security_type: 'STK',
                        exchange: 'TSE',
                        target_code: null,
                    },
                ]);
                const snap = rows[0];
                if (cancelled || !snap) return;
                if (snap.close > 0) setSnapPrice(snap.close);
                const chg =
                    snap.change_rate != null
                        ? Number(snap.change_rate)
                        : snap.close > 0 &&
                            snap.change_price != null &&
                            snap.close !== snap.change_price
                          ? (snap.change_price /
                                (snap.close - snap.change_price)) *
                            100
                          : null;
                if (chg != null && Number.isFinite(chg)) setSnapPct(chg);
            } catch {
                // keep tick / rank fallbacks
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [item.symbol]);

    const close = quote?.tick
        ? Number(quote.tick.close)
        : snapPrice ??
          (item.last_price != null && item.last_price > 0
              ? item.last_price
              : null);
    const pct =
        item.adjusted_change_pct ??
        (quote?.tick?.pct_chg ? Number(quote.tick.pct_chg) : null) ??
        snapPct ??
        item.change_pct ??
        item.metrics?.return_3m ??
        null;
    const caCtx = caInfo?.corporate_action_context;
    const upcomingCa = caInfo?.upcoming?.[0];
    const showUpcoming =
        upcomingCa &&
        !caCtx?.has_action_today &&
        caCtx?.days_to_action != null &&
        caCtx.days_to_action >= 0 &&
        caCtx.days_to_action <= 5;
    const event = primaryEvent(item);
    const hasCaToday =
        Boolean(caCtx?.has_action_today) ||
        Boolean(item.corporate_action?.has_action_today);
    const adjPct =
        item.adjusted_change_pct ??
        pct;
    const rawPct = item.raw_change_pct ?? null;
    const confirmLayers = useMemo(
        () =>
            decision?.layers ??
            deriveConfirmLayers({
                state: item.state,
                taiwanRegime: marketRegime,
                eventConfirmed: (item.events ?? []).length > 0,
            }),
        [decision?.layers, item.state, item.events, marketRegime],
    );
    const whyStrongReasons = useMemo(() => {
        const bullets: string[] = [];
        const seen = new Set<string>();
        const push = (t: string) => {
            const key = t.trim();
            if (!key || seen.has(key)) return;
            seen.add(key);
            bullets.push(key);
        };
        for (const r of item.reasons ?? []) push(r);

        const rv = item.rank_velocity;
        if (rv != null && rv > 5) {
            push(`排名加速：${fmtRankMove(item)}（velocity ${fmtNum(rv, 0)}）`);
        } else if (item.rank_change != null && item.rank_change < 0) {
            push(`排名上升：${fmtRankMove(item)}`);
        }

        const volAccel = item.metrics?.volume_acceleration;
        if (volAccel != null && volAccel > 0) {
            push(`量能加速：${volumeLabel(item)}`);
        }

        const tradeAgg = (item as { trade_aggression?: number | null })
            .trade_aggression;
        if (tradeAgg != null && Number.isFinite(tradeAgg) && tradeAgg > 0) {
            push(`成交攻擊性：${fmtNum(tradeAgg, 0)}`);
        }

        const vwap = item.metrics?.vwap_pos_pct;
        if (vwap != null && vwap > 0) {
            push(`站上 VWAP：${vwapLabel(item)}`);
        } else if (vwap != null && vwap < 0) {
            push(`偏離 VWAP：${vwapLabel(item)}`);
        }

        const br = item.metrics?.breakout_type;
        if (br && br !== 'NONE' && br !== 'none') {
            push(`突破型態：${br}`);
        }

        if (item.metrics?.relative_strength_score != null &&
            item.metrics.relative_strength_score >= 60) {
            push(
                `產業相對強弱：${fmtNum(item.metrics.relative_strength_score, 0)}`,
            );
        }

        if (!bullets.length) {
            push('結構訊號尚在累積，等待更多盤中確認');
        }
        return bullets.slice(0, 8);
    }, [item]);
    const liveFreshness =
        item.data_blocked ||
        item.data_health === 'stale' ||
        item.data_health === 'disconnected'
            ? 'STALE'
            : quote?.tick
              ? 'REALTIME'
              : item.data_health === 'ok' || item.data_health === 'live'
                ? 'NEAR_REALTIME'
                : 'UNKNOWN';
    const aiStale = aiAt != null && now - aiAt > AI_STALE_MS;
    const regime = regimeMeta(marketRegime);

    const runAi = async () => {
        setAiLoading(true);
        setAiError(null);
        void onSelectCode(item.symbol);
        try {
            const result = await requestStockInterpretation({
                symbol: item.symbol,
                snapshot_id: interp?.snapshot_id,
                with_llm: true,
            });
            if (!result) {
                setAiError('AI 文字解讀暫時無法使用');
                // Keep deterministic score if we have it
                const scoreOnly = await fetchStockInterpretationScore(
                    item.symbol,
                );
                if (scoreOnly) {
                    setInterp(scoreOnly);
                    setInterpStatus('ready');
                }
                return;
            }
            setInterp(result);
            setInterpStatus('ready');
            setAiNarrative(result.narrative ?? null);
            if (result.llm_error) {
                setAiError(result.llm_error);
            }
            setAiAt(Date.now());
        } catch {
            setAiError('AI 文字解讀暫時無法使用');
            const scoreOnly = await fetchStockInterpretationScore(item.symbol);
            if (scoreOnly) {
                setInterp(scoreOnly);
                setInterpStatus('ready');
            }
        } finally {
            setAiLoading(false);
        }
    };

    return (
        <div
            className={desktop ? s.detailPanel : s.detailOverlay}
            style={
                desktop
                    ? { position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }
                    : undefined
            }
        >
            <header className={s.detailHeader}>
                {!desktop && (
                    <button type="button" className={s.iconBtn} onClick={onBack}>
                        ←
                    </button>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div className={s.symCode}>
                        {item.symbol}{' '}
                        <span className={s.symName}>{item.name}</span>
                    </div>
                </div>
                <button
                    type="button"
                    className={s.iconBtn}
                    aria-label="關注"
                    onClick={() => {
                        onToggleFavorite(toggleFavorite(item.symbol));
                    }}
                >
                    {favorite ? '★' : '☆'}
                </button>
            </header>

            <div className={s.detailBody}>
                {/* 0. Price hero */}
                <div
                    className={s.priceHero}
                    style={{
                        color:
                            (adjPct ?? 0) > 0
                                ? vars.color.up
                                : (adjPct ?? 0) < 0
                                  ? vars.color.down
                                  : vars.color.foreground,
                    }}
                >
                    {fmtPrice(close ?? undefined)}
                </div>
                <div
                    style={{
                        fontFamily: vars.font.mono,
                        fontSize: hasCaToday ? 20 : 18,
                        fontWeight: 700,
                        marginBottom: 4,
                        color:
                            (adjPct ?? 0) > 0
                                ? vars.color.up
                                : (adjPct ?? 0) < 0
                                  ? vars.color.down
                                  : vars.color.flat,
                    }}
                >
                    {hasCaToday ? (
                        <>
                            Adj {fmtPctSigned(adjPct)}
                            {rawPct != null &&
                            adjPct != null &&
                            Math.abs(rawPct - adjPct) > 0.05 ? (
                                <span
                                    style={{
                                        marginLeft: 10,
                                        fontSize: 13,
                                        fontWeight: 600,
                                        color: vars.color.mutedForeground,
                                    }}
                                >
                                    Raw {fmtPctSigned(rawPct)}
                                </span>
                            ) : null}
                        </>
                    ) : (
                        fmtPct(adjPct ?? undefined)
                    )}
                </div>
                {hasCaToday && item.corporate_action?.badge ? (
                    <div
                        style={{
                            fontSize: 11,
                            fontWeight: 800,
                            color: '#e8a87c',
                            letterSpacing: '0.04em',
                            marginBottom: 8,
                        }}
                    >
                        {item.corporate_action.badge}
                    </div>
                ) : (
                    <div style={{ marginBottom: 8 }} />
                )}

                <div className={s.scoreRow}>
                    <div>
                        <span className={s.scoreCap}>#{item.rank}</span>
                    </div>
                    <div>
                        <span className={s.scoreCap}>C</span>
                        <span className={s.scoreBig}>
                            {Math.round(item.intraday_score)}
                        </span>
                    </div>
                    <div>
                        <span className={s.scoreCap}>熱度</span>
                        <span className={s.heatBig}>
                            {Math.round(item.heat_score)}
                        </span>
                    </div>
                </div>

                <div
                    className={s.stateLine}
                    style={{ color: stateTone(item.state) }}
                >
                    {stateLabel(item.state)}
                    {event ? ` · ${eventLabel(event)}` : ''}
                </div>

                {decision ? (
                    <div className={s.decisionSection}>
                        <div
                            className={s.decisionStatus}
                            style={{
                                color:
                                    decision.status === 'CONFIRMED_STRENGTH'
                                        ? radarColor.strong
                                        : decision.status === 'EXTENDED'
                                          ? '#a78bfa'
                                          : decision.status === 'WATCH'
                                            ? '#f59e0b'
                                            : vars.color.mutedForeground,
                            }}
                        >
                            {DECISION_STATUS_EMOJI[decision.status]}{' '}
                            {DECISION_STATUS_LABEL[decision.status]}
                        </div>
                        <div className={s.decisionHeadline}>
                            {decision.headline}
                        </div>
                        <div style={{ marginTop: 10 }}>
                            <ConfirmLayersRow layers={confirmLayers} />
                        </div>
                        <div
                            style={{
                                marginTop: 12,
                                fontSize: 12,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            Context {decision.context_alignment} · Confidence{' '}
                            {decision.confidence} · Coverage{' '}
                            {Math.round(decision.data_coverage_pct)}%
                        </div>
                        {decision.confirmed_reasons.length > 0 ? (
                            <div style={{ marginTop: 12 }}>
                                <div className={s.zoneTitle}>已確認</div>
                                <ul className={s.reasonList}>
                                    {decision.confirmed_reasons.map((r) => (
                                        <li key={r}>{r}</li>
                                    ))}
                                </ul>
                            </div>
                        ) : null}
                        {decision.missing_confirmations.length > 0 ? (
                            <div style={{ marginTop: 12 }}>
                                <div className={s.zoneTitle}>尚缺條件</div>
                                <ul className={s.reasonList}>
                                    {decision.missing_confirmations.map((r) => (
                                        <li key={r}>{r}</li>
                                    ))}
                                </ul>
                            </div>
                        ) : null}
                        {decision.risk_flags.length > 0 ? (
                            <div style={{ marginTop: 12 }}>
                                <div className={s.zoneTitle}>Risk</div>
                                <ul className={s.reasonList}>
                                    {decision.risk_flags.map((r) => (
                                        <li key={r}>{r}</li>
                                    ))}
                                </ul>
                            </div>
                        ) : null}
                        {decision.next_confirmations.length > 0 ? (
                            <div style={{ marginTop: 12 }}>
                                <div className={s.zoneTitle}>下一步觀察</div>
                                <ul className={s.reasonList}>
                                    {decision.next_confirmations.map((r) => (
                                        <li key={r}>{r}</li>
                                    ))}
                                </ul>
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {/* 1. 為什麼現在變強？ */}
                <div className={s.zoneBlock}>
                    <div className={s.zoneTitle}>為什麼現在變強？</div>
                    <ul className={s.reasonList}>
                        {whyStrongReasons.map((r) => (
                            <li key={r}>{r}</li>
                        ))}
                    </ul>
                    <div style={{ marginTop: 12 }}>
                        <ConfirmLayersRow layers={confirmLayers} />
                    </div>
                </div>

                {/* AI Interpretation v1 — 輔助解讀，不影響正式分數 */}
                <div className={s.aiCard} style={{ marginBottom: 16 }}>
                    <div
                        style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            marginBottom: 6,
                            gap: 8,
                            flexWrap: 'wrap',
                        }}
                    >
                        <strong
                            style={{ fontSize: 16, color: radarColor.aiSoft }}
                        >
                            AI 輔助解讀
                        </strong>
                        <span
                            className={s.tag}
                            style={{ color: radarColor.aiSoft }}
                        >
                            不影響正式分數
                        </span>
                    </div>
                    <p
                        style={{
                            margin: '0 0 12px',
                            fontSize: 13,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        AI 輔助解讀，不影響正式分數
                    </p>

                    {interp ? (
                        <>
                            <div
                                style={{
                                    fontSize: 13,
                                    color: vars.color.mutedForeground,
                                    marginBottom: 4,
                                }}
                            >
                                AI 綜合解讀分數
                            </div>
                            <div
                                style={{
                                    fontSize: 36,
                                    fontWeight: 800,
                                    color: radarColor.aiSoft,
                                    letterSpacing: '-0.02em',
                                    lineHeight: 1.1,
                                }}
                            >
                                {interp.score.toFixed(1)}{' '}
                                <span style={{ fontSize: 18 }}>/ 10</span>
                            </div>
                            <div
                                style={{
                                    marginTop: 8,
                                    fontSize: 15,
                                    fontWeight: 700,
                                    color:
                                        interp.status === 'CONFIRMED_STRENGTH'
                                            ? radarColor.strong
                                            : interp.status === 'EXTENDED'
                                              ? '#a78bfa'
                                              : interp.status === 'WATCH'
                                                ? '#f59e0b'
                                                : vars.color.mutedForeground,
                                }}
                            >
                                {DECISION_STATUS_EMOJI[interp.status]}{' '}
                                {DECISION_STATUS_LABEL[interp.status]}
                            </div>
                            <div
                                style={{
                                    marginTop: 4,
                                    fontSize: 13,
                                    color: vars.color.mutedForeground,
                                }}
                            >
                                Confidence：{interp.confidence}
                                {interp.cash_session_closed
                                    ? ' · CASH SESSION CLOSED'
                                    : ''}
                            </div>
                            <div
                                style={{
                                    marginTop: 10,
                                    fontSize: 14,
                                    lineHeight: 1.55,
                                }}
                            >
                                {interp.headline}
                            </div>
                            {interp.positive_factors.length > 0 && (
                                <div style={{ marginTop: 12 }}>
                                    <div className={s.zoneTitle}>已確認</div>
                                    <ul className={s.reasonList}>
                                        {interp.positive_factors.map((r) => (
                                            <li key={r}>✓ {r}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {(interp.limiting_factors.length > 0 ||
                                interp.missing_confirmations.length > 0) && (
                                <div style={{ marginTop: 12 }}>
                                    <div className={s.zoneTitle}>
                                        限制 / 仍注意
                                    </div>
                                    <ul className={s.reasonList}>
                                        {[
                                            ...interp.limiting_factors,
                                            ...interp.missing_confirmations,
                                        ].map((r) => (
                                            <li key={r}>△ {r}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {interp.risk_flags.length > 0 && (
                                <div style={{ marginTop: 12 }}>
                                    <div className={s.zoneTitle}>風險</div>
                                    <ul className={s.reasonList}>
                                        {interp.risk_flags.map((r) => (
                                            <li key={r}>⚠ {r}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            <div
                                style={{
                                    marginTop: 10,
                                    fontSize: 12,
                                    color: vars.color.mutedForeground,
                                }}
                            >
                                {interp.data_quality_summary}
                            </div>
                        </>
                    ) : (
                        <div
                            style={{
                                fontSize: 13,
                                color: vars.color.mutedForeground,
                                marginBottom: 8,
                            }}
                        >
                            {interpStatus === 'loading'
                                ? '解讀分數載入中…'
                                : '此標的尚無解讀分數（可能不在目前雷達批次）'}
                        </div>
                    )}

                    {aiLoading && (
                        <div
                            style={{
                                padding: '16px 0',
                                color: radarColor.aiSoft,
                                fontSize: 14,
                            }}
                        >
                            AI 正在整理即時訊號…
                        </div>
                    )}

                    {aiError && (
                        <div
                            style={{
                                fontSize: 13,
                                color: '#fca5a5',
                                marginTop: 8,
                            }}
                        >
                            {aiError}
                            <br />
                            系統即時分數與 AI 綜合解讀分數仍可顯示
                        </div>
                    )}

                    {aiNarrative && !aiLoading && (
                        <div
                            style={{
                                marginTop: 12,
                                fontSize: 14,
                                lineHeight: 1.55,
                                whiteSpace: 'pre-wrap',
                            }}
                        >
                            <strong>AI 解讀</strong>
                            <br />
                            {aiNarrative}
                        </div>
                    )}

                    {aiAt != null && (
                        <div
                            style={{
                                marginTop: 10,
                                fontSize: 12,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            解讀時間{' '}
                            {new Date(aiAt).toLocaleTimeString('zh-TW', {
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                                hour12: false,
                            })}
                        </div>
                    )}
                    {aiStale && (
                        <div
                            style={{
                                marginTop: 10,
                                padding: 10,
                                borderRadius: 12,
                                background: 'rgba(245,165,36,0.12)',
                                fontSize: 13,
                                color: '#fcd34d',
                            }}
                        >
                            行情已更新，此 AI 解讀可能已過期
                        </div>
                    )}

                    <button
                        type="button"
                        className={s.aiBtn}
                        style={{ marginTop: 12 }}
                        onClick={() => void runAi()}
                        disabled={aiLoading}
                    >
                        {aiNarrative ? '重新解讀' : 'AI 解讀這支股票'}
                    </button>
                </div>

                {/* 2. 個股 */}
                <div className={s.zoneBlock}>
                    <div className={s.zoneTitle}>個股</div>
                    <div className={s.twoCol}>
                        <Metric
                            lab="C"
                            val={String(Math.round(item.intraday_score))}
                        />
                        <Metric
                            lab="熱度"
                            val={String(Math.round(item.heat_score))}
                        />
                        <Metric lab="排名變化" val={fmtRankMove(item)} />
                        <Metric lab="VWAP" val={vwapLabel(item)} />
                        <Metric
                            lab="RVOL"
                            val={
                                item.metrics?.rvol_same_time != null
                                    ? `${fmtNum(item.metrics.rvol_same_time)}x`
                                    : volumeLabel(item)
                            }
                        />
                        <Metric
                            lab="Chase"
                            val={chaseLabel(item.risk?.chase_risk)}
                        />
                        <Metric
                            lab="突破"
                            val={item.metrics?.breakout_type || '—'}
                        />
                        <Metric
                            lab="回踩"
                            val={item.metrics?.pullback_state || '—'}
                        />
                    </div>
                    {item.corporate_action?.badge ? (
                        <div
                            style={{
                                marginTop: 10,
                                fontSize: 12,
                                fontWeight: 800,
                                color: '#e8a87c',
                            }}
                        >
                            Corporate {item.corporate_action.badge}
                        </div>
                    ) : null}
                </div>

                {/* 3. 產業 */}
                <MarketIntelBlock symbol={item.symbol} />

                {/* 4. 市場 */}
                <div className={s.zoneBlock}>
                    <div
                        className={s.zoneTitle}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 8,
                        }}
                    >
                        <span>市場</span>
                        <FreshnessBadge level={liveFreshness} compact />
                    </div>
                    <div style={{ fontSize: 14, lineHeight: 1.5 }}>
                        <div>
                            台股 Regime{' '}
                            <b style={{ color: regime.tone }}>
                                {regime.label}
                            </b>
                        </div>
                        <div
                            style={{
                                marginTop: 6,
                                fontSize: 13,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            資料健康 {item.data_health}
                            {item.score_coverage_pct != null
                                ? ` · 覆蓋 ${Math.round(item.score_coverage_pct)}%`
                                : ''}
                            {item.data_blocked ? ' · 已阻擋' : ''}
                        </div>
                    </div>
                </div>

                {/* 5. 事件 */}
                <EventContextBlock symbol={item.symbol} />

                {/* 6. 法人背景 */}
                <BrokerChipBlock symbol={item.symbol} />

                {/* 7. Corporate Action */}
                {(caCtx?.has_action_today || showUpcoming) && (
                    <div className={s.zoneBlock}>
                        <div className={s.zoneTitle}>Corporate Action</div>
                        {caCtx?.has_action_today ? (
                            <div style={{ fontSize: 13, lineHeight: 1.45 }}>
                                <div
                                    style={{
                                        fontWeight: 800,
                                        color: '#c45c26',
                                    }}
                                >
                                    今日
                                    {caCtx.action_type
                                        ? ACTION_TYPE_LABEL[
                                              caCtx.action_type as keyof typeof ACTION_TYPE_LABEL
                                          ] ?? '除權息'
                                        : '除權息'}
                                    ｜價格基準已調整
                                </div>
                                {caCtx.cash_dividend != null && (
                                    <div style={{ marginTop: 4 }}>
                                        現金股利：{caCtx.cash_dividend} 元
                                    </div>
                                )}
                                {caCtx.raw_previous_close != null && (
                                    <div style={{ marginTop: 2 }}>
                                        昨日收盤（Raw）：
                                        {caCtx.raw_previous_close}
                                    </div>
                                )}
                                {caCtx.ex_reference_price != null && (
                                    <div style={{ marginTop: 2 }}>
                                        除息參考價：{caCtx.ex_reference_price}
                                    </div>
                                )}
                                {adjPct != null && (
                                    <div style={{ marginTop: 8 }}>
                                        Adj 漲跌{' '}
                                        <b
                                            style={{
                                                color:
                                                    adjPct > 0
                                                        ? vars.color.up
                                                        : adjPct < 0
                                                          ? vars.color.down
                                                          : vars.color.flat,
                                            }}
                                        >
                                            {fmtPctSigned(adjPct)}
                                        </b>
                                        {rawPct != null ? (
                                            <>
                                                {' '}
                                                · Raw{' '}
                                                <span
                                                    style={{
                                                        color: vars.color
                                                            .mutedForeground,
                                                    }}
                                                >
                                                    {fmtPctSigned(rawPct)}
                                                </span>
                                            </>
                                        ) : null}
                                    </div>
                                )}
                            </div>
                        ) : showUpcoming && upcomingCa ? (
                            <div style={{ fontWeight: 700, fontSize: 13 }}>
                                {upcomingCa.action_date
                                    .slice(5)
                                    .replace('-', '/')}{' '}
                                {ACTION_TYPE_LABEL[upcomingCa.action_type] ??
                                    upcomingCa.action_type}
                                {caCtx?.days_to_action != null
                                    ? ` · 距離 ${caCtx.days_to_action} 個交易日`
                                    : ''}
                            </div>
                        ) : null}
                    </div>
                )}

                <button
                    type="button"
                    className={s.linkBtn}
                    style={{ marginTop: 16 }}
                    onClick={() => setAdvancedOpen((v) => !v)}
                >
                    {advancedOpen ? '收合進階資料' : '進階資料（五檔／分價量）›'}
                </button>
                {advancedOpen && (
                    <div className={s.empty}>
                        五檔／分價量／成交明細已移出主畫面，
                        <br />
                        研究模式將於後續版本以 Bottom Sheet 提供。
                    </div>
                )}

                <div className={s.pageEnd} />
            </div>
        </div>
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

/** Context-only block — does not change C/Heat scores. */
function MarketIntelBlock({ symbol }: { symbol: string }) {
    const [data, setData] = useState<SymbolIntelligenceDto | null>(null);
    useEffect(() => {
        let cancelled = false;
        void fetchMiSymbol(symbol)
            .then((d) => {
                if (!cancelled) setData(d);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [symbol]);

    if (!data) return null;

    return (
        <div className={s.zoneBlock}>
            <div className={s.zoneTitle}>產業</div>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                {data.sector?.name ? (
                    <div>
                        所屬產業 <b>{data.sector.name}</b>
                        {data.sector.heat != null && (
                            <>
                                {' '}
                                · 產業 Heat {Math.round(data.sector.heat)}{' '}
                                {data.sector.trend ?? ''}
                                {data.sector.rank != null &&
                                    ` · #${data.sector.rank}`}
                            </>
                        )}
                    </div>
                ) : (
                    <div style={{ color: vars.color.mutedForeground }}>
                        產業對應暫無
                    </div>
                )}
                {data.themes.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                        題材{' '}
                        {data.themes
                            .map(
                                (t) =>
                                    `${t.name}${t.heat != null ? ` ${Math.round(t.heat)}` : ''}`,
                            )
                            .join(' · ')}
                    </div>
                )}
                {data.news.slice(0, 3).map((n, i) => (
                    <div
                        key={i}
                        style={{
                            marginTop: 6,
                            fontSize: 12,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        [{n.sentiment}] {n.title}
                    </div>
                ))}
                <div
                    style={{
                        marginTop: 8,
                        fontSize: 11,
                        color: vars.color.mutedForeground,
                    }}
                >
                    產業 Context 不影響 C／熱度分數。
                </div>
            </div>
        </div>
    );
}

/** Event context — hypothesis + confirmation; never trading advice. */
function EventContextBlock({ symbol }: { symbol: string }) {
    const [rows, setRows] = useState<
        Array<{
            event: MarketEventDto;
            exposure: CompanyExposureDto;
            confirmation: EventConfirmationDto | null;
        }>
    >([]);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const active = await fetchActiveEvents();
                const top = (active.items ?? []).slice(0, 3);
                const out: typeof rows = [];
                for (const ev of top) {
                    const [exposure, detail] = await Promise.all([
                        fetchCompanyExposures(symbol, ev.event_type),
                        fetchEventDetail(ev.event_id).catch(() => null),
                    ]);
                    out.push({
                        event: ev,
                        exposure,
                        confirmation: detail?.confirmation ?? null,
                    });
                }
                if (!cancelled) setRows(out);
            } catch {
                if (!cancelled) setRows([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [symbol]);

    if (!rows.length) return null;

    return (
        <div className={s.zoneBlock}>
            <div className={s.zoneTitle}>事件</div>
            <div
                style={{
                    fontSize: 11,
                    color: vars.color.mutedForeground,
                    marginTop: -4,
                    marginBottom: 4,
                }}
            >
                相關度與市場確認分開 · 僅供 Context
            </div>
            {rows.map(({ event, exposure, confirmation }) => {
                const dirs = exposure.exposures
                    .map((e) => e.direction)
                    .filter(Boolean);
                const mixed =
                    dirs.includes('MIXED') ||
                    (dirs.includes('POSITIVE') && dirs.includes('NEGATIVE'));
                const reasons = exposure.exposures
                    .slice(0, 3)
                    .map(
                        (e) =>
                            `${e.direction === 'POSITIVE' ? '+' : e.direction === 'NEGATIVE' ? '-' : '·'} ${e.channel}（${e.evidence_source}）`,
                    );
                let summary = '事件相關度與曝險待觀察';
                if (
                    exposure.overall_confidence === 'HIGH' &&
                    confirmation?.status === 'EVENT_MARKET_CONFIRMED'
                ) {
                    summary = '事件相關度高，市場已有反應';
                } else if (exposure.overall_confidence === 'LOW') {
                    summary = '曝險證據不足（產業標籤≠受惠）';
                } else if (confirmation?.status === 'EVENT_UNCONFIRMED') {
                    summary = '事件相關，但市場尚未確認反應';
                }
                return (
                    <div
                        key={event.event_id}
                        style={{
                            marginTop: 12,
                            paddingTop: 10,
                            borderTop: `1px solid ${vars.color.border}`,
                        }}
                    >
                        <div style={{ fontWeight: 700 }}>
                            {EVENT_TYPE_LABEL[event.event_type] ??
                                event.event_type}
                        </div>
                        <div style={{ fontSize: 13, marginTop: 2 }}>
                            {event.title}
                        </div>
                        <div
                            style={{
                                marginTop: 6,
                                fontSize: 12,
                                fontFamily: vars.font.mono,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            Company Exposure {exposure.overall_confidence}
                            {' · '}Direction{' '}
                            {mixed ? 'MIXED' : dirs[0] ?? 'UNKNOWN'}
                            {' · '}revenue_exposure_available=false
                        </div>
                        {reasons.length > 0 && (
                            <div style={{ marginTop: 6, fontSize: 12 }}>
                                {reasons.map((r) => (
                                    <div key={r}>{r}</div>
                                ))}
                            </div>
                        )}
                        {confirmation && (
                            <div style={{ marginTop: 6, fontSize: 12 }}>
                                {CONFIRM_LABEL[confirmation.status]}
                                {' · '}Conf{' '}
                                {confirmation.market_confirmation_score}
                                {' / '}Rel {confirmation.event_relevance}
                            </div>
                        )}
                        <div
                            style={{
                                marginTop: 6,
                                fontSize: 12,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            {summary}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function BrokerChipBlock({ symbol }: { symbol: string }) {
    const [data, setData] = useState<BrokerSummaryDto | null>(null);
    useEffect(() => {
        let cancelled = false;
        void fetchBrokerSummary(symbol)
            .then((d) => {
                if (!cancelled) setData(d);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [symbol]);

    if (!data) return null;

    const branchIsProxy =
        data.freshness === 'INTRADAY' ||
        data.freshness === 'NEAR_REALTIME' ||
        data.freshness === 'PROXY';

    return (
        <div className={s.zoneBlock}>
            <div className={s.zoneTitle}>法人背景</div>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        marginBottom: 6,
                    }}
                >
                    <div style={{ fontWeight: 700 }}>法人籌碼</div>
                    <FreshnessBadge level="PREVIOUS_DAY" compact />
                </div>
                {data.institutional.available ? (
                    <>
                        <div>
                            外資{' '}
                            {fmtLotsShares(data.institutional.foreign_net)}
                            {' · '}投信{' '}
                            {fmtLotsShares(data.institutional.trust_net)}
                        </div>
                        <div
                            style={{
                                fontSize: 11,
                                color: vars.color.mutedForeground,
                                marginTop: 4,
                            }}
                        >
                            PREVIOUS DAY · 非即時外資動態
                            {data.institutional.as_of
                                ? ` · ${data.institutional.as_of}`
                                : ''}
                        </div>
                    </>
                ) : (
                    <div style={{ color: vars.color.mutedForeground }}>
                        法人公開籌碼暫無
                    </div>
                )}

                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8,
                        margin: '12px 0 6px',
                    }}
                >
                    <div style={{ fontWeight: 700 }}>券商分點</div>
                    <span
                        title="盤中 Proxy，不代表即時外資實際買賣"
                        style={{ display: 'inline-flex' }}
                    >
                        <FreshnessBadge
                            level={
                                branchIsProxy
                                    ? 'NEAR_REALTIME'
                                    : 'PREVIOUS_DAY'
                            }
                            compact
                        />
                    </span>
                </div>
                {branchIsProxy && (
                    <div
                        style={{
                            fontSize: 11,
                            color: vars.color.mutedForeground,
                            marginBottom: 6,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            flexWrap: 'wrap',
                        }}
                        title="盤中 Proxy，不代表即時外資實際買賣"
                    >
                        <span style={{ fontWeight: 700 }}>
                            Institutional Risk Proxy
                        </span>
                        <span>ⓘ 盤中 Proxy，不代表即時外資實際買賣</span>
                    </div>
                )}
                {!data.branch_available ? (
                    <div style={{ color: radarColor.healthWarn, fontSize: 13 }}>
                        目前尚未接入券商分點資料來源
                        <div
                            style={{
                                color: vars.color.mutedForeground,
                                fontSize: 11,
                                marginTop: 4,
                            }}
                        >
                            不會顯示假券商名稱。Trade Aggression ≠ 分點身份。
                        </div>
                    </div>
                ) : (
                    <>
                        <div
                            style={{
                                fontSize: 11,
                                color: vars.color.mutedForeground,
                                marginBottom: 6,
                            }}
                        >
                            {data.trade_date ? `交易日 ${data.trade_date}` : ''}
                        </div>
                        <div>
                            Top3 集中度{' '}
                            {data.concentration?.concentration_top3 != null
                                ? `${data.concentration.concentration_top3}%`
                                : '—'}
                        </div>
                        <div>
                            主力集中度推估 <b>{data.main_force.label}</b>
                            {data.main_force.score != null
                                ? ` ${Math.round(data.main_force.score)}`
                                : ''}
                            <span
                                style={{
                                    fontSize: 11,
                                    color: vars.color.mutedForeground,
                                }}
                            >
                                {' '}
                                · inferred · {data.main_force.confidence}
                            </span>
                        </div>
                        {data.top_buy_branches.slice(0, 3).map((b, i) => (
                            <div key={i} style={{ marginTop: 4 }}>
                                {b.broker_name} {b.branch_name}{' '}
                                {fmtLotsShares(b.net_volume * 1000)}
                            </div>
                        ))}
                        <div
                            style={{
                                marginTop: 8,
                                fontSize: 12,
                                color:
                                    data.alignment === 'BULLISH_ALIGNMENT'
                                        ? radarColor.heating
                                        : vars.color.mutedForeground,
                            }}
                        >
                            {data.alignment_note}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}


