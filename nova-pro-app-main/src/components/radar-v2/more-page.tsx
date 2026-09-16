import { useEffect, useState } from 'react';
import { vars } from '../../theme.css';
import {
    fetchLiveAcceptanceToday,
    finalizeLiveAcceptance,
    liveAcceptanceDownloadUrl,
    type LiveAcceptanceTodayDto,
} from '../../lib/live-acceptance';
import { liveStatusLabel } from './helpers';
import * as s from './radar.css';
import { radarColor } from './tokens';
import type { RadarFeed } from './use-radar-feed';

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
    const [laMsg, setLaMsg] = useState<string | null>(null);

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
        setLaMsg(null);
        try {
            const r = await finalizeLiveAcceptance();
            setLaMsg(`已產生 ${r.trading_day} 報告 · Overall ${r.overall}`);
            const d = await fetchLiveAcceptanceToday();
            setLa(d);
        } catch (e) {
            setLaMsg(e instanceof Error ? e.message : '產生失敗');
        } finally {
            setLaBusy(false);
        }
    };

    const overallTone =
        la?.overall === 'PASS'
            ? radarColor.live
            : la?.overall === 'FAIL'
              ? '#f87171'
              : '#fcd34d';

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

            <div className={s.glass} style={{ padding: 16, marginBottom: 14 }}>
                <div
                    style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 10,
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
                        {la?.overall ?? '—'}
                    </span>
                </div>
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
                                  .slice(0, 4)
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
                <div
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        marginTop: 14,
                    }}
                >
                    <button
                        type="button"
                        className={s.aiBtn}
                        disabled={laBusy}
                        onClick={() => void onFinalize()}
                        style={{ minHeight: 44 }}
                    >
                        {laBusy ? '產生中…' : '產生今日驗收報告'}
                    </button>
                    <a
                        href={liveAcceptanceDownloadUrl('md')}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            minHeight: 44,
                            borderRadius: 12,
                            border: `1px solid ${radarColor.glassBorder}`,
                            color: vars.color.foreground,
                            textDecoration: 'none',
                            fontSize: 14,
                            fontWeight: 600,
                        }}
                    >
                        下載完整報告
                    </a>
                    <a
                        href={liveAcceptanceDownloadUrl('csv')}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            minHeight: 44,
                            borderRadius: 12,
                            border: `1px solid ${radarColor.glassBorder}`,
                            color: vars.color.foreground,
                            textDecoration: 'none',
                            fontSize: 14,
                            fontWeight: 600,
                        }}
                    >
                        下載訊號樣本
                    </a>
                </div>
                {laMsg && (
                    <p
                        style={{
                            marginTop: 10,
                            fontSize: 12,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        {laMsg}
                    </p>
                )}
                <p
                    style={{
                        marginTop: 8,
                        fontSize: 11,
                        color: vars.color.mutedForeground,
                        lineHeight: 1.4,
                    }}
                >
                    僅評估 Data / Runtime / Architecture 品質，不評價策略好壞。不修改
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
                padding: '8px 0',
                gap: 12,
                minHeight: 44,
                alignItems: 'center',
            }}
        >
            <span style={{ fontSize: 13, color: vars.color.mutedForeground }}>
                {label}
            </span>
            <span
                style={{
                    fontSize: 13,
                    fontWeight: 700,
                    textAlign: 'right',
                    color: ok ? vars.color.foreground : '#fcd34d',
                }}
            >
                {value}
            </span>
        </div>
    );
}
