import { useEffect, useMemo, useState } from 'react';
import type { IntradayRankItemDto } from '../../lib/backend';
import { fetchSnapshots } from '../../lib/backend';
import { useQuote } from '../../hooks/use-stream';
import {
    analyzeSymbolWithServer,
    type SymbolAnalyzeResult,
} from '../../lib/radar-ai';
import {
    fetchMiSymbol,
    type SymbolIntelligenceDto,
} from '../../lib/market-intelligence';
import {
    fetchBrokerSummary,
    fmtLotsShares,
    type BrokerSummaryDto,
} from '../../lib/broker-intelligence';
import { fmtPct, fmtPrice } from '../../lib/utils/format';
import { vars } from '../../theme.css';
import { toggleFavorite } from './favorites';
import {
    buildRulesSummary,
    chaseLabel,
    eventLabel,
    fmtNum,
    fmtPctSigned,
    fmtRankMove,
    primaryEvent,
    stateLabel,
    stateTone,
    volumeLabel,
    vwapLabel,
} from './helpers';
import * as s from './radar.css';
import { radarColor } from './tokens';

const AI_STALE_MS = 4 * 60 * 1000;

export function StockDetailPage({
    item,
    favorite,
    marketRegime,
    onBack,
    onToggleFavorite,
    onSelectCode,
    desktop = false,
}: {
    item: IntradayRankItemDto;
    favorite: boolean;
    marketRegime?: string | null;
    onBack: () => void;
    onToggleFavorite: (codes: string[]) => void;
    onSelectCode: (code: string) => void;
    desktop?: boolean;
}) {
    const quote = useQuote(item.symbol);
    const [snapPrice, setSnapPrice] = useState<number | null>(null);
    const [snapPct, setSnapPct] = useState<number | null>(null);
    const [ai, setAi] = useState<SymbolAnalyzeResult | null>(null);
    const [aiLoading, setAiLoading] = useState(false);
    const [aiError, setAiError] = useState<string | null>(null);
    const [aiAt, setAiAt] = useState<number | null>(null);
    const [now, setNow] = useState(Date.now());
    const [advancedOpen, setAdvancedOpen] = useState(false);

    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(t);
    }, []);

    useEffect(() => {
        setAi(null);
        setAiError(null);
        setAiAt(null);
        setSnapPrice(null);
        setSnapPct(null);
        let cancelled = false;
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
    const pct = quote?.tick?.pct_chg
        ? Number(quote.tick.pct_chg)
        : snapPct ?? item.change_pct ?? item.metrics?.return_3m ?? null;
    const event = primaryEvent(item);
    const summary = useMemo(() => buildRulesSummary(item), [item]);
    const aiStale = aiAt != null && now - aiAt > AI_STALE_MS;

    const runAi = async () => {
        setAiLoading(true);
        setAiError(null);
        void onSelectCode(item.symbol);
        try {
            // After-hours / thin coverage: still run AI on rule features;
            // only hard-stop when stream is fully disconnected with no scores.
            if (
                item.data_health === 'disconnected' &&
                (item.score_coverage_pct == null ||
                    item.score_coverage_pct < 20)
            ) {
                setAi({
                    verdict: '資料不足',
                    confidence: 20,
                    summary:
                        '目前行情連線中斷且分數覆蓋過低，暫不提供 AI 判讀。',
                    reasons: [],
                    risks: ['資料健康度不足'],
                    watch_for: ['等待資料恢復'],
                    analyzed_at: new Date().toISOString(),
                });
                setAiAt(Date.now());
                return;
            }
            const feature_hash = [
                item.symbol,
                item.intraday_score,
                item.heat_score,
                item.rank,
                item.risk?.chase_risk,
                item.state,
                (item.events ?? []).join(','),
            ].join('|');
            const result = await analyzeSymbolWithServer({
                symbol: item.symbol,
                name: item.name,
                c_score: item.intraday_score,
                heat: item.heat_score,
                rank: item.rank,
                rank_velocity: item.rank_velocity,
                rvol: item.metrics?.rvol_same_time,
                vwap_pos_pct: item.metrics?.vwap_pos_pct,
                momentum: item.metrics?.momentum_acceleration,
                relative_strength: item.metrics?.relative_strength_score,
                breakout_type: item.metrics?.breakout_type,
                pullback_state: item.metrics?.pullback_state,
                chase_risk: item.risk?.chase_risk,
                invalid_reference: item.risk?.invalid_price,
                market_regime: marketRegime,
                recent_events: item.events,
                reasons: item.reasons,
                risks: item.risks,
                data_health: item.data_health,
                score_coverage_pct: item.score_coverage_pct,
                b_open_score: item.open_score,
                b_status: item.open_gate_status,
                feature_hash,
            });
            setAi(result);
            setAiAt(Date.now());
        } catch (err) {
            setAiError(
                err instanceof Error
                    ? err.message
                    : 'AI 暫時無法分析，系統即時分數仍正常',
            );
        } finally {
            setAiLoading(false);
        }
    };

    return (
        <div
            className={desktop ? s.detailPanel : s.detailOverlay}
            style={desktop ? { position: 'relative', flex: 1 } : undefined}
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
                <div
                    className={s.priceHero}
                    style={{
                        color:
                            (pct ?? 0) > 0
                                ? vars.color.up
                                : (pct ?? 0) < 0
                                  ? vars.color.down
                                  : vars.color.foreground,
                    }}
                >
                    {fmtPrice(close ?? undefined)}
                </div>
                <div
                    style={{
                        fontFamily: vars.font.mono,
                        fontSize: 18,
                        fontWeight: 700,
                        marginBottom: 12,
                        color:
                            (pct ?? 0) > 0
                                ? vars.color.up
                                : (pct ?? 0) < 0
                                  ? vars.color.down
                                  : vars.color.flat,
                    }}
                >
                    {fmtPct(pct ?? undefined)}
                </div>

                <div className={s.scoreRow}>
                    <div>
                        <span className={s.scoreCap}>#{item.rank}</span>
                    </div>
                    <div>
                        <span className={s.scoreCap}>強度</span>
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

                {/* AI first on mobile — visible above the fold, no scroll needed */}
                <div className={s.aiCard} style={{ marginBottom: 16 }}>
                    <div
                        style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            marginBottom: 6,
                        }}
                    >
                        <strong
                            style={{ fontSize: 16, color: radarColor.aiSoft }}
                        >
                            AI 判讀
                        </strong>
                        <span
                            className={s.tag}
                            style={{ color: radarColor.aiSoft }}
                        >
                            點選分析
                        </span>
                    </div>
                    <p
                        style={{
                            margin: '0 0 12px',
                            fontSize: 13,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        輔助解讀，不影響正式分數（強度／熱度）
                    </p>

                    {!ai && !aiLoading && (
                        <button
                            type="button"
                            className={s.aiBtn}
                            onClick={() => void runAi()}
                        >
                            按這裡：AI 分析這支股票
                        </button>
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
                        <div style={{ fontSize: 13, color: '#fca5a5' }}>
                            {aiError}
                            <br />
                            系統即時分數仍正常
                            <button
                                type="button"
                                className={s.aiBtn}
                                style={{ marginTop: 10 }}
                                onClick={() => void runAi()}
                            >
                                重試
                            </button>
                        </div>
                    )}

                    {ai && !aiLoading && (
                        <div>
                            <div
                                style={{
                                    fontSize: 28,
                                    fontWeight: 800,
                                    color: radarColor.aiSoft,
                                    letterSpacing: '-0.02em',
                                }}
                            >
                                {ai.verdict}
                            </div>
                            <div
                                style={{
                                    fontSize: 13,
                                    color: vars.color.mutedForeground,
                                    marginBottom: 12,
                                }}
                            >
                                信心 {ai.confidence} / 100
                            </div>
                            <div style={{ fontSize: 14, lineHeight: 1.55 }}>
                                <strong>結論</strong>
                                <br />
                                {ai.summary}
                            </div>
                            {ai.reasons.length > 0 && (
                                <div style={{ marginTop: 12 }}>
                                    <strong style={{ fontSize: 13 }}>
                                        支持理由
                                    </strong>
                                    <ul className={s.reasonList}>
                                        {ai.reasons.map((r) => (
                                            <li key={r}>✓ {r}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {ai.risks.length > 0 && (
                                <div style={{ marginTop: 12 }}>
                                    <strong style={{ fontSize: 13 }}>
                                        風險
                                    </strong>
                                    <ul className={s.reasonList}>
                                        {ai.risks.map((r) => (
                                            <li key={r}>⚠ {r}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {ai.watch_for.length > 0 && (
                                <div style={{ marginTop: 12 }}>
                                    <strong style={{ fontSize: 13 }}>
                                        接著看
                                    </strong>
                                    <ul className={s.reasonList}>
                                        {ai.watch_for.map((r) => (
                                            <li key={r}>→ {r}</li>
                                        ))}
                                    </ul>
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
                                    分析時間{' '}
                                    {new Date(ai.analyzed_at).toLocaleTimeString(
                                        'zh-TW',
                                        {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                            second: '2-digit',
                                            hour12: false,
                                        },
                                    )}
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
                                    行情已更新，此 AI 判讀可能已過期
                                </div>
                            )}
                            <button
                                type="button"
                                className={s.aiBtn}
                                style={{ marginTop: 12 }}
                                onClick={() => void runAi()}
                            >
                                重新分析
                            </button>
                        </div>
                    )}
                </div>

                <MarketIntelBlock symbol={item.symbol} />
                <BrokerChipBlock symbol={item.symbol} />

                <div className={s.glass} style={{ padding: 14, marginBottom: 16 }}>
                    <div
                        style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            marginBottom: 8,
                        }}
                    >
                        <strong style={{ fontSize: 15 }}>系統判定</strong>
                        <span className={s.tag}>系統規則判定</span>
                    </div>
                    <p
                        style={{
                            margin: 0,
                            fontSize: 14,
                            lineHeight: 1.55,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        {summary}
                    </p>
                    <div
                        style={{
                            marginTop: 12,
                            paddingTop: 12,
                            borderTop: `1px solid ${radarColor.glassBorder}`,
                            fontSize: 13,
                        }}
                    >
                        <span style={{ color: vars.color.mutedForeground }}>
                            系統規則 ·{' '}
                        </span>
                        強度 {Math.round(item.intraday_score)} ·{' '}
                        {stateLabel(item.state)}
                    </div>
                </div>

                <div className={s.twoCol} style={{ marginBottom: 16 }}>
                    <Metric
                        lab="相對量能"
                        val={
                            item.metrics?.rvol_same_time != null
                                ? `${fmtNum(item.metrics.rvol_same_time)}x`
                                : volumeLabel(item)
                        }
                    />
                    <Metric lab="均價偏離" val={vwapLabel(item)} />
                    <Metric
                        lab="動能"
                        val={fmtNum(item.metrics?.momentum_acceleration, 0)}
                    />
                    <Metric
                        lab="相對強弱"
                        val={fmtNum(item.metrics?.relative_strength_score, 0)}
                    />
                    <Metric lab="排名變化" val={fmtRankMove(item)} />
                    <Metric
                        lab="追高風險"
                        val={chaseLabel(item.risk?.chase_risk)}
                    />
                </div>

                <div className={s.sectionTitle}>今日事件</div>
                <div className={s.glass} style={{ padding: 14, marginBottom: 16 }}>
                    {(item.events ?? []).length === 0 ? (
                        <div className={s.empty} style={{ padding: 8 }}>
                            尚無正式事件標記
                        </div>
                    ) : (
                        (item.events ?? []).map((ev) => (
                            <div key={ev} className={s.eventRow}>
                                <div style={{ fontWeight: 700 }}>
                                    {eventLabel(ev)}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className={s.sectionTitle}>風險</div>
                <div className={s.glass} style={{ padding: 14, marginBottom: 20 }}>
                    <div className={s.metricGrid}>
                        <div>
                            <span className={s.metricLab}>追高風險</span>
                            {chaseLabel(item.risk?.chase_risk)}
                        </div>
                        <div>
                            <span className={s.metricLab}>失效參考價</span>
                            {item.risk?.invalid_price != null
                                ? fmtPrice(item.risk.invalid_price)
                                : '—'}
                        </div>
                        <div>
                            <span className={s.metricLab}>距均價</span>
                            {vwapLabel(item)}
                        </div>
                    </div>
                    {(item.risks ?? []).slice(0, 2).map((r) => (
                        <div
                            key={r}
                            style={{
                                marginTop: 8,
                                fontSize: 13,
                                color: '#fcd34d',
                            }}
                        >
                            ⚠ {r}
                        </div>
                    ))}
                </div>

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
        <div className={s.glass} style={{ padding: 14, margin: '12px 0 16px' }}>
            <strong style={{ fontSize: 15 }}>市場情報</strong>
            <div style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
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
                {data.chips_context.summary && (
                    <div style={{ marginTop: 4 }}>
                        法人背景 {data.chips_context.summary}
                        <span
                            style={{
                                color: vars.color.mutedForeground,
                                fontSize: 11,
                            }}
                        >
                            {' '}
                            （{data.chips_context.freshness}）
                        </span>
                    </div>
                )}
                <div style={{ marginTop: 4, color: vars.color.mutedForeground }}>
                    {data.market_context.summary}
                </div>
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
                    公司事件為部分公開來源；完整重大訊息尚未接入。情報不影響強度／熱度分數。
                </div>
            </div>
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

    const freshnessLabel =
        data.freshness === 'INTRADAY'
            ? '即時分點'
            : data.freshness === 'EOD' || data.freshness === 'T_PLUS_1'
              ? '盤後／最近可用交易日分點'
              : '分點 freshness 未知';

    return (
        <div className={s.glass} style={{ padding: 14, margin: '0 0 16px' }}>
            <strong style={{ fontSize: 15 }}>籌碼情報</strong>
            <div style={{ fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>法人籌碼</div>
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
                            }}
                        >
                            {data.institutional.freshness}
                            {data.institutional.as_of
                                ? ` · ${data.institutional.as_of}`
                                : ''}{' '}
                            · 與券商分點分開
                        </div>
                    </>
                ) : (
                    <div style={{ color: vars.color.mutedForeground }}>
                        法人公開籌碼暫無
                    </div>
                )}

                <div style={{ fontWeight: 700, margin: '12px 0 4px' }}>
                    券商分點
                </div>
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
                            {freshnessLabel}
                            {data.trade_date ? ` · ${data.trade_date}` : ''}
                        </div>
                        <div>
                            Top3 集中度{' '}
                            {data.concentration?.concentration_top3 != null
                                ? `${data.concentration.concentration_top3}%`
                                : '—'}
                        </div>
                        <div>
                            主力集中度推估{' '}
                            <b>{data.main_force.label}</b>
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


