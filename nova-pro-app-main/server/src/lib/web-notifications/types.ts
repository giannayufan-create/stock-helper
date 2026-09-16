// server/src/lib/web-notifications/types.ts
// Notification consumer of Buy Pressure events — NEVER mutates A/B/C.

export const WN_VERSION = 'wn_v1';

export type NotificationEventType =
    | 'EARLY_ENTER'
    | 'BUY_SURGE'
    | 'ASK_EATING'
    | 'VOLUME_BREAKOUT'
    | 'OVERHEATED_STRONG'
    | 'LARGE_BID_APPEAR'
    | 'RANK_ACCELERATION';

export type NotificationPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface WebNotification {
    notification_id: string;
    symbol: string;
    name: string;
    event_type: NotificationEventType;
    priority: NotificationPriority;
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
    /** Source event timestamp — for freshness display. */
    event_at: string;
}

export interface NotificationPreferences {
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

export const DEFAULT_NOTIFICATION_PREFS: NotificationPreferences = {
    early: true,
    buy_surge: true,
    ask_eating: true,
    volume_breakout: true,
    overheated_strong: true,
    large_bid: false,
    rank_acceleration: false,
    min_buy_pressure: 65,
    min_price: null,
    max_price: null,
    market: 'ALL',
    sound: false,
    toast: true,
};

/** Upgrade rank — higher can notify even if lower is still in cooldown. */
export const EVENT_TIER: Record<NotificationEventType, number> = {
    EARLY_ENTER: 1,
    LARGE_BID_APPEAR: 2,
    RANK_ACCELERATION: 2,
    OVERHEATED_STRONG: 3,
    BUY_SURGE: 4,
    ASK_EATING: 5,
    VOLUME_BREAKOUT: 6,
};

export const EVENT_PRIORITY: Record<
    NotificationEventType,
    NotificationPriority
> = {
    EARLY_ENTER: 'MEDIUM',
    BUY_SURGE: 'HIGH',
    ASK_EATING: 'HIGH',
    VOLUME_BREAKOUT: 'HIGH',
    OVERHEATED_STRONG: 'MEDIUM',
    LARGE_BID_APPEAR: 'LOW',
    RANK_ACCELERATION: 'MEDIUM',
};
