// server/src/lib/strategy-signal/repository.ts
// JSONL only via this interface — no scattered fs.appendFile in B/C.

import { dateTimeFormat } from '../intl-cache.ts';
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
import { signalsContentEqual } from '../research-persistence/hash.ts';
import { forEachJsonlLine } from '../jsonl-lines.ts';

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
    return dateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

export class JsonlStrategySignalRepository implements StrategySignalRepository {
    private root: string;
    /** signal_id → file date. Full signals stay on disk (heap is ~256MB on Render). */
    private dayById = new Map<string, string>();
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
            forEachJsonlLine(join(this.root, f), (line) => {
                const id = (JSON.parse(line) as StrategySignal).signal_id;
                this.known.add(id);
                this.dayById.set(id, ymd);
            });
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
        // Immutable: reject overwrite; allow idempotent identical content
        if (this.known.has(signal.signal_id)) {
            const prev = this.findById(signal.signal_id);
            if (prev) {
                if (signalsContentEqual(prev, signal)) {
                    return; // SKIP_IDEMPOTENT
                }
            }
            throw new Error(
                `feature_snapshot immutable: signal ${signal.signal_id} already saved`,
            );
        }
        const ymd = taipeiYmd(signal.signal_time);
        const file = join(this.root, `${ymd}.jsonl`);
        appendFileSync(file, `${JSON.stringify(signal)}\n`);
        // Sidecar is rewritten on hydrate only; the JSONL scan is authoritative.
        this.known.add(signal.signal_id);
        this.dayById.set(signal.signal_id, ymd);
    }

    findById(signalId: string): StrategySignal | null {
        const ymd = this.dayById.get(signalId);
        if (ymd) {
            const hit = this.findInDay(ymd, signalId);
            if (hit) return hit;
        }
        if (!existsSync(this.root)) return null;
        for (const f of readdirSync(this.root)) {
            if (!f.endsWith('.jsonl')) continue;
            const day = f.replace(/\.jsonl$/, '');
            if (day === ymd) continue;
            const hit = this.findInDay(day, signalId);
            if (hit) {
                this.dayById.set(signalId, day);
                this.known.add(signalId);
                return hit;
            }
        }
        return null;
    }

    private findInDay(ymd: string, signalId: string): StrategySignal | null {
        const file = join(this.root, `${ymd}.jsonl`);
        if (!existsSync(file)) return null;
        let hit: StrategySignal | null = null;
        forEachJsonlLine(file, (line) => {
            if (!line.includes(signalId)) return;
            const s = JSON.parse(line) as StrategySignal;
            if (s.signal_id !== signalId) return;
            hit = s;
            return false;
        });
        return hit;
    }

    listByDate(ymd: string): StrategySignal[] {
        const file = join(this.root, `${ymd}.jsonl`);
        if (!existsSync(file)) return [];
        const out: StrategySignal[] = [];
        forEachJsonlLine(file, (line) => {
            out.push(JSON.parse(line) as StrategySignal);
        });
        return out;
    }

    listByType(type: SignalType, ymd?: string): StrategySignal[] {
        const rows = ymd
            ? this.listByDate(ymd)
            : this.listAllCached();
        return rows.filter((s) => s.signal_type === type);
    }

    listRange(fromYmd: string, toYmd: string): StrategySignal[] {
        return this.daysInRange(fromYmd, toYmd).flatMap((d) =>
            this.listByDate(d),
        );
    }

    /** One parsed signal at a time; a month of signals does not fit in heap. */
    forEachInRange(
        fromYmd: string,
        toYmd: string,
        onSignal: (s: StrategySignal) => void,
    ): void {
        for (const d of this.daysInRange(fromYmd, toYmd)) {
            forEachJsonlLine(join(this.root, `${d}.jsonl`), (line) => {
                onSignal(JSON.parse(line) as StrategySignal);
            });
        }
    }

    private daysInRange(fromYmd: string, toYmd: string): string[] {
        if (!existsSync(this.root)) return [];
        return readdirSync(this.root)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => f.replace(/\.jsonl$/, ''))
            .filter((d) => d >= fromYmd && d <= toYmd)
            .sort();
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
                this.dayById.set(s.signal_id, ymd);
                this.known.add(s.signal_id);
                out.push(s);
            }
        }
        return out;
    }
}
