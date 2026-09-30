// server/src/lib/strategy-signal/raw-signal-store.ts
// Append-only JSONL store for RawSignalEvent.
// Application-layer non-overwrite — NOT cryptographic tamper-evidence.
// No update/delete methods for normal app flow.

import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
    AppendRawResult,
    RawSignalEvent,
} from './raw-signal-event.ts';

function defaultRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', 'data', 'raw_strategy_signals');
}

function taipeiYmd(iso?: string): string {
    const d = iso ? new Date(iso) : new Date();
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

export class RawSignalStore {
    private root: string;
    private known = new Set<string>();
    private cache = new Map<string, RawSignalEvent>();
    private sidecar: string;

    constructor(root = defaultRoot()) {
        this.root = root;
        this.sidecar = join(this.root, 'known_ids.json');
        if (!existsSync(this.root)) {
            mkdirSync(this.root, { recursive: true });
        }
        this.hydrateKnownIds();
    }

    rootDir(): string {
        return this.root;
    }

    knownIds(): Set<string> {
        return new Set(this.known);
    }

    /** Restart hydrate: sidecar + scan JSONL. */
    hydrateKnownIds(): void {
        this.known.clear();
        if (existsSync(this.sidecar)) {
            try {
                const raw = JSON.parse(
                    readFileSync(this.sidecar, 'utf8'),
                ) as { ids?: string[] };
                for (const id of raw.ids ?? []) this.known.add(id);
            } catch {
                /* ignore corrupt sidecar */
            }
        }
        if (!existsSync(this.root)) return;
        for (const f of readdirSync(this.root)) {
            if (!f.endsWith('.jsonl')) continue;
            const ymd = f.replace(/\.jsonl$/, '');
            for (const ev of this.listByDate(ymd)) {
                this.known.add(ev.signal_id);
                this.cache.set(ev.signal_id, ev);
            }
        }
        this.persistKnown();
    }

    private persistKnown(): void {
        try {
            mkdirSync(this.root, { recursive: true });
            writeFileSync(
                this.sidecar,
                `${JSON.stringify({ ids: [...this.known] })}\n`,
            );
        } catch {
            /* best-effort */
        }
    }

    /**
     * Append only. Same signal_id → SKIP_IDEMPOTENT (no second write).
     * Content mismatch with known id is also treated as SKIP (never overwrite).
     */
    append(event: RawSignalEvent): AppendRawResult {
        if (!event?.signal_id) {
            return {
                ok: false,
                status: 'REJECTED',
                reason: 'missing_signal_id',
            };
        }
        if (this.known.has(event.signal_id) || this.cache.has(event.signal_id)) {
            return { ok: true, status: 'SKIP_IDEMPOTENT' };
        }
        const ymd = taipeiYmd(event.signal_time);
        const file = join(this.root, `${ymd}.jsonl`);
        appendFileSync(file, `${JSON.stringify(event)}\n`);
        this.cache.set(event.signal_id, structuredClone(event));
        this.known.add(event.signal_id);
        this.persistKnown();
        return { ok: true, status: 'APPENDED' };
    }

    findById(signalId: string): RawSignalEvent | null {
        if (this.cache.has(signalId)) {
            return structuredClone(this.cache.get(signalId)!);
        }
        for (const ev of this.listRange('1970-01-01', '9999-12-31')) {
            if (ev.signal_id === signalId) return structuredClone(ev);
        }
        return null;
    }

    listByDate(ymd: string): RawSignalEvent[] {
        const file = join(this.root, `${ymd}.jsonl`);
        if (!existsSync(file)) return [];
        return readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as RawSignalEvent);
    }

    listRange(fromYmd: string, toYmd: string): RawSignalEvent[] {
        if (!existsSync(this.root)) return [];
        const files = readdirSync(this.root)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => f.replace(/\.jsonl$/, ''))
            .filter((d) => d >= fromYmd && d <= toYmd)
            .sort();
        return files.flatMap((d) => this.listByDate(d));
    }

    // Intentionally NO update() / delete() for normal app flow.
}
