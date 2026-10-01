// server/src/lib/signal-outcome/repository.ts
// Append-only JSONL outcome events — materialize latest per signal_id.

import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SignalType } from '../strategy-signal/types.ts';
import type { SignalOutcome } from './types.ts';

export interface SignalOutcomeRepository {
    appendUpdate(outcome: SignalOutcome): void;
    findBySignalId(signalId: string): SignalOutcome | null;
    listByDate(ymd: string): SignalOutcome[];
    listByType(type: SignalType, ymd?: string): SignalOutcome[];
    listRange(fromYmd: string, toYmd: string): SignalOutcome[];
    materializeRange(fromYmd: string, toYmd: string): SignalOutcome[];
}

function defaultRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', 'data', 'outcomes');
}

const INDEX_REBUILD_MS = 60_000;

function taipeiYmd(iso?: string): string {
    const d = iso ? new Date(iso) : new Date();
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

export class JsonlSignalOutcomeRepository implements SignalOutcomeRepository {
    private root: string;
    private dayById: Map<string, string> | null = null;
    private dayIndexBuiltAt = 0;

    constructor(root = defaultRoot()) {
        this.root = root;
        if (!existsSync(this.root)) {
            mkdirSync(this.root, { recursive: true });
        }
    }

    appendUpdate(outcome: SignalOutcome): void {
        const ymd = taipeiYmd(outcome.signal_time);
        const file = join(this.root, `${ymd}.jsonl`);
        appendFileSync(file, `${JSON.stringify(outcome)}\n`);
        this.dayById?.set(outcome.signal_id, ymd);
    }

    listByDate(ymd: string): SignalOutcome[] {
        const file = join(this.root, `${ymd}.jsonl`);
        if (!existsSync(file)) return [];
        return readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as SignalOutcome);
    }

    findBySignalId(signalId: string): SignalOutcome | null {
        let ymd = this.dayIndex().get(signalId);
        if (!ymd && Date.now() - this.dayIndexBuiltAt >= INDEX_REBUILD_MS) {
            // Other instances may append to the same root.
            this.dayById = null;
            ymd = this.dayIndex().get(signalId);
        }
        if (!ymd) return null;
        let latest: SignalOutcome | null = null;
        for (const row of this.listByDate(ymd)) {
            if (row.signal_id === signalId) latest = row;
        }
        return latest;
    }

    /** signal_id → file date, built once by scanning; kept current by appendUpdate. */
    private dayIndex(): Map<string, string> {
        if (this.dayById) return this.dayById;
        const index = new Map<string, string>();
        if (existsSync(this.root)) {
            for (const f of readdirSync(this.root)) {
                if (!f.endsWith('.jsonl')) continue;
                const ymd = f.replace(/\.jsonl$/, '');
                for (const row of this.listByDate(ymd)) {
                    index.set(row.signal_id, ymd);
                }
            }
        }
        this.dayById = index;
        this.dayIndexBuiltAt = Date.now();
        return index;
    }

    listByType(type: SignalType, ymd?: string): SignalOutcome[] {
        const rows = ymd
            ? this.materializeDate(ymd)
            : this.materializeRange('1970-01-01', '9999-12-31');
        return rows.filter((o) => o.signal_type === type);
    }

    listRange(fromYmd: string, toYmd: string): SignalOutcome[] {
        return this.readRawRange(fromYmd, toYmd);
    }

    materializeRange(fromYmd: string, toYmd: string): SignalOutcome[] {
        const raw = this.readRawRange(fromYmd, toYmd);
        const map = new Map<string, SignalOutcome>();
        for (const row of raw) {
            map.set(row.signal_id, row);
        }
        return [...map.values()];
    }

    private materializeDate(ymd: string): SignalOutcome[] {
        const raw = this.listByDate(ymd);
        const map = new Map<string, SignalOutcome>();
        for (const row of raw) map.set(row.signal_id, row);
        return [...map.values()];
    }

    private readRawRange(fromYmd: string, toYmd: string): SignalOutcome[] {
        if (!existsSync(this.root)) return [];
        const files = readdirSync(this.root)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => f.replace(/\.jsonl$/, ''))
            .filter((d) => d >= fromYmd && d <= toYmd)
            .sort();
        return files.flatMap((d) => this.listByDate(d));
    }
}
