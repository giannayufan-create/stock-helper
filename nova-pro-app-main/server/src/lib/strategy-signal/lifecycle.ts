// server/src/lib/strategy-signal/lifecycle.ts
// Dedupe / cooldown — closed ≠ 平倉, only signal lifecycle end.

import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type {
    LifecycleRecord,
    SignalLifecycleStatus,
    SignalType,
} from './types.ts';

function key(symbol: string, type: SignalType): string {
    return `${symbol}|${type}`;
}

export class SignalLifecycleManager {
    private records = new Map<string, LifecycleRecord>();
    private persistPath: string | null = null;

    get(symbol: string, type: SignalType): LifecycleRecord | null {
        return this.records.get(key(symbol, type)) ?? null;
    }

    /**
     * Whether a new StrategySignal may be created now.
     * OPEN_PASS: one active per symbol until closed/invalid/expired.
     * C events: respect cooldown_until.
     */
    canCreate(
        symbol: string,
        type: SignalType,
        nowIso: string,
    ): { ok: boolean; reason: string } {
        const rec = this.get(symbol, type);
        if (!rec) return { ok: true, reason: 'first' };

        const now = Date.parse(nowIso);
        if (
            rec.cooldown_until &&
            Date.parse(rec.cooldown_until) > now
        ) {
            return { ok: false, reason: 'cooldown' };
        }

        if (
            rec.lifecycle_status === 'active' &&
            rec.active_signal_id
        ) {
            return { ok: false, reason: 'already_active' };
        }

        return { ok: true, reason: 'eligible' };
    }

    /** Touch existing active signal (continuation — no new id). */
    touch(symbol: string, type: SignalType, nowIso: string): void {
        const rec = this.get(symbol, type);
        if (!rec || rec.lifecycle_status !== 'active') return;
        rec.last_seen_at = nowIso;
        this.persist();
    }

    activate(opts: {
        symbol: string;
        signal_type: SignalType;
        signal_id: string;
        nowIso: string;
        cooldownSec?: number;
    }): LifecycleRecord {
        const rec: LifecycleRecord = {
            symbol: opts.symbol,
            signal_type: opts.signal_type,
            active_signal_id: opts.signal_id,
            created_at: opts.nowIso,
            last_seen_at: opts.nowIso,
            cooldown_until: null,
            lifecycle_status: 'active',
        };
        this.records.set(key(opts.symbol, opts.signal_type), rec);
        this.persist();
        return rec;
    }

    setStatus(
        symbol: string,
        type: SignalType,
        status: SignalLifecycleStatus,
        nowIso: string,
        cooldownSec?: number,
    ): void {
        const rec = this.get(symbol, type);
        if (!rec) return;
        rec.lifecycle_status = status;
        rec.last_seen_at = nowIso;
        if (
            status === 'closed' ||
            status === 'invalid' ||
            status === 'expired' ||
            status === 'cooling'
        ) {
            rec.active_signal_id = null;
            if (cooldownSec != null && cooldownSec > 0) {
                rec.cooldown_until = new Date(
                    Date.parse(nowIso) + cooldownSec * 1000,
                ).toISOString();
            }
        }
        this.persist();
    }

    snapshot(): LifecycleRecord[] {
        return [...this.records.values()];
    }

    clear(): void {
        this.records.clear();
        this.persist();
    }

    /** Load records from disk / prior snapshot. */
    hydrate(records: LifecycleRecord[]): void {
        this.records.clear();
        for (const r of records) {
            this.records.set(key(r.symbol, r.signal_type), { ...r });
        }
    }

    /** Bind a JSON persist path (data/signals/lifecycle.json). */
    setPersistPath(path: string | null): void {
        this.persistPath = path;
    }

    hydrateFromDisk(path: string): void {
        this.persistPath = path;
        if (!existsSync(path)) return;
        try {
            const raw = JSON.parse(readFileSync(path, 'utf8')) as {
                records?: LifecycleRecord[];
            };
            if (Array.isArray(raw.records)) {
                this.hydrate(raw.records);
            }
        } catch {
            // corrupt file — start fresh
        }
    }

    persist(path?: string): void {
        const target = path ?? this.persistPath;
        if (!target) return;
        try {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(
                target,
                `${JSON.stringify({ records: this.snapshot() }, null, 2)}\n`,
            );
        } catch {
            // best-effort
        }
    }
}
