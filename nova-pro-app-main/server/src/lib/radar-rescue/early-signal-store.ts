// server/src/lib/radar-rescue/early-signal-store.ts
// Persist EARLY signal history for post-session validation.

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function taipeiYmd(d = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

export interface EarlySignalSnapshot {
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
}

export class EarlySignalStore {
    private open = new Map<
        string,
        { row: EarlySignalSnapshot; t0: number; peak: number; triggerPx: number }
    >();

    constructor(private dataDir: string) {}

    recordTrigger(row: EarlySignalSnapshot): void {
        const t0 = Date.parse(row.timestamp) || Date.now();
        this.open.set(row.symbol, {
            row,
            t0,
            peak: row.trigger_price,
            triggerPx: row.trigger_price,
        });
        this.append(row);
    }

    /** Call every evaluate with latest price to fill forward windows. */
    sample(symbol: string, price: number | null, state: string): void {
        if (price == null || !(price > 0)) return;
        const o = this.open.get(symbol);
        if (!o) return;
        const age = Date.now() - o.t0;
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
        if (state === 'ACTIVE' || state === 'NEAR_LIMIT' || state === 'LIMIT_UP') {
            o.row.reached_active = true;
        }
        if (state === 'NEAR_LIMIT') o.row.near_limit = true;
        if (state === 'LIMIT_UP') o.row.limit_up = true;

        if (age >= 300_000) {
            this.append({ ...o.row, timestamp: new Date().toISOString() });
            this.open.delete(symbol);
        }
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
        return out;
    }
}
