// src/lib/notifications.ts — Web Notification Center client

import { apiGet, apiPost, apiPut } from './api';

export type NotificationEventType =
    | 'EARLY_ENTER'
    | 'BUY_SURGE'
    | 'ASK_EATING'
    | 'VOLUME_BREAKOUT'
    | 'OVERHEATED_STRONG'
    | 'LARGE_BID_APPEAR'
    | 'RANK_ACCELERATION';

export interface WebNotificationDto {
    notification_id: string;
    symbol: string;
    name: string;
    event_type: NotificationEventType;
    priority: string;
    created_at: string;
    price: number | null;
    change_pct: number | null;
    buy_pressure_score: number | null;
    c_score: number | null;
    heat: number | null;
    chase_risk: string | null;
    rank: number | null;
    rank_prev: number | null;
    rank_velocity: number | null;
    reasons: string[];
    read: boolean;
    event_at: string;
}

export interface NotificationPreferencesDto {
    early: boolean;
    buy_surge: boolean;
    ask_eating: boolean;
    volume_breakout: boolean;
    overheated_strong: boolean;
    large_bid: boolean;
    rank_acceleration: boolean;
    min_buy_pressure: number;
    min_price: number | null;
    max_price: number | null;
    market: 'ALL' | 'TSE' | 'OTC';
    sound: boolean;
    toast: boolean;
}

export function fetchNotifications(query: {
    unread?: boolean;
    event_type?: string;
    limit?: number;
} = {}) {
    const qs = new URLSearchParams();
    if (query.unread != null) qs.set('unread', String(query.unread));
    if (query.event_type) qs.set('event_type', query.event_type);
    if (query.limit != null) qs.set('limit', String(query.limit));
    const suffix = qs.toString() ? `?${qs}` : '';
    return apiGet<{
        items: WebNotificationDto[];
        unread_count: number;
        preferences: NotificationPreferencesDto;
    }>(`/api/v1/notifications${suffix}`);
}

export function fetchUnreadCount() {
    return apiGet<{ unread_count: number }>(
        '/api/v1/notifications/unread-count',
    );
}

export function markNotificationRead(id: string) {
    return apiPost<{ ok: boolean; unread_count: number }>(
        `/api/v1/notifications/${encodeURIComponent(id)}/read`,
        {},
    );
}

export function markAllNotificationsRead() {
    return apiPost<{ ok: boolean; unread_count: number }>(
        '/api/v1/notifications/mark-all-read',
        {},
    );
}

export function fetchNotificationPreferences() {
    return apiGet<NotificationPreferencesDto>(
        '/api/v1/notifications/preferences',
    );
}

export function saveNotificationPreferences(
    prefs: Partial<NotificationPreferencesDto>,
) {
    return apiPut<NotificationPreferencesDto>(
        '/api/v1/notifications/preferences',
        prefs,
    );
}

export const EVENT_LABEL: Record<NotificationEventType, string> = {
    EARLY_ENTER: '🟡 開始轉強',
    BUY_SURGE: '🔥 買盤加速',
    ASK_EATING: '⚡ 正在吃單',
    VOLUME_BREAKOUT: '🚀 放量突破',
    OVERHEATED_STRONG: '⚠ 過熱強勢',
    LARGE_BID_APPEAR: '💰 大額委買',
    RANK_ACCELERATION: '📈 Rank 加速',
};
