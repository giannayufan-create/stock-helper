// server/src/lib/event-intelligence/repository.ts
// Local JSON persistence — Firestore adapter reserved for later.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MarketEvent } from './types.ts';

export interface EventStoreFile {
    version: string;
    updated_at: string;
    events: MarketEvent[];
}

export class EventRepository {
    constructor(private path: string) {}

    load(): MarketEvent[] {
        try {
            if (!existsSync(this.path)) return [];
            const raw = JSON.parse(readFileSync(this.path, 'utf8')) as EventStoreFile;
            return Array.isArray(raw.events) ? raw.events : [];
        } catch {
            return [];
        }
    }

    save(events: MarketEvent[]): void {
        const dir = dirname(this.path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const payload: EventStoreFile = {
            version: 'ei_v1',
            updated_at: new Date().toISOString(),
            events,
        };
        writeFileSync(this.path, JSON.stringify(payload, null, 2), 'utf8');
    }
}

/** Future Firestore adapter stub — not wired in Phase 2. */
export interface EventStoreAdapter {
    load(): Promise<MarketEvent[]>;
    save(events: MarketEvent[]): Promise<void>;
}
