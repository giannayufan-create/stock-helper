// Shadow research JSONL — data/shadow/ only. Never touches data/signals.

import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ShadowComparisonRow, ShadowStrategySignal } from './types.ts';

export interface ShadowRepository {
    recordComparison(row: ShadowComparisonRow): void;
    saveShadowSignal(signal: ShadowStrategySignal): void;
    listComparisons(fromYmd: string, toYmd: string): ShadowComparisonRow[];
    listShadowSignals(fromYmd: string, toYmd: string): ShadowStrategySignal[];
    rootDir(): string;
}

function defaultRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', 'data', 'shadow');
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

function ensureDir(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function readJsonl<T>(path: string): T[] {
    if (!existsSync(path)) return [];
    const out: T[] = [];
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            out.push(JSON.parse(line) as T);
        } catch {
            /* skip corrupt */
        }
    }
    return out;
}

export class JsonlShadowRepository implements ShadowRepository {
    private root: string;
    private signalsRoot: string;

    constructor(root = defaultRoot()) {
        this.root = root;
        this.signalsRoot = join(root, 'signals');
        ensureDir(this.root);
        ensureDir(this.signalsRoot);
    }

    rootDir(): string {
        return this.root;
    }

    recordComparison(row: ShadowComparisonRow): void {
        ensureDir(this.root);
        const ymd = taipeiYmd(row.timestamp);
        const path = join(this.root, `${ymd}.jsonl`);
        appendFileSync(path, `${JSON.stringify(row)}\n`);
    }

    saveShadowSignal(signal: ShadowStrategySignal): void {
        if (signal.shadow !== true) {
            throw new Error('ShadowStrategySignal must have shadow: true');
        }
        ensureDir(this.signalsRoot);
        const ymd = taipeiYmd(signal.signal_time);
        const path = join(this.signalsRoot, `${ymd}.jsonl`);
        appendFileSync(path, `${JSON.stringify(signal)}\n`);
    }

    listComparisons(fromYmd: string, toYmd: string): ShadowComparisonRow[] {
        return this.listRangeFiles(this.root, fromYmd, toYmd);
    }

    listShadowSignals(
        fromYmd: string,
        toYmd: string,
    ): ShadowStrategySignal[] {
        return this.listRangeFiles(this.signalsRoot, fromYmd, toYmd);
    }

    private listRangeFiles<T>(
        dir: string,
        fromYmd: string,
        toYmd: string,
    ): T[] {
        if (!existsSync(dir)) return [];
        const out: T[] = [];
        for (const f of readdirSync(dir).sort()) {
            if (!f.endsWith('.jsonl')) continue;
            const ymd = f.replace(/\.jsonl$/, '');
            if (ymd < fromYmd || ymd > toYmd) continue;
            out.push(...readJsonl<T>(join(dir, f)));
        }
        return out;
    }
}
