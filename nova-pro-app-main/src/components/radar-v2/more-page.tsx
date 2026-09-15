import { vars } from '../../theme.css';
import * as s from './radar.css';
import { radarColor } from './tokens';
import type { RadarFeed } from './use-radar-feed';

export function MorePage({
    feed,
    onOpenSearch,
}: {
    feed: RadarFeed;
    onOpenSearch?: () => void;
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

    return (
        <>
            <div className={s.sectionTitle}>更多</div>

            <div className={s.glass} style={{ padding: 16, marginBottom: 14 }}>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>
                    行情狀態
                </div>
                <HealthRow
                    label="Live Status"
                    value={feed.liveStatus}
                    ok={feed.liveStatus === 'LIVE'}
                />
                <HealthRow
                    label="As of"
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
                    label="B Coverage"
                    value={coverageB != null ? `${coverageB}%` : '—'}
                    ok={coverageB == null || coverageB >= 70}
                />
                <HealthRow
                    label="C Coverage"
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
                    代號或名稱 → 進入 Detail
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
                    Replay、資金流、隔夜布局、版面設定 → Phase 3。
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
                borderBottom: `1px solid ${radarColor.glassBorder}`,
                fontSize: 14,
            }}
        >
            <span style={{ color: vars.color.mutedForeground }}>{label}</span>
            <span
                style={{
                    fontFamily: vars.font.mono,
                    fontWeight: 700,
                    color: ok ? radarColor.health : radarColor.healthBad,
                }}
            >
                {value}
            </span>
        </div>
    );
}
