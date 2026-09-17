// src/components/radar-v2/notification-center.tsx

import { useEffect, useRef, useState } from 'react';
import {
    EVENT_LABEL,
    fetchNotificationPreferences,
    fetchNotifications,
    fetchUnreadCount,
    markAllNotificationsRead,
    markNotificationRead,
    saveNotificationPreferences,
    type NotificationEventType,
    type NotificationPreferencesDto,
    type WebNotificationDto,
} from '../../lib/notifications';
import { ensureStream, onBuyPressureNotification } from '../../lib/stream';
import { vars } from '../../theme.css';
import * as s from './radar.css';
import { radarColor } from './tokens';
import { notificationPriority, type NotifPriority } from './ui-context';

type FilterTab =
    | 'ALL'
    | 'UNREAD'
    | 'EARLY_ENTER'
    | 'BUY_SURGE'
    | 'ASK_EATING'
    | 'VOLUME_BREAKOUT'
    | 'OVERHEATED_STRONG';

const PRIORITY_TONE: Record<NotifPriority, string> = {
    HIGH: radarColor.strong,
    MEDIUM: radarColor.heating,
    INFO: vars.color.mutedForeground,
};

function toastMs(p: NotifPriority): number {
    if (p === 'HIGH') return 8000;
    if (p === 'MEDIUM') return 6500;
    return 5000;
}

export function NotificationCenter({
    open,
    onClose,
    onOpenSymbol,
    onUnreadChange,
}: {
    open: boolean;
    onClose: () => void;
    onOpenSymbol: (symbol: string) => void;
    onUnreadChange?: (n: number) => void;
}) {
    const [tab, setTab] = useState<FilterTab>('ALL');
    const [items, setItems] = useState<WebNotificationDto[]>([]);
    const [prefs, setPrefs] = useState<NotificationPreferencesDto | null>(null);
    const [showPrefs, setShowPrefs] = useState(false);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        ensureStream();
        const load = () => {
            void fetchNotifications({ limit: 50 })
                .then((r) => {
                    if (cancelled) return;
                    setItems(r.items);
                    setPrefs(r.preferences);
                    onUnreadChange?.(r.unread_count);
                })
                .catch(() => {
                    if (cancelled) return;
                    setItems([]);
                    onUnreadChange?.(0);
                });
        };
        load();
        // SSE primary path — immediate refresh on hub event
        const unsub = onBuyPressureNotification(() => {
            if (!cancelled) load();
        });
        // Slow poll as reconnect/fallback only
        const t = setInterval(load, 15_000);
        return () => {
            cancelled = true;
            clearInterval(t);
            unsub();
        };
    }, [open, onUnreadChange]);

    if (!open) return null;

    const filtered = items.filter((n) => {
        if (tab === 'UNREAD') return !n.read;
        if (tab === 'ALL') return true;
        return n.event_type === tab;
    });

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 80,
                background: 'rgba(0,0,0,0.55)',
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'center',
            }}
            onClick={onClose}
        >
            <div
                className={s.glass}
                style={{
                    width: '100%',
                    maxWidth: 480,
                    maxHeight: '85vh',
                    overflow: 'auto',
                    borderRadius: '20px 20px 0 0',
                    padding: 16,
                    paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div className={s.sectionRow}>
                    <div className={s.sectionTitle} style={{ marginBottom: 0 }}>
                        通知中心
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button
                            type="button"
                            className={s.linkBtn}
                            style={{ minWidth: 44, minHeight: 44, padding: '0 12px' }}
                            onClick={() => setShowPrefs((v) => !v)}
                        >
                            設定
                        </button>
                        <button
                            type="button"
                            className={s.linkBtn}
                            style={{ minWidth: 44, minHeight: 44, padding: '0 12px' }}
                            onClick={() => {
                                void markAllNotificationsRead().then((r) => {
                                    setItems((prev) =>
                                        prev.map((x) => ({ ...x, read: true })),
                                    );
                                    onUnreadChange?.(r.unread_count);
                                });
                            }}
                        >
                            全部已讀
                        </button>
                        <button
                            type="button"
                            className={s.iconBtn}
                            aria-label="關閉通知中心"
                            onClick={onClose}
                        >
                            ✕
                        </button>
                    </div>
                </div>

                {showPrefs && prefs && (
                    <PrefsPanel
                        prefs={prefs}
                        onChange={(p) => {
                            setPrefs(p);
                            void saveNotificationPreferences(p);
                        }}
                    />
                )}

                <div className={s.quickBar} style={{ marginBottom: 10 }}>
                    {(
                        [
                            ['ALL', '全部'],
                            ['UNREAD', '未讀'],
                            ['EARLY_ENTER', 'EARLY'],
                            ['BUY_SURGE', '買盤加速'],
                            ['ASK_EATING', '吃單'],
                            ['VOLUME_BREAKOUT', '突破'],
                            ['OVERHEATED_STRONG', '過熱強勢'],
                        ] as const
                    ).map(([id, lab]) => (
                        <button
                            key={id}
                            type="button"
                            className={`${s.quickBtn} ${
                                tab === id ? s.tabChipOn : ''
                            }`}
                            style={{ minHeight: 44 }}
                            onClick={() => setTab(id)}
                        >
                            {lab}
                        </button>
                    ))}
                </div>

                {filtered.length === 0 && (
                    <div className={s.empty}>
                        尚無通知（雲端重啟後歷史通知會清空）
                    </div>
                )}
                {filtered.map((n) => (
                    <button
                        key={n.notification_id}
                        type="button"
                        className={s.stockCard}
                        style={{
                            width: '100%',
                            textAlign: 'left',
                            marginBottom: 8,
                            opacity: n.read ? 0.65 : 1,
                            minHeight: 44,
                        }}
                        onClick={() => {
                            void markNotificationRead(n.notification_id).then(
                                (r) => {
                                    setItems((prev) =>
                                        prev.map((x) =>
                                            x.notification_id ===
                                            n.notification_id
                                                ? { ...x, read: true }
                                                : x,
                                        ),
                                    );
                                    onUnreadChange?.(r.unread_count);
                                },
                            );
                            onOpenSymbol(n.symbol);
                            onClose();
                        }}
                    >
                        <div style={{ fontWeight: 700 }}>
                            {EVENT_LABEL[n.event_type as NotificationEventType] ??
                                n.event_type}{' '}
                            · {n.symbol} {n.name}
                        </div>
                        <div
                            style={{
                                fontSize: 13,
                                color: vars.color.mutedForeground,
                                marginTop: 4,
                            }}
                        >
                            {n.price != null ? n.price.toFixed(2) : '—'}{' '}
                            {n.change_pct != null
                                ? `${n.change_pct > 0 ? '+' : ''}${n.change_pct.toFixed(2)}%`
                                : ''}
                            {n.buy_pressure_score != null
                                ? ` · BP ${Math.round(n.buy_pressure_score)}`
                                : ''}
                        </div>
                        <ul
                            style={{
                                margin: '8px 0 0',
                                paddingLeft: 18,
                                fontSize: 13,
                            }}
                        >
                            {n.reasons.map((r) => (
                                <li key={r}>{r}</li>
                            ))}
                        </ul>
                    </button>
                ))}
            </div>
        </div>
    );
}

function PrefsPanel({
    prefs,
    onChange,
}: {
    prefs: NotificationPreferencesDto;
    onChange: (p: NotificationPreferencesDto) => void;
}) {
    const toggle = (key: keyof NotificationPreferencesDto) => {
        onChange({ ...prefs, [key]: !prefs[key] });
    };
    return (
        <div
            className={s.glass}
            style={{ padding: 12, marginBottom: 12, background: radarColor.glass }}
        >
            {(
                [
                    ['early', '開始轉強'],
                    ['buy_surge', '買盤加速'],
                    ['ask_eating', '正在吃單'],
                    ['volume_breakout', '放量突破'],
                    ['overheated_strong', '過熱強勢'],
                    ['large_bid', '大額委買'],
                    ['toast', 'Toast'],
                    ['sound', '聲音'],
                ] as const
            ).map(([k, lab]) => (
                <label
                    key={k}
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        minHeight: 44,
                        fontSize: 14,
                    }}
                >
                    <input
                        type="checkbox"
                        checked={Boolean(prefs[k])}
                        onChange={() => toggle(k)}
                    />
                    {lab}
                </label>
            ))}
        </div>
    );
}

export type ToastContextFn = (symbol: string) => {
    sector?: string | null;
    market?: string | null;
} | null;

export function useNotificationToasts(
    enabled: boolean,
    onOpenSymbol: (symbol: string) => void,
    onUnreadBump?: (n: number) => void,
    contextFor?: ToastContextFn,
) {
    const [toasts, setToasts] = useState<WebNotificationDto[]>([]);
    const [soundOn, setSoundOn] = useState(false);
    const [toastEnabled, setToastEnabled] = useState(true);
    const seenRef = useRef(new Set<string>());
    const contextRef = useRef(contextFor);
    contextRef.current = contextFor;

    const playBeep = () => {
        try {
            const ctx = new AudioContext();
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.connect(g);
            g.connect(ctx.destination);
            g.gain.value = 0.04;
            o.frequency.value = 880;
            o.start();
            o.stop(ctx.currentTime + 0.08);
        } catch {
            // autoplay blocked
        }
    };

    const ingest = (n: WebNotificationDto, prefsToast: boolean, prefsSound: boolean) => {
        if (seenRef.current.has(n.notification_id)) return;
        seenRef.current.add(n.notification_id);
        if (!prefsToast) return;
        setToasts((prev) => [n, ...prev].slice(0, 3));
        if (prefsSound) playBeep();
    };

    useEffect(() => {
        void fetchNotificationPreferences()
            .then((p) => {
                setSoundOn(p.sound);
                setToastEnabled(p.toast);
            })
            .catch(() => undefined);
    }, []);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        ensureStream();

        // Primary: SSE hub event — payload is the WebNotification DTO
        const unsub = onBuyPressureNotification((payload) => {
            if (cancelled || !payload || typeof payload !== 'object') return;
            const n = payload as WebNotificationDto;
            if (!n.notification_id || !n.symbol) return;
            ingest(n, toastEnabled, soundOn);
            void fetchUnreadCount()
                .then((r) => {
                    if (!cancelled) onUnreadBump?.(r.unread_count);
                })
                .catch(() => undefined);
        });

        // Fallback poll only (reconnect / missed events) — not primary path
        const poll = () => {
            void fetchNotifications({ unread: true, limit: 10 })
                .then((r) => {
                    if (cancelled) return;
                    setSoundOn(r.preferences.sound);
                    setToastEnabled(r.preferences.toast);
                    onUnreadBump?.(r.unread_count);
                    if (!r.preferences.toast) return;
                    for (const n of r.items) {
                        ingest(n, r.preferences.toast, r.preferences.sound);
                    }
                })
                .catch(() => undefined);
        };
        poll();
        const t = setInterval(poll, 20_000);
        return () => {
            cancelled = true;
            clearInterval(t);
            unsub();
        };
    }, [enabled, soundOn, toastEnabled, onUnreadBump]);

    useEffect(() => {
        if (!toasts.length) return;
        const head = toasts[0]!;
        const p = notificationPriority(head.event_type);
        const t = setTimeout(() => {
            setToasts((prev) => prev.slice(1));
        }, toastMs(p));
        return () => clearTimeout(t);
    }, [toasts]);

    return (
        <div
            style={{
                position: 'fixed',
                top: 'max(56px, calc(44px + env(safe-area-inset-top)))',
                right: 12,
                left: 12,
                bottom: 'auto',
                zIndex: 90,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                pointerEvents: 'none',
                maxWidth: 420,
                marginLeft: 'auto',
                paddingBottom: 0,
            }}
            data-toast-layer="buy-pressure"
        >
            {toasts.map((n) => {
                const p = notificationPriority(n.event_type);
                const rankDelta =
                    n.rank != null && n.rank_prev != null
                        ? n.rank_prev - n.rank
                        : null;
                const ctx = contextRef.current?.(n.symbol);
                return (
                    <button
                        key={n.notification_id}
                        type="button"
                        className={s.glass}
                        style={{
                            pointerEvents: 'auto',
                            textAlign: 'left',
                            padding: 14,
                            borderRadius: 16,
                            minHeight: 44,
                            border: `1px solid ${PRIORITY_TONE[p]}55`,
                            background: 'rgba(8,12,20,0.94)',
                            color: vars.color.foreground,
                        }}
                        onClick={() => {
                            onOpenSymbol(n.symbol);
                            setToasts((prev) =>
                                prev.filter(
                                    (x) =>
                                        x.notification_id !== n.notification_id,
                                ),
                            );
                        }}
                    >
                        <div
                            style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                gap: 8,
                            }}
                        >
                            <div style={{ fontWeight: 800 }}>
                                {EVENT_LABEL[n.event_type] ?? n.event_type}
                            </div>
                            <span
                                style={{
                                    fontSize: 10,
                                    fontWeight: 800,
                                    letterSpacing: '0.06em',
                                    color: PRIORITY_TONE[p],
                                }}
                            >
                                {p}
                            </span>
                        </div>
                        <div style={{ marginTop: 4, fontWeight: 700 }}>
                            {n.symbol} {n.name}
                            {n.change_pct != null
                                ? ` · ${n.change_pct > 0 ? '+' : ''}${n.change_pct.toFixed(1)}%`
                                : ''}
                        </div>
                        <div
                            style={{
                                marginTop: 6,
                                fontSize: 12,
                                color: vars.color.mutedForeground,
                                fontFamily: vars.font.mono,
                            }}
                        >
                            BP {n.buy_pressure_score != null ? Math.round(n.buy_pressure_score) : '—'}
                            {' · '}C {n.c_score != null ? Math.round(n.c_score) : '—'}
                            {rankDelta != null
                                ? ` · Rank ${rankDelta > 0 ? `↑${rankDelta}` : rankDelta < 0 ? `↓${Math.abs(rankDelta)}` : '—'}`
                                : ''}
                            {n.chase_risk ? ` · Chase ${n.chase_risk}` : ''}
                        </div>
                        <div
                            style={{
                                marginTop: 4,
                                fontSize: 11,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            Sector {ctx?.sector || '—'}
                            {' · '}Market {ctx?.market || '—'}
                        </div>
                        <ul
                            style={{
                                margin: '8px 0 0',
                                paddingLeft: 18,
                                fontSize: 13,
                                color: vars.color.mutedForeground,
                            }}
                        >
                            {n.reasons.slice(0, 3).map((r) => (
                                <li key={r}>{r}</li>
                            ))}
                        </ul>
                    </button>
                );
            })}
        </div>
    );
}
