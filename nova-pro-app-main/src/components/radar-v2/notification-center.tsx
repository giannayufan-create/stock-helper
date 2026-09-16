// src/components/radar-v2/notification-center.tsx

import { useEffect, useState } from 'react';
import {
    EVENT_LABEL,
    fetchNotifications,
    markAllNotificationsRead,
    markNotificationRead,
    saveNotificationPreferences,
    type NotificationEventType,
    type NotificationPreferencesDto,
    type WebNotificationDto,
} from '../../lib/notifications';
import { vars } from '../../theme.css';
import * as s from './radar.css';
import { radarColor } from './tokens';

type FilterTab =
    | 'ALL'
    | 'UNREAD'
    | 'EARLY_ENTER'
    | 'BUY_SURGE'
    | 'ASK_EATING'
    | 'VOLUME_BREAKOUT'
    | 'OVERHEATED_STRONG';

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
        const load = () => {
            void fetchNotifications({ limit: 50 })
                .then((r) => {
                    if (cancelled) return;
                    setItems(r.items);
                    setPrefs(r.preferences);
                    onUnreadChange?.(r.unread_count);
                })
                .catch(() => undefined);
        };
        load();
        const t = setInterval(load, 3000);
        return () => {
            cancelled = true;
            clearInterval(t);
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
                            onClick={() => setShowPrefs((v) => !v)}
                        >
                            設定
                        </button>
                        <button
                            type="button"
                            className={s.linkBtn}
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
                            className={s.linkBtn}
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
                    <div className={s.empty}>尚無通知</div>
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

export function useNotificationToasts(
    enabled: boolean,
    onOpenSymbol: (symbol: string) => void,
) {
    const [toasts, setToasts] = useState<WebNotificationDto[]>([]);
    const [soundOn, setSoundOn] = useState(false);
    const seen = useState(() => new Set<string>())[0];

    useEffect(() => {
        void fetchNotificationPreferences()
            .then((p) => setSoundOn(p.sound))
            .catch(() => undefined);
    }, []);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        const poll = () => {
            void fetchNotifications({ unread: true, limit: 10 })
                .then((r) => {
                    if (cancelled) return;
                    setSoundOn(r.preferences.sound);
                    if (!r.preferences.toast) return;
                    const fresh = r.items.filter(
                        (n) => !seen.has(n.notification_id),
                    );
                    for (const n of fresh) seen.add(n.notification_id);
                    if (!fresh.length) return;
                    setToasts((prev) => [...fresh, ...prev].slice(0, 3));
                    if (r.preferences.sound && soundOn) {
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
                            // autoplay blocked — ignore
                        }
                    }
                })
                .catch(() => undefined);
        };
        poll();
        const t = setInterval(poll, 3000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, [enabled, seen, soundOn]);

    useEffect(() => {
        if (!toasts.length) return;
        const t = setTimeout(() => {
            setToasts((prev) => prev.slice(0, -1));
        }, 6500);
        return () => clearTimeout(t);
    }, [toasts]);

    return (
        <div
            style={{
                position: 'fixed',
                top: 'max(12px, env(safe-area-inset-top))',
                right: 12,
                left: 12,
                zIndex: 90,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                pointerEvents: 'none',
                maxWidth: 420,
                marginLeft: 'auto',
            }}
        >
            {toasts.map((n) => (
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
                        border: `1px solid ${radarColor.glassBorder}`,
                        background: 'rgba(8,12,20,0.94)',
                        color: vars.color.foreground,
                    }}
                    onClick={() => {
                        onOpenSymbol(n.symbol);
                        setToasts((prev) =>
                            prev.filter(
                                (x) => x.notification_id !== n.notification_id,
                            ),
                        );
                    }}
                >
                    <div style={{ fontWeight: 800 }}>
                        {EVENT_LABEL[n.event_type] ?? n.event_type}
                    </div>
                    <div style={{ marginTop: 4, fontWeight: 700 }}>
                        {n.symbol} {n.name}
                        {n.price != null ? ` · ${n.price.toFixed(2)}` : ''}
                        {n.change_pct != null
                            ? ` ${n.change_pct > 0 ? '+' : ''}${n.change_pct.toFixed(1)}%`
                            : ''}
                    </div>
                    <ul
                        style={{
                            margin: '8px 0 0',
                            paddingLeft: 18,
                            fontSize: 13,
                            color: vars.color.mutedForeground,
                        }}
                    >
                        {n.reasons.slice(0, 4).map((r) => (
                            <li key={r}>{r}</li>
                        ))}
                    </ul>
                    <div
                        style={{
                            marginTop: 8,
                            fontSize: 13,
                            color: radarColor.aiSoft,
                        }}
                    >
                        查看 ›
                    </div>
                </button>
            ))}
        </div>
    );
}
