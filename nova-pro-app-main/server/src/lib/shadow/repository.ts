// Shadow research JSONL — data/shadow/ only. Never touches data/signals.
// Writes are batched + async so the evaluate loop is not blocked on disk.

import {
    appendFileSync,
    createReadStream,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
} from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ShadowComparisonRow, ShadowStrategySignal } from './types.ts';
import { taipeiYmd } from './session.ts';

export interface ShadowRepository {
    recordComparison(row: ShadowComparisonRow): void;
    saveShadowSignal(signal: ShadowStrategySignal): void;
    listComparisons(fromYmd: string, toYmd: string): ShadowComparisonRow[];
    listShadowSignals(fromYmd: string, toYmd: string): ShadowStrategySignal[];
    /** Await pending disk flushes (tests / shutdown). */
    flush?(): Promise<void>;
    rootDir(): string;
}

function defaultRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', 'data', 'shadow');
}

function ensureDir(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

async function readJsonlStream<T>(path: string): Promise<T[]> {
    if (!existsSync(path)) return [];
    const out: T[] = [];
    const rl = createInterface({
        input: createReadStream(path, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
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
    private buffers = new Map<string, string[]>();
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private flushing: Promise<void> | null = null;
    private readonly flushMs: number;
    private readonly maxBufferedLines: number;

    constructor(
        root = defaultRoot(),
        opts?: { flushMs?: number; maxBufferedLines?: number },
    ) {
        this.root = root;
        this.signalsRoot = join(root, 'signals');
        this.flushMs = opts?.flushMs ?? 250;
        this.maxBufferedLines = opts?.maxBufferedLines ?? 64;
        ensureDir(this.root);
        ensureDir(this.signalsRoot);
    }

    rootDir(): string {
        return this.root;
    }

    recordComparison(row: ShadowComparisonRow): void {
        ensureDir(this.root);
        const ymd = taipeiYmd(new Date(row.timestamp));
        const path = join(this.root, `${ymd}.jsonl`);
        this.enqueue(path, `${JSON.stringify(row)}\n`);
    }

    saveShadowSignal(signal: ShadowStrategySignal): void {
        if (signal.shadow !== true) {
            throw new Error('ShadowStrategySignal must have shadow: true');
        }
        ensureDir(this.signalsRoot);
        const ymd = taipeiYmd(new Date(signal.signal_time));
        const path = join(this.signalsRoot, `${ymd}.jsonl`);
        this.enqueue(path, `${JSON.stringify(signal)}\n`);
    }

    listComparisons(fromYmd: string, toYmd: string): ShadowComparisonRow[] {
        // Sync API kept for CLI; prefer listComparisonsAsync for large days.
        return this.listRangeFilesSync(this.root, fromYmd, toYmd);
    }

    listShadowSignals(
        fromYmd: string,
        toYmd: string,
    ): ShadowStrategySignal[] {
        return this.listRangeFilesSync(this.signalsRoot, fromYmd, toYmd);
    }

    async listComparisonsAsync(
        fromYmd: string,
        toYmd: string,
    ): Promise<ShadowComparisonRow[]> {
        await this.flush();
        return this.listRangeFilesAsync(this.root, fromYmd, toYmd);
    }

    async flush(): Promise<void> {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        return this.flushNow();
    }

    private enqueue(path: string, line: string): void {
        // Tests / sync mode: write immediately (no event-loop deferral).
        if (this.flushMs <= 0) {
            ensureDir(dirname(path));
            appendFileSync(path, line, 'utf8');
            return;
        }
        let buf = this.buffers.get(path);
        if (!buf) {
            buf = [];
            this.buffers.set(path, buf);
        }
        buf.push(line);
        const total = [...this.buffers.values()].reduce(
            (n, b) => n + b.length,
            0,
        );
        if (total >= this.maxBufferedLines) {
            void this.flushNow();
            return;
        }
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                void this.flushNow();
            }, this.flushMs);
            this.flushTimer.unref?.();
        }
    }

    private async flushNow(): Promise<void> {
        if (this.flushing) return this.flushing;
        if (this.buffers.size === 0) return;
        const snapshot = this.buffers;
        this.buffers = new Map();
        this.flushing = (async () => {
            for (const [path, lines] of snapshot) {
                if (!lines.length) continue;
                try {
                    await appendFile(path, lines.join(''), 'utf8');
                } catch (err) {
                    console.warn(
                        'shadow jsonl append failed:',
                        err instanceof Error ? err.message : err,
                    );
                    // put back so a later flush can retry
                    const existing = this.buffers.get(path) ?? [];
                    this.buffers.set(path, [...lines, ...existing]);
                }
            }
        })().finally(() => {
            this.flushing = null;
        });
        return this.flushing;
    }

    private listRangeFilesSync<T>(
        dir: string,
        fromYmd: string,
        toYmd: string,
    ): T[] {
        // Intentionally sync + streaming-unfriendly: kept for unit tests with tiny files.
        // CLI should use listComparisonsAsync.
        if (!existsSync(dir)) return [];
        const out: T[] = [];
        for (const f of readdirSync(dir).sort()) {
            if (!f.endsWith('.jsonl')) continue;
            const ymd = f.replace(/\.jsonl$/, '');
            if (ymd < fromYmd || ymd > toYmd) continue;
            const path = join(dir, f);
            for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
                if (!line.trim()) continue;
                try {
                    out.push(JSON.parse(line) as T);
                } catch {
                    /* skip */
                }
            }
        }
        return out;
    }

    private async listRangeFilesAsync<T>(
        dir: string,
        fromYmd: string,
        toYmd: string,
    ): Promise<T[]> {
        if (!existsSync(dir)) return [];
        const out: T[] = [];
        for (const f of readdirSync(dir).sort()) {
            if (!f.endsWith('.jsonl')) continue;
            const ymd = f.replace(/\.jsonl$/, '');
            if (ymd < fromYmd || ymd > toYmd) continue;
            out.push(...(await readJsonlStream<T>(join(dir, f))));
        }
        return out;
    }
}
