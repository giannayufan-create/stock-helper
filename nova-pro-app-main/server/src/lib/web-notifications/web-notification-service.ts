// server/src/lib/web-notifications/web-notification-service.ts
// Consumes BuyPressure events — NEVER mutates A/B/C / Heat / Rank.
// NEVER creates Shioaji upstream subscriptions.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BuyPressureItem } from '../buy-pressure/types.ts';
import type { SseHub } from '../../sse/hub.ts';
import {
    loadWebNotificationConfig,
    type WebNotificationConfig,
} from './config.ts';
import { buildNotificationReasons } from './reasons.ts';
import { NotificationRepository } from './repository.ts';
import {
    DEFAULT_NOTIFICATION_PREFS,
    EVENT_PRIORITY,
    EVENT_TIER,
    type NotificationEventType,
    type NotificationPreferences,
    type WebNotification,
} from './types.ts';

const NOTIFYABLE = new Set<NotificationEventType>([
    'EARLY_ENTER',
    'BUY_SURGE',
    'ASK_EATING',
    'VOLUME_BREAKOUT',
    'OVERHEATED_STRONG',
    'LARGE_BID_APPEAR',
    'RANK_ACCELERATION',
]);

/** Same symbol: max N emits in this window, regardless of upgrade. */
const GLOBAL_THROTTLE_WINDOW_MS = 10 * 60 * 1000;
const GLOBAL_THROTTLE_MAX = 2;

function mapBpEvent(
    type: string,
    item: BuyPressureItem,
): NotificationEventType | null {
    if (type === 'OVERHEATED' || type === 'OVERHEATED_STRONG') {
        if (
            item.overheated &&
            (item.heat_score ?? 0) >= 90 &&
            item.buy_pressure_score >= 80
        ) {
            return 'OVERHEATED_STRONG';
        }
        return null;
    }
    if (NOTIFYABLE.has(type as NotificationEventType)) {
        return type as NotificationEventType;
    }
    return null;
}

type EmitStats = {
    emitted: boolean;
    suppressed_cooldown?: boolean;
    suppressed_global_throttle?: boolean;
    duplicate?: boolean;
    priority?: 'HIGH' | 'MEDIUM' | 'INFO';
};

export class WebNotificationService {
    readonly cfg: WebNotificationConfig;
    private repo: NotificationRepository;
    private lastEmit = new Map<
        string,
        { type: NotificationEventType; at: number }
    >();
    private lastEmitAny = new Map<string, { timestamps: number[] }>();
    private lastTier = new Map<string, number>();
    private statePath: string;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private onStats: ((opts: EmitStats) => void) | null = null;

    constructor(
        filePath: string,
        private hub: SseHub | null = null,
        cfg?: WebNotificationConfig,
    ) {
        this.cfg = cfg ?? loadWebNotificationConfig();
        this.repo = new NotificationRepository(filePath);
        this.statePath = join(
            dirname(filePath),
            'notification-cooldown-state.json',
        );
        this.loadState();
    }

    /** Observe-only hook for Live Acceptance counters. */
    setAcceptanceObserver(fn: (opts: EmitStats) => void): void {
        this.onStats = fn;
    }

    getPreferences(): NotificationPreferences {
        return this.repo.getPreferences();
    }

    setPreferences(
        p: Partial<NotificationPreferences>,
    ): NotificationPreferences {
        return this.repo.setPreferences(p);
    }

    list(query: {
        unread?: boolean;
        event_type?: string;
        symbol?: string;
        limit?: number;
        since?: string;
    } = {}): WebNotification[] {
        let items = this.repo.list();
        if (query.unread === true) items = items.filter((n) => !n.read);
        if (query.event_type) {
            items = items.filter((n) => n.event_type === query.event_type);
        }
        if (query.symbol) {
            items = items.filter((n) => n.symbol === query.symbol);
        }
        if (query.since) {
            const t = Date.parse(query.since);
            if (Number.isFinite(t)) {
                items = items.filter((n) => Date.parse(n.created_at) >= t);
            }
        }
        const limit =
            query.limit != null && Number.isFinite(query.limit)
                ? Math.max(1, Math.min(100, query.limit))
                : 30;
        return items.slice(0, limit);
    }

    unreadCount(): number {
        return this.repo.unreadCount();
    }

    markRead(id: string): boolean {
        return this.repo.markRead(id);
    }

    markAllRead(): number {
        return this.repo.markAllRead();
    }

    /**
     * Ingest candidates from a Buy Pressure evaluate cycle.
     * Applies prefs, cooldown, upgrade rules, global throttle, data-stale gate.
     */
    ingestFromBuyPressure(items: BuyPressureItem[]): WebNotification[] {
        if (!this.cfg.enabled) return [];
        const prefs = this.repo.getPreferences();
        const created: WebNotification[] = [];

        for (const item of items) {
            if (item.data_stale) {
                continue;
            }
            const candidates = item.events.filter((e) => e.cycle_fresh);
            for (const ev of candidates) {
                const mapped = mapBpEvent(ev.event_type, item);
                if (!mapped) continue;
                if (!this.prefAllows(mapped, prefs)) continue;
                if (
                    prefs.min_buy_pressure != null &&
                    item.buy_pressure_score < prefs.min_buy_pressure
                ) {
                    continue;
                }
                if (
                    prefs.min_price != null &&
                    (item.last_price == null || item.last_price < prefs.min_price)
                ) {
                    continue;
                }
                if (
                    prefs.max_price != null &&
                    (item.last_price == null || item.last_price > prefs.max_price)
                ) {
                    continue;
                }

                const n = this.tryEmit(mapped, item, ev.timestamp, ev.reasons);
                if (n) created.push(n);
            }

            if (
                item.overheated &&
                (item.heat_score ?? 0) >= 90 &&
                item.buy_pressure_score >= 80 &&
                this.prefAllows('OVERHEATED_STRONG', prefs)
            ) {
                const n = this.tryEmit(
                    'OVERHEATED_STRONG',
                    item,
                    item.updated_at,
                );
                if (n) created.push(n);
            }
        }
        return created;
    }

    /** Unit-test entry: force evaluate emit rules. */
    tryEmit(
        type: NotificationEventType,
        item: BuyPressureItem,
        eventAt: string,
        reasonOverride?: string[],
    ): WebNotification | null {
        const symbol = item.symbol;
        const now = Date.now();
        const last = this.lastEmit.get(symbol);
        const tier = EVENT_TIER[type];
        const cooldownMs = (this.cfg.cooldown_sec[type] ?? 300) * 1000;

        if (last) {
            const lastCooldownMs =
                (this.cfg.cooldown_sec[last.type] ?? 300) * 1000;
            const sameTypeCooling =
                last.type === type && now - last.at < cooldownMs;
            const upgrade = tier > EVENT_TIER[last.type];
            const lowerOrEqualCooling =
                !upgrade && now - last.at < lastCooldownMs;
            if (sameTypeCooling || lowerOrEqualCooling) {
                this.onStats?.({
                    emitted: false,
                    suppressed_cooldown: true,
                    duplicate: sameTypeCooling,
                });
                return null;
            }
        }

        // Global throttle: same symbol, any type, max N in window.
        // Keeps upgrade semantics but caps spam (e.g. RANK → OVERHEATED chain).
        const recentTimestamps = (
            this.lastEmitAny.get(symbol)?.timestamps ?? []
        ).filter((t) => now - t < GLOBAL_THROTTLE_WINDOW_MS);
        if (recentTimestamps.length >= GLOBAL_THROTTLE_MAX) {
            this.onStats?.({
                emitted: false,
                suppressed_global_throttle: true,
            });
            return null;
        }

        const reasons =
            reasonOverride && reasonOverride.length
                ? reasonOverride.slice(0, 4)
                : buildNotificationReasons(type, item);
        const n: WebNotification = {
            notification_id: randomUUID(),
            symbol: item.symbol,
            name: item.name,
            event_type: type,
            priority: EVENT_PRIORITY[type],
            created_at: new Date().toISOString(),
            price: item.last_price,
            change_pct: item.change_pct,
            buy_pressure_score: item.buy_pressure_score,
            c_score: item.c_score,
            heat: item.heat_score,
            chase_risk: item.chase_risk,
            rank: item.rank,
            rank_prev: item.rank_prev,
            rank_velocity: item.rank_velocity,
            reasons,
            read: false,
            event_at: eventAt,
        };
        this.repo.prepend(n, this.cfg.max_stored);
        this.lastEmit.set(symbol, { type, at: now });
        this.lastEmitAny.set(symbol, {
            timestamps: [...recentTimestamps, now],
        });
        this.lastTier.set(symbol, Math.max(this.lastTier.get(symbol) ?? 0, tier));
        this.scheduleSave();
        this.hub?.broadcast('buy_pressure_notification', n);
        const rawPri = EVENT_PRIORITY[type] ?? 'MEDIUM';
        const pri =
            rawPri === 'HIGH'
                ? 'HIGH'
                : rawPri === 'MEDIUM'
                  ? 'MEDIUM'
                  : 'INFO';
        this.onStats?.({ emitted: true, priority: pri });
        return n;
    }

    private prefAllows(
        type: NotificationEventType,
        prefs: NotificationPreferences,
    ): boolean {
        switch (type) {
            case 'EARLY_ENTER':
                return prefs.early;
            case 'BUY_SURGE':
                return prefs.buy_surge;
            case 'ASK_EATING':
                return prefs.ask_eating;
            case 'VOLUME_BREAKOUT':
                return prefs.volume_breakout;
            case 'OVERHEATED_STRONG':
                return prefs.overheated_strong;
            case 'LARGE_BID_APPEAR':
                return prefs.large_bid;
            case 'RANK_ACCELERATION':
                return prefs.rank_acceleration;
            default:
                return false;
        }
    }

    private loadState(): void {
        try {
            const raw = JSON.parse(
                readFileSync(this.statePath, 'utf8'),
            ) as {
                lastEmit?: Array<[string, { type: NotificationEventType; at: number }]>;
                lastEmitAny?: Array<[string, { timestamps: number[] }]>;
                lastTier?: Array<[string, number]>;
            };
            this.lastEmit = new Map(raw.lastEmit ?? []);
            this.lastEmitAny = new Map(raw.lastEmitAny ?? []);
            this.lastTier = new Map(raw.lastTier ?? []);
        } catch {
            // Missing / corrupt state — start empty (do not fail boot).
            this.lastEmit = new Map();
            this.lastEmitAny = new Map();
            this.lastTier = new Map();
        }
    }

    private scheduleSave(): void {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            try {
                mkdirSync(dirname(this.statePath), { recursive: true });
                writeFileSync(
                    this.statePath,
                    JSON.stringify({
                        lastEmit: Array.from(this.lastEmit.entries()),
                        lastEmitAny: Array.from(this.lastEmitAny.entries()),
                        lastTier: Array.from(this.lastTier.entries()),
                        saved_at: new Date().toISOString(),
                    }),
                );
            } catch (e) {
                console.error(
                    '[web-notification-service] saveState failed:',
                    e,
                );
            }
        }, 500);
    }

    /** Reset cooldown memory (tests). */
    __resetCooldowns(): void {
        this.lastEmit.clear();
        this.lastEmitAny.clear();
        this.lastTier.clear();
    }

    __repo(): NotificationRepository {
        return this.repo;
    }

    __defaultPrefs(): NotificationPreferences {
        return { ...DEFAULT_NOTIFICATION_PREFS };
    }
}
