// Persist EARLY signal history for post-session validation.
// Each trigger gets an independent signal_id; reopen incomplete windows after restart.

import {
    appendFileSync,
    mkdirSync,
    existsSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

function taipeiYmd(d = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

export interface EarlySignalSnapshot {
    signal_id: string;
    symbol: string;
    name: string;
    timestamp: string;
    trigger_price: number;
    change_pct: number | null;
    vwap_pos_pct: number | null;
    volume_accel: number | null;
    rank_velocity: number | null;
    bp_score: number | null;
    bp_slope: number | null;
    ask_eating: boolean;
    buy_surge: boolean;
    trigger_score: number;
    state: string;
    /** Filled later by follow-up samples. */
    px_30s?: number | null;
    px_60s?: number | null;
    px_90s?: number | null;
    px_3m?: number | null;
    px_5m?: number | null;
    max_price?: number | null;
    max_return_pct?: number | null;
    max_drawdown_pct?: number | null;
    reached_active?: boolean;
    near_limit?: boolean;
    limit_up?: boolean;
    /** True after 5m window closed and final row written. */
    finalized?: boolean;
}

interface OpenEntry {
    row: EarlySignalSnapshot;
    t0: number;
    peak: number;
    triggerPx: number;
}

function makeSignalId(symbol: string, t0: number): string {
    return `early_${symbol}_${t0}_${randomBytes(3).toString('hex')}`;
}

export class EarlySignalStore {
    /** Keyed by signal_id — multiple concurrent tracks per symbol allowed. */
    private open = new Map<string, OpenEntry>();

    constructor(private dataDir: string) {
        this.hydrateOpenFromDisk();
    }

    /** Reopen today rows that never finished the 5m window (survives process restart). */
    private hydrateOpenFromDisk(): void {
        const rows = this.loadToday();
        const latest = new Map<string, EarlySignalSnapshot>();
        for (const r of rows) {
            if (!r.signal_id) continue;
            latest.set(r.signal_id, r);
        }
        const now = Date.now();
        for (const row of latest.values()) {
            if (row.finalized || row.px_5m != null) continue;
            const t0 = Date.parse(row.timestamp) || 0;
            if (!(t0 > 0)) continue;
            // Still tracking up to ~10m after trigger so restart can fill remaining slots.
            if (now - t0 > 10 * 60_000) continue;
            this.open.set(row.signal_id, {
                row: { ...row },
                t0,
                peak: row.max_price ?? row.trigger_price,
                triggerPx: row.trigger_price,
            });
        }
    }

    recordTrigger(
        row: Omit<EarlySignalSnapshot, 'signal_id'> & { signal_id?: string },
    ): string {
        const t0 = Date.parse(row.timestamp) || Date.now();
        const signal_id = row.signal_id || makeSignalId(row.symbol, t0);
        const full: EarlySignalSnapshot = {
            ...row,
            signal_id,
            finalized: false,
        };
        this.open.set(signal_id, {
            row: full,
            t0,
            peak: full.trigger_price,
            triggerPx: full.trigger_price,
        });
        this.append(full);
        this.persistOpenIndex();
        return signal_id;
    }

    /** Call every evaluate with latest price to fill forward windows for all open signals on symbol. */
    sample(symbol: string, price: number | null, state: string): void {
        if (price == null || !(price > 0)) return;
        const now = Date.now();
        const done: string[] = [];
        for (const [sid, o] of this.open) {
            if (o.row.symbol !== symbol) continue;
            const age = now - o.t0;
            o.peak = Math.max(o.peak, price);
            const maxRet =
                o.triggerPx > 0
                    ? ((o.peak - o.triggerPx) / o.triggerPx) * 100
                    : null;
            const dd =
                o.triggerPx > 0
                    ? ((price - o.peak) / o.triggerPx) * 100
                    : null;
            if (age >= 30_000 && o.row.px_30s == null) o.row.px_30s = price;
            if (age >= 60_000 && o.row.px_60s == null) o.row.px_60s = price;
            if (age >= 90_000 && o.row.px_90s == null) o.row.px_90s = price;
            if (age >= 180_000 && o.row.px_3m == null) o.row.px_3m = price;
            if (age >= 300_000 && o.row.px_5m == null) o.row.px_5m = price;
            o.row.max_price = o.peak;
            o.row.max_return_pct = maxRet;
            if (dd != null) {
                o.row.max_drawdown_pct = Math.min(
                    o.row.max_drawdown_pct ?? 0,
                    dd,
                );
            }
            if (
                state === 'ACTIVE' ||
                state === 'NEAR_LIMIT' ||
                state === 'LIMIT_UP'
            ) {
                o.row.reached_active = true;
            }
            if (state === 'NEAR_LIMIT') o.row.near_limit = true;
            if (state === 'LIMIT_UP') o.row.limit_up = true;

            if (age >= 300_000) {
                o.row.finalized = true;
                this.append({
                    ...o.row,
                    timestamp: new Date(now).toISOString(),
                });
                done.push(sid);
            }
        }
        for (const sid of done) this.open.delete(sid);
        if (done.length) this.persistOpenIndex();
    }

    openCount(): number {
        return this.open.size;
    }

    private openIndexPath(): string {
        return join(this.dataDir, 'early_signals', `${taipeiYmd()}.open.json`);
    }

    /** Crash-safe open set so 30s–5m windows survive restart. */
    private persistOpenIndex(): void {
        const dir = join(this.dataDir, 'early_signals');
        mkdirSync(dir, { recursive: true });
        const payload = [...this.open.values()].map((o) => o.row);
        writeFileSync(this.openIndexPath(), JSON.stringify(payload), 'utf8');
    }

    private append(row: EarlySignalSnapshot): void {
        const dir = join(this.dataDir, 'early_signals');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${taipeiYmd()}.jsonl`);
        appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
    }

    loadToday(): EarlySignalSnapshot[] {
        const file = join(this.dataDir, 'early_signals', `${taipeiYmd()}.jsonl`);
        if (!existsSync(file)) return [];
        const out: EarlySignalSnapshot[] = [];
        for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                out.push(JSON.parse(line) as EarlySignalSnapshot);
            } catch {
                /* skip */
            }
        }
        // Prefer open-index rows for incomplete ids (more recent samples).
        const openFile = this.openIndexPath();
        if (existsSync(openFile)) {
            try {
                const openRows = JSON.parse(
                    readFileSync(openFile, 'utf8'),
                ) as EarlySignalSnapshot[];
                out.push(...openRows);
            } catch {
                /* skip */
            }
        }
        return out;
    }
}
