// server/src/lib/web-notifications/repository.ts

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
    NotificationPreferences,
    WebNotification,
} from './types.ts';
import { DEFAULT_NOTIFICATION_PREFS } from './types.ts';

interface StoreShape {
    notifications: WebNotification[];
    preferences: NotificationPreferences;
}

export class NotificationRepository {
    private data: StoreShape = {
        notifications: [],
        preferences: { ...DEFAULT_NOTIFICATION_PREFS },
    };

    constructor(private filePath: string) {
        try {
            const raw = JSON.parse(readFileSync(filePath, 'utf8')) as StoreShape;
            this.data = {
                notifications: Array.isArray(raw.notifications)
                    ? raw.notifications
                    : [],
                preferences: {
                    ...DEFAULT_NOTIFICATION_PREFS,
                    ...(raw.preferences ?? {}),
                },
            };
        } catch {
            this.data = {
                notifications: [],
                preferences: { ...DEFAULT_NOTIFICATION_PREFS },
            };
        }
    }

    private save(): void {
        mkdirSync(dirname(this.filePath), { recursive: true });
        writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    }

    list(): WebNotification[] {
        return [...this.data.notifications];
    }

    prepend(n: WebNotification, maxStored: number): void {
        this.data.notifications = [n, ...this.data.notifications].slice(
            0,
            maxStored,
        );
        this.save();
    }

    markRead(id: string): boolean {
        const n = this.data.notifications.find((x) => x.notification_id === id);
        if (!n) return false;
        n.read = true;
        this.save();
        return true;
    }

    markAllRead(): number {
        let c = 0;
        for (const n of this.data.notifications) {
            if (!n.read) {
                n.read = true;
                c++;
            }
        }
        if (c) this.save();
        return c;
    }

    unreadCount(): number {
        return this.data.notifications.filter((n) => !n.read).length;
    }

    getPreferences(): NotificationPreferences {
        return { ...this.data.preferences };
    }

    setPreferences(p: Partial<NotificationPreferences>): NotificationPreferences {
        this.data.preferences = { ...this.data.preferences, ...p };
        this.save();
        return this.getPreferences();
    }

    /** Test helper — wipe without touching prefs unless asked. */
    __clearNotifications(): void {
        this.data.notifications = [];
        this.save();
    }
}
