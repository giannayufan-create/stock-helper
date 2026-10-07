// src/components/radar-v2/preopen-live-section.tsx — 盤前即時名單（08:30–09:10）
// 試撮排名、是否掛在漲停價、在前 10 名待了幾分鐘；09:00 後改看漲停封單。只讀。

import { useEffect, useState, type ReactNode } from 'react';
import {
    fetchPreopenLive,
    inPreopenUiWindow,
    sourceLabel,
    type PreopenLiveDto,
    type PreopenLiveItem,
} from '../../lib/preopen-live';
import { isHostedApi } from '../../lib/runtime';
import { vars } from '../../theme.css';
import * as s from './radar.css';
import { radarColor } from './tokens';

const SHOW_DEFAULT = 20;

function fmtTime(iso: string | null) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('zh-TW', {
        timeZone: 'Asia/Taipei',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

function fmtPct(n: number | null) {
    if (n == null || !Number.isFinite(n)) return '—';
    return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtPrice(n: number | null) {
    if (n == null || !Number.isFinite(n) || n <= 0) return '—';
    return n >= 100 ? n.toFixed(1) : n.toFixed(2);
}

function Pill({ color, bg, children }: { color: string; bg: string; children: ReactNode }) {
    return (
        <span
            style={{
                fontSize: 11,
                fontWeight: 700,
                padding: '2px 6px',
                borderRadius: 6,
                color,
                background: bg,
                whiteSpace: 'nowrap',
            }}
        >
            {children}
        </span>
    );
}

function QueueCell({ it }: { it: PreopenLiveItem }) {
    if (it.locked == null) {
        return <span style={{ color: vars.color.mutedForeground, fontSize: 12 }}>等封單…</span>;
    }
    if (it.locked) {
        return (
            <span style={{ color: radarColor.strong, fontWeight: 700 }}>
                鎖 {(it.queue_lots ?? 0).toLocaleString('zh-TW')} 張
            </span>
        );
    }
    return (
        <span style={{ color: it.at_limit ? radarColor.heating : vars.color.mutedForeground, fontWeight: 600 }}>
            {it.at_limit ? '打開' : '未鎖'} {fmtPrice(it.last_price)}
        </span>
    );
}

export function PreopenLiveSection({ onOpenSymbol }: { onOpenSymbol: (symbol: string) => void }) {
    const [dto, setDto] = useState<PreopenLiveDto | null>(null);
    const [active, setActive] = useState(() => inPreopenUiWindow());
    const [err, setErr] = useState<string | null>(null);
    const [showAll, setShowAll] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const load = () => {
            const inWindow = inPreopenUiWindow();
            setActive(inWindow);
            if (!inWindow || document.hidden) return;
            void fetchPreopenLive(isHostedApi() ? 20_000 : 10_000)
                .then((d) => {
                    if (cancelled) return;
                    setDto(d);
                    setErr(null);
                })
                .catch(() => {
                    if (!cancelled) setErr('盤前名單暫時無法載入');
                });
        };
        load();
        const t = setInterval(load, 10_000);
        const onVis = () => {
            if (!document.hidden) load();
        };
        document.addEventListener('visibilitychange', onVis);
        return () => {
            cancelled = true;
            clearInterval(t);
            document.removeEventListener('visibilitychange', onVis);
        };
    }, []);

    if (!active) return null;
    if (dto && (dto.phase === 'before' || dto.phase === 'after')) return null;

    const isOpen = dto?.phase === 'open';
    const items = dto?.items ?? [];
    const shown = showAll ? items : items.slice(0, SHOW_DEFAULT);
    const atLimit = items.filter((it) => it.at_limit).length;
    const lockedNow = items.filter((it) => it.locked).length;
    const liveSource = dto?.source === 'shioaji' || dto?.source === 'fugle';

    return (
        <section style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em' }}>
                    {isOpen ? '開盤封單' : '盤前即時名單'}
                </div>
                <div style={{ fontSize: 12, color: vars.color.mutedForeground, fontVariantNumeric: 'tabular-nums' }}>
                    {isOpen ? `封單 ${fmtTime(dto?.queue_at ?? null)}` : `試撮 ${fmtTime(dto?.ranked_at ?? null)}`}
                    {sourceLabel(isOpen ? dto?.queue_source : dto?.source) &&
                        ` · ${sourceLabel(isOpen ? dto?.queue_source : dto?.source)}`}
                </div>
            </div>
            <div style={{ marginTop: 4, marginBottom: 10, fontSize: 12, color: vars.color.mutedForeground }}>
                {items.length
                    ? isOpen
                        ? `盤前前 ${items.length} 檔 · 鎖漲停 ${lockedNow} 檔 · 試撮在漲停 ${atLimit} 檔`
                        : `前 ${items.length} 檔 · 試撮在漲停 ${atLimit} 檔 · 試撮委託可取消，越接近 09:00、在前 10 名待越久越可信`
                    : '等待第一份盤前排名…'}
            </div>

            {err && (
                <div className={`${s.banner} ${s.bannerBad}`} style={{ margin: '0 0 10px' }}>
                    {err}
                </div>
            )}
            {dto && items.length > 0 && !liveSource && (
                <div className={s.banner} style={{ margin: '0 0 10px' }}>
                    目前不是即時試撮排名，僅供參考
                </div>
            )}

            {shown.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {shown.map((it) => (
                        <button
                            key={it.code}
                            type="button"
                            className={s.glass}
                            onClick={() => onOpenSymbol(it.code)}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                                width: '100%',
                                padding: '10px 12px',
                                textAlign: 'left',
                                color: 'inherit',
                                cursor: 'pointer',
                                borderLeft: `3px solid ${it.at_limit ? radarColor.strong : 'transparent'}`,
                            }}
                        >
                            <div
                                style={{
                                    width: 22,
                                    fontSize: 13,
                                    color: vars.color.mutedForeground,
                                    fontVariantNumeric: 'tabular-nums',
                                    flexShrink: 0,
                                }}
                            >
                                {it.rank}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                                    <span style={{ fontWeight: 700, fontSize: 15 }}>{it.name}</span>
                                    <span style={{ fontSize: 12, color: vars.color.mutedForeground }}>{it.code}</span>
                                </div>
                                <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                    {it.at_limit && (
                                        <Pill color={radarColor.strong} bg={radarColor.strongDim}>
                                            試撮漲停
                                        </Pill>
                                    )}
                                    {it.top10_minutes > 0 && (
                                        <Pill
                                            color={it.top10_minutes >= 10 ? radarColor.live : vars.color.mutedForeground}
                                            bg={it.top10_minutes >= 10 ? 'rgba(52, 211, 153, 0.14)' : radarColor.glassHighlight}
                                        >
                                            前10 · {it.top10_minutes} 分
                                        </Pill>
                                    )}
                                </div>
                            </div>
                            <div
                                style={{
                                    textAlign: 'right',
                                    flexShrink: 0,
                                    fontVariantNumeric: 'tabular-nums',
                                }}
                            >
                                <div
                                    style={{
                                        fontSize: 15,
                                        fontWeight: 700,
                                        color: (it.trial_pct ?? 0) > 0 ? radarColor.strong : vars.color.foreground,
                                    }}
                                >
                                    {fmtPct(it.trial_pct)}
                                </div>
                                <div style={{ fontSize: 12, marginTop: 2 }}>
                                    {isOpen ? (
                                        <QueueCell it={it} />
                                    ) : (
                                        <span style={{ color: vars.color.mutedForeground }}>
                                            {fmtPrice(it.trial_price)}
                                            {it.limit_up_price ? ` / 停 ${fmtPrice(it.limit_up_price)}` : ''}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            )}

            {items.length > SHOW_DEFAULT && (
                <button
                    type="button"
                    className={s.quickBtn}
                    onClick={() => setShowAll((v) => !v)}
                    style={{ marginTop: 8 }}
                >
                    {showAll ? `只看前 ${SHOW_DEFAULT}` : `顯示全部 ${items.length} 檔`}
                </button>
            )}
        </section>
    );
}
