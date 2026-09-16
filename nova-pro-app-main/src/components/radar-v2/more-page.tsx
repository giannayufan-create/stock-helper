import { useEffect, useState, type CSSProperties } from 'react';
import { vars } from '../../theme.css';
import {
    fetchLiveAcceptanceToday,
    finalizeLiveAcceptance,
    liveAcceptanceZipUrl,
    type LiveAcceptanceTodayDto,
} from '../../lib/live-acceptance';
import { liveStatusLabel } from './helpers';
import * as s from './radar.css';
import { radarColor } from './tokens';
import type { RadarFeed } from './use-radar-feed';

function fmtTaipei(iso: string | null | undefined): string {
    if (!iso) return '尚未產生';
    try {
        return new Date(iso).toLocaleString('zh-TW', {
            timeZone: 'Asia/Taipei',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
    } catch {
        return iso;
    }
}

export function MorePage({
    feed,
    onOpenSearch,
    onGoIntel,
    onGoBrokerRadar,
    onGoBuyPressure,
}: {
    feed: RadarFeed;
    onOpenSearch?: () => void;
    onGoIntel?: () => void;
    onGoBrokerRadar?: () => void;
    onGoBuyPressure?: () => void;
}) {
    const coverageB =
        feed.openConfirm?.items?.length
            ? Math.round(
                  (feed.openConfirm.items.filter(
                      (i) => i.data_health === 'healthy',
                  ).length /
                      feed.openConfirm.items.length) *
                      100,
              )
            : null;
    const coverageC =
        feed.items.length > 0
            ? Math.round(
                  (feed.items.filter((i) => !i.data_blocked).length /
                      feed.items.length) *
                      100,
              )
            : null;

    const [la, setLa] = useState<LiveAcceptanceTodayDto | null>(null);
    const [laBusy, setLaBusy] = useState(false);
    const [laError, setLaError] = useState<string | null>(null);
    const [laOkMsg, setLaOkMsg] = useState<string | null>(null);

    const refreshLa = async () => {
        const d = await fetchLiveAcceptanceToday();
        setLa(d);
        return d;
    };

    useEffect(() => {
        let cancelled = false;
        const load = () =>
            void fetchLiveAcceptanceToday()
                .then((d) => {
                    if (!cancelled) setLa(d);
                })
                .catch(() => undefined);
        load();
        const t = setInterval(load, 60_000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

    const onFinalize = async () => {
        setLaBusy(true);
        setLaError(null);
        setLaOkMsg(null);
        try {
            const r = await finalizeLiveAcceptance();
            if (!r.ok) {
                setLaError('產生失敗：伺服器回傳未成功');
                return;
            }
            const d = await refreshLa();
            setLaOkMsg(
                `已產生 · ${fmtTaipei(r.generated_at || d.generated_at)} · ${r.overall}`,
            );
        } catch (e) {
            setLaError(
                e instanceof Error ? e.message : '產生失敗，請稍後再試',
            );
        } finally {
            setLaBusy(false);
        }
    };

    const onDownloadZip = () => {
        setLaError(null);
        if (!la?.finalized) {
            setLaError('尚未產生，請先產生今日驗收報告');
            return;
        }
        // Full navigation — most reliable on iOS / Android browsers
        window.location.assign(liveAcceptanceZipUrl());
    };

    const overallLabel =
        !la || !la.finalized || la.overall === 'PENDING'
            ? '尚未產生'
            : la.overall;

    const overallTone =
        overallLabel === 'PASS'
            ? radarColor.live
            : overallLabel === 'FAIL'
              ? '#f87171'
              : overallLabel === '尚未產生'
                ? vars.color.mutedForeground
                : '#fcd34d';

    const actionBtn: CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        minHeight: 48,
        boxSizing: 'border-box',
        borderRadius: 14,
        fontSize: 15,
        fontWeight: 700,
        padding: '12px 14px',
        cursor: 'pointer',
        border: `1px solid ${radarColor.glassBorder}`,
        color: vars.color.foreground,
        background: 'transparent',
        textDecoration: 'none',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
    };

    return (
        <>
            <div className={s.sectionTitle}>更多</div>

            <div className={s.glass} style={{ padding: 16, marginBottom: 14 }}>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>
                    行情狀態 / Data Health
                </div>
                <HealthRow
                    label="連線狀態"
                    value={liveStatusLabel(feed.liveStatus)}
                    ok={feed.liveStatus === 'LIVE'}
                />
                <HealthRow
                    label="資料時間"
                    value={
                        feed.asOf
                            ? new Date(feed.asOf).toLocaleTimeString('zh-TW', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  second: '2-digit',
                                  hour12: false,
                                  timeZone: 'Asia/Taipei',
                              })
                            : '—'
                    }
                    ok
                />
                <HealthRow
                    label="開盤閘門覆蓋"
                    value={coverageB != null ? `${coverageB}%` : '—'}
                    ok={coverageB == null || coverageB >= 70}
                />
                <HealthRow
                    label="盤中雷達覆蓋"
                    value={coverageC != null ? `${coverageC}%` : '—'}
                    ok={coverageC == null || coverageC >= 70}
                />
                {feed.healthNote && (
                    <p
                        style={{
                            marginTop: 12,
                            fontSize: 13,
                            color: '#fcd34d',
                            lineHeight: 1.45,
                        }}
                    >
                        {feed.healthNote}
                    </p>
                )}
            </div>

            <div
                className={s.glass}
                style={{
                    padding: 16,
                    marginBottom: 14,
                    overflowX: 'hidden',
                    maxWidth: '100%',
                }}
                data-testid="live-acceptance-panel"
            >
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 10,
                        flexWrap: 'wrap',
                    }}
                >
                    <div style={{ fontSize: 16, fontWeight: 700 }}>
                        今日實盤驗收
                    </div>
                    <span
                        style={{
                            fontSize: 12,
                            fontWeight: 800,
                            letterSpacing: '0.04em',
                            color: overallTone,
                        }}
                    >
                        Overall {overallLabel}
                    </span>
                </div>

                <HealthRow
                    label="產生時間"
                    value={fmtTaipei(la?.generated_at)}
                    ok={Boolean(la?.finalized)}
                />
                <HealthRow
                    label="Market Coverage"
                    value={
                        la?.market_coverage_pct != null
                            ? `${Math.round(la.market_coverage_pct)}%`
                            : '—'
                    }
                    ok={
                        la?.market_coverage_pct == null ||
                        la.market_coverage_pct >= 50
                    }
                />
                <HealthRow
                    label="Runtime"
                    value={
                        la
                            ? `RSS ${la.runtime.rss_mb_peak}MB · CPU≈${la.runtime.cpu_pct_peak}%`
                            : '—'
                    }
                    ok
                />
                <HealthRow
                    label="Firestore"
                    value={
                        la?.firestore
                            ? `${la.firestore.effective_mode ?? '—'} · sig ${la.firestore.strategy_signal_count} · out ${la.firestore.outcome_count}`
                            : '—'
                    }
                    ok={(la?.firestore?.write_failure_count ?? 0) === 0}
                />
                <HealthRow
                    label="Signals"
                    value={
                        la?.signals
                            ? Object.entries(la.signals)
                                  .filter(([, n]) => n > 0)
                                  .slice(0, 3)
                                  .map(([k, n]) => `${k}:${n}`)
                                  .join(' · ') || '0'
                            : '—'
                    }
                    ok
                />
                <HealthRow
                    label="Notifications"
                    value={
                        la
                            ? `${la.notifications.notification_count} · dup ${la.notifications.duplicate_count}`
                            : '—'
                    }
                    ok={(la?.notifications.duplicate_count ?? 0) === 0}
                />
                <HealthRow
                    label="Anomalies"
                    value={
                        !la?.finalized
                            ? '尚未產生'
                            : la.anomalies_count === 0
                              ? '0'
                              : `${la.anomalies_count}${
                                    la.anomaly_kinds.length
                                        ? ` · ${la.anomaly_kinds.slice(0, 2).join(',')}`
                                        : ''
                                }`
                    }
                    ok={!la?.finalized || la.anomalies_count < 10}
                />

                <div
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                        marginTop: 14,
                        width: '100%',
                    }}
                >
                    <button
                        type="button"
                        disabled={laBusy}
                        onClick={() => void onFinalize()}
                        style={{
                            ...actionBtn,
                            background: radarColor.glass,
                            opacity: laBusy ? 0.6 : 1,
                        }}
                    >
                        {laBusy ? '產生中…' : '產生今日驗收報告'}
                    </button>
                    <button
                        type="button"
                        onClick={onDownloadZip}
                        style={{
                            ...actionBtn,
                            opacity: la?.finalized ? 1 : 0.55,
                        }}
                    >
                        下載今日測試包 ZIP
                    </button>
                </div>

                {laError && (
                    <p
                        role="alert"
                        style={{
                            marginTop: 12,
                            fontSize: 13,
                            color: '#fca5a5',
                            lineHeight: 1.45,
                            wordBreak: 'break-word',
                        }}
                    >
                        {laError}
                    </p>
                )}
                {laOkMsg && !laError && (
                    <p
                        style={{
                            marginTop: 12,
                            fontSize: 13,
                            color: radarColor.live,
                            lineHeight: 1.45,
                            wordBreak: 'break-word',
                        }}
                    >
                        {laOkMsg}
                    </p>
                )}
                <p
                    style={{
                        marginTop: 10,
                        fontSize: 11,
                        color: vars.color.mutedForeground,
                        lineHeight: 1.4,
                        wordBreak: 'break-word',
                    }}
                >
                    ZIP 含 md／json／csv 三檔。僅評估 Data／Runtime／Architecture，不改
                    A/B/C／BP／門檻。
                </p>
            </div>

            <button
                type="button"
                className={s.stockCard}
                onClick={onGoBuyPressure}
                disabled={!onGoBuyPressure}
                style={{ marginBottom: 10 }}
            >
                <strong>🔥 即時買盤雷達</strong>
                <div
                    style={{
                        fontSize: 13,
                        color: vars.color.mutedForeground,
                        marginTop: 4,
                    }}
                >
                    EARLY · 買盤加速 · 吃賣單 · 放量突破（context only）
                </div>
            </button>

            <button
                type="button"
                className={s.stockCard}
                onClick={onGoBrokerRadar}
                disabled={!onGoBrokerRadar}
                style={{ marginBottom: 10 }}
            >
                <strong>籌碼雷達</strong>
                <div
                    style={{
                        fontSize: 13,
                        color: vars.color.mutedForeground,
                        marginTop: 4,
                    }}
                >
                    主力集中推估 · 連續買進 · 籌碼＋動能共振
                </div>
            </button>

            <button
                type="button"
                className={s.stockCard}
                onClick={onGoIntel}
                disabled={!onGoIntel}
                style={{ marginBottom: 10 }}
            >
                <strong>市場情報</strong>
                <div
                    style={{
                        fontSize: 13,
                        color: vars.color.mutedForeground,
                        marginTop: 4,
                    }}
                >
                    全球市場 · 熱門產業 · 題材 · 新聞摘要
                </div>
            </button>

            <button
                type="button"
                className={s.stockCard}
                onClick={onOpenSearch}
                disabled={!onOpenSearch}
            >
                <strong>搜尋股票</strong>
                <div
                    style={{
                        fontSize: 13,
                        color: vars.color.mutedForeground,
                        marginTop: 4,
                    }}
                >
                    輸入代號或名稱 → 進入詳情
                </div>
            </button>

            <div className={s.glass} style={{ padding: 16, marginTop: 8 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>研究工具</div>
                <div
                    style={{
                        fontSize: 13,
                        color: vars.color.mutedForeground,
                        lineHeight: 1.5,
                    }}
                >
                    回放、資金流、隔夜布局、版面設定 → 後續版本開放。
                    <br />
                    舊版多面板交易終端：網址加 <code>?legacy=1</code>
                    <br />
                    本系統為決策支援，不是自動下單或買賣建議機器人。
                </div>
            </div>

            {/* keep content above bottom nav */}
            <div className={s.pageEnd} />
        </>
    );
}

function HealthRow({
    label,
    value,
    ok,
}: {
    label: string;
    value: string;
    ok: boolean;
}) {
    return (
        <div
            style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '10px 0',
                gap: 12,
                minHeight: 44,
                alignItems: 'center',
                maxWidth: '100%',
            }}
        >
            <span
                style={{
                    fontSize: 13,
                    color: vars.color.mutedForeground,
                    flexShrink: 0,
                }}
            >
                {label}
            </span>
            <span
                style={{
                    fontSize: 13,
                    fontWeight: 700,
                    textAlign: 'right',
                    color: ok ? vars.color.foreground : '#fcd34d',
                    wordBreak: 'break-word',
                    overflowWrap: 'anywhere',
                    minWidth: 0,
                }}
            >
                {value}
            </span>
        </div>
    );
}
