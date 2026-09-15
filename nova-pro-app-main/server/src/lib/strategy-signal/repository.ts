// server/src/lib/strategy-signal/repository.ts
// JSONL only via this interface — no scattered fs.appendFile in B/C.

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
import type { SignalType, StrategySignal } from './types.ts';

export interface StrategySignalRepository {
    save(signal: StrategySignal): void;
    findById(signalId: string): StrategySignal | null;
    listByDate(ymd: string): StrategySignal[];
    listByType(type: SignalType, ymd?: string): StrategySignal[];
    listRange(fromYmd: string, toYmd: string): StrategySignal[];
    /** Known signal_ids (disk + memory) — for restart dedupe. */
    knownIds(): Set<string>;
    hydrateKnownIds(): void;
}

function defaultRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', 'data', 'signals');
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

export class JsonlStrategySignalRepository implements StrategySignalRepository {
    private root: string;
    private cache = new Map<string, StrategySignal>();
    private known = new Set<string>();
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

    hydrateKnownIds(): void {
        this.known.clear();
        // Sidecar set (fast path)
        if (existsSync(this.sidecar)) {
            try {
                const raw = JSON.parse(
                    readFileSync(this.sidecar, 'utf8'),
                ) as { ids?: string[] };
                for (const id of raw.ids ?? []) this.known.add(id);
            } catch {
                /* ignore */
            }
        }
        // Scan JSONL for any missing ids
        if (!existsSync(this.root)) return;
        for (const f of readdirSync(this.root)) {
            if (!f.endsWith('.jsonl')) continue;
            const ymd = f.replace(/\.jsonl$/, '');
            for (const s of this.listByDate(ymd)) {
                this.known.add(s.signal_id);
                this.cache.set(s.signal_id, s);
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

    save(signal: StrategySignal): void {
        // Immutable: reject overwrite / duplicate append even after restart
        if (
            this.cache.has(signal.signal_id) ||
            this.known.has(signal.signal_id)
        ) {
            throw new Error(
                `feature_snapshot immutable: signal ${signal.signal_id} already saved`,
            );
        }
        const ymd = taipeiYmd(signal.signal_time);
        const file = join(this.root, `${ymd}.jsonl`);
        appendFileSync(file, `${JSON.stringify(signal)}\n`);
        this.cache.set(signal.signal_id, structuredClone(signal));
        this.known.add(signal.signal_id);
        this.persistKnown();
    }

    findById(signalId: string): StrategySignal | null {
        if (this.cache.has(signalId)) {
            return structuredClone(this.cache.get(signalId)!);
        }
        for (const s of this.listAllCached()) {
            if (s.signal_id === signalId) return structuredClone(s);
        }
        return null;
    }

    listByDate(ymd: string): StrategySignal[] {
        const file = join(this.root, `${ymd}.jsonl`);
        if (!existsSync(file)) return [];
        return readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as StrategySignal);
    }

    listByType(type: SignalType, ymd?: string): StrategySignal[] {
        const rows = ymd
            ? this.listByDate(ymd)
            : this.listAllCached();
        return rows.filter((s) => s.signal_type === type);
    }

    listRange(fromYmd: string, toYmd: string): StrategySignal[] {
        if (!existsSync(this.root)) return [];
        const files = readdirSync(this.root)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => f.replace(/\.jsonl$/, ''))
            .filter((d) => d >= fromYmd && d <= toYmd)
            .sort();
        return files.flatMap((d) => this.listByDate(d));
    }

    private listAllCached(): StrategySignal[] {
        if (!existsSync(this.root)) return [];
        const files = readdirSync(this.root).filter((f) =>
            f.endsWith('.jsonl'),
        );
        const out: StrategySignal[] = [];
        for (const f of files) {
            const ymd = f.replace(/\.jsonl$/, '');
            for (const s of this.listByDate(ymd)) {
                this.cache.set(s.signal_id, s);
                this.known.add(s.signal_id);
                out.push(s);
            }
        }
        return out;
    }
}
