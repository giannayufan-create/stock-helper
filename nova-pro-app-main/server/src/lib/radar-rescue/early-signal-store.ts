// Persist EARLY signal history for post-session validation.
// Each trigger gets an independent signal_id; reopen incomplete windows after restart.
// Horizon prices persist when first observed — never backfill early windows with a late restart price.

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

export type HorizonStatus = 'pending' | 'ok' | 'incomplete';

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
    px_30s?: number | null;
    px_60s?: number | null;
    px_90s?: number | null;
    px_3m?: number | null;
    px_5m?: number | null;
    status_30s?: HorizonStatus;
    status_60s?: HorizonStatus;
    status_90s?: HorizonStatus;
    status_3m?: HorizonStatus;
    status_5m?: HorizonStatus;
    max_price?: number | null;
    max_return_pct?: number | null;
    max_drawdown_pct?: number | null;
    reached_active?: boolean;
    near_limit?: boolean;
    limit_up?: boolean;
    /** Last wall-clock sample while process was alive (for no-backfill). */
    last_sample_at_ms?: number | null;
    finalized?: boolean;
}

interface OpenEntry {
    row: EarlySignalSnapshot;
    t0: number;
    peak: number;
    triggerPx: number;
    lastSampleAt: number;
}

const HORIZONS: Array<{
    ms: number;
    px: 'px_30s' | 'px_60s' | 'px_90s' | 'px_3m' | 'px_5m';
    status: 'status_30s' | 'status_60s' | 'status_90s' | 'status_3m' | 'status_5m';
}> = [
    { ms: 30_000, px: 'px_30s', status: 'status_30s' },
    { ms: 60_000, px: 'px_60s', status: 'status_60s' },
    { ms: 90_000, px: 'px_90s', status: 'status_90s' },
    { ms: 180_000, px: 'px_3m', status: 'status_3m' },
    { ms: 300_000, px: 'px_5m', status: 'status_5m' },
];

/** Accept a sample only if taken within this window after the horizon. */
const HORIZON_GRACE_MS = 20_000;

function makeSignalId(symbol: string, t0: number): string {
    return `early_${symbol}_${t0}_${randomBytes(3).toString('hex')}`;
}

function statusOf(
    row: EarlySignalSnapshot,
    key: (typeof HORIZONS)[number]['status'],
): HorizonStatus {
    return row[key] ?? 'pending';
}

export class EarlySignalStore {
    private open = new Map<string, OpenEntry>();
    private now: () => number;

    constructor(
        private dataDir: string,
        clock: () => number = () => Date.now(),
    ) {
        this.now = clock;
        this.hydrateOpenFromDisk();
    }

    private hydrateOpenFromDisk(): void {
        const rows = this.loadLatestBySignalId();
        const now = this.now();
        for (const row of rows.values()) {
            if (row.finalized) continue;
            const t0 = Date.parse(row.timestamp) || 0;
            if (!(t0 > 0)) continue;
            if (statusOf(row, 'status_5m') === 'ok' || statusOf(row, 'status_5m') === 'incomplete') {
                continue;
            }
            if (now - t0 > 15 * 60_000) continue;

            const restored: EarlySignalSnapshot = {
                ...row,
                status_30s: row.status_30s ?? (row.px_30s != null ? 'ok' : 'pending'),
                status_60s: row.status_60s ?? (row.px_60s != null ? 'ok' : 'pending'),
                status_90s: row.status_90s ?? (row.px_90s != null ? 'ok' : 'pending'),
                status_3m: row.status_3m ?? (row.px_3m != null ? 'ok' : 'pending'),
                status_5m: row.status_5m ?? (row.px_5m != null ? 'ok' : 'pending'),
            };
            // Mark horizons already missed while process was down — never backfill later.
            for (const h of HORIZONS) {
                if (restored[h.px] != null) {
                    restored[h.status] = 'ok';
                    continue;
                }
                if (restored[h.status] === 'incomplete') continue;
                if (now - t0 > h.ms + HORIZON_GRACE_MS) {
                    restored[h.status] = 'incomplete';
                }
            }

            this.open.set(row.signal_id, {
                row: restored,
                t0,
                peak: restored.max_price ?? restored.trigger_price,
                triggerPx: restored.trigger_price,
                lastSampleAt: restored.last_sample_at_ms ?? t0,
            });
        }
        if (this.open.size) this.persistOpenIndex();
    }

    recordTrigger(
        row: Omit<EarlySignalSnapshot, 'signal_id'> & { signal_id?: string },
    ): string {
        const t0 = Date.parse(row.timestamp) || this.now();
        const signal_id = row.signal_id || makeSignalId(row.symbol, t0);
        const full: EarlySignalSnapshot = {
            ...row,
            signal_id,
            status_30s: 'pending',
            status_60s: 'pending',
            status_90s: 'pending',
            status_3m: 'pending',
            status_5m: 'pending',
            last_sample_at_ms: t0,
            finalized: false,
        };
        this.open.set(signal_id, {
            row: full,
            t0,
            peak: full.trigger_price,
            triggerPx: full.trigger_price,
            lastSampleAt: t0,
        });
        this.append(full);
        this.persistOpenIndex();
        return signal_id;
    }

    /**
     * Fill horizons only when a live sample crosses the boundary within grace.
     * After restart, already-passed empty horizons stay incomplete.
     */
    sample(
        symbol: string,
        price: number | null,
        state: string,
        nowMs = this.now(),
    ): void {
        if (price == null || !(price > 0)) return;
        const done: string[] = [];

        for (const [sid, o] of this.open) {
            if (o.row.symbol !== symbol) continue;
            let dirty = false;
            const age = nowMs - o.t0;

            o.peak = Math.max(o.peak, price);
            const maxRet =
                o.triggerPx > 0
                    ? ((o.peak - o.triggerPx) / o.triggerPx) * 100
                    : null;
            const dd =
                o.triggerPx > 0
                    ? ((price - o.peak) / o.triggerPx) * 100
                    : null;
            if (o.row.max_price !== o.peak) {
                o.row.max_price = o.peak;
                dirty = true;
            }
            if (o.row.max_return_pct !== maxRet) {
                o.row.max_return_pct = maxRet;
                dirty = true;
            }
            if (dd != null) {
                const nextDd = Math.min(o.row.max_drawdown_pct ?? 0, dd);
                if (o.row.max_drawdown_pct !== nextDd) {
                    o.row.max_drawdown_pct = nextDd;
                    dirty = true;
                }
            }

            for (const h of HORIZONS) {
                const st = statusOf(o.row, h.status);
                if (st === 'ok' || st === 'incomplete') continue;
                if (o.row[h.px] != null) {
                    o.row[h.status] = 'ok';
                    dirty = true;
                    continue;
                }
                if (age < h.ms) continue;

                const sinceBoundary = age - h.ms;
                if (sinceBoundary <= HORIZON_GRACE_MS) {
                    // Observed near the horizon — record and persist immediately.
                    o.row[h.px] = price;
                    o.row[h.status] = 'ok';
                    dirty = true;
                    this.append({
                        ...o.row,
                        timestamp: new Date(nowMs).toISOString(),
                    });
                } else {
                    // Missed the observation window — do not use late price.
                    o.row[h.status] = 'incomplete';
                    dirty = true;
                }
            }

            if (
                state === 'ACTIVE' ||
                state === 'NEAR_LIMIT' ||
                state === 'LIMIT_UP'
            ) {
                if (!o.row.reached_active) {
                    o.row.reached_active = true;
                    dirty = true;
                }
            }
            if (state === 'NEAR_LIMIT' && !o.row.near_limit) {
                o.row.near_limit = true;
                dirty = true;
            }
            if (state === 'LIMIT_UP' && !o.row.limit_up) {
                o.row.limit_up = true;
                dirty = true;
            }

            o.lastSampleAt = nowMs;
            o.row.last_sample_at_ms = nowMs;
            dirty = true;

            const five = statusOf(o.row, 'status_5m');
            if (five === 'ok' || five === 'incomplete') {
                o.row.finalized = true;
                this.append({
                    ...o.row,
                    timestamp: new Date(nowMs).toISOString(),
                });
                done.push(sid);
            }

            if (dirty) this.persistOpenIndex();
        }

        for (const sid of done) this.open.delete(sid);
        if (done.length) this.persistOpenIndex();
    }

    openCount(): number {
        return this.open.size;
    }

    getOpen(signalId: string): EarlySignalSnapshot | null {
        return this.open.get(signalId)?.row ?? null;
    }

    private openIndexPath(): string {
        return join(this.dataDir, 'early_signals', `${taipeiYmd()}.open.json`);
    }

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

    private loadLatestBySignalId(): Map<string, EarlySignalSnapshot> {
        const latest = new Map<string, EarlySignalSnapshot>();
        const file = join(this.dataDir, 'early_signals', `${taipeiYmd()}.jsonl`);
        if (existsSync(file)) {
            for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
                if (!line.trim()) continue;
                try {
                    const r = JSON.parse(line) as EarlySignalSnapshot;
                    if (r.signal_id) latest.set(r.signal_id, r);
                } catch {
                    /* skip */
                }
            }
        }
        const openFile = this.openIndexPath();
        if (existsSync(openFile)) {
            try {
                const openRows = JSON.parse(
                    readFileSync(openFile, 'utf8'),
                ) as EarlySignalSnapshot[];
                for (const r of openRows) {
                    if (r.signal_id) latest.set(r.signal_id, r);
                }
            } catch {
                /* skip */
            }
        }
        return latest;
    }

    loadToday(): EarlySignalSnapshot[] {
        return [...this.loadLatestBySignalId().values()];
    }
}
