// server/src/providers/shioaji/quote-guard.ts
// Client-side guards for Shioaji request-type quote queries (snapshots / kbars / ticks).
// Official limits (sinotrade.github.io/tutor/limit): 50 calls per 5–10s in total,
// intraday ticks <= 10 calls, intraday kbars <= 270 calls; repeated violations
// or intraday snapshot polling suspend the IP and person ID.

import { isTradingDay } from '../../lib/market-calendar/trading-day.ts';
import {
    isShadowCashSession,
    sessionMinuteTaipei,
    taipeiYmd,
} from '../../lib/shadow/session.ts';

/** 08:30 pre-open auction through 13:30 close on TW trading days. */
export function isPreopenOrCashSession(d: Date = new Date()): boolean {
    if (!isTradingDay(taipeiYmd(d))) return false;
    const sm = sessionMinuteTaipei(d);
    return sm >= -30 && sm <= 4 * 60 + 30;
}

/** Sliding-window limiter; acquire() waits until a slot is free. */
export class QuoteRateLimiter {
    private stamps: number[] = [];
    private chain: Promise<void> = Promise.resolve();

    constructor(
        private maxCalls: number,
        private windowMs: number,
        private nowMs: () => number = Date.now,
        private sleep: (ms: number) => Promise<void> = (ms) =>
            new Promise((r) => setTimeout(r, ms)),
    ) {}

    acquire(): Promise<void> {
        const next = this.chain.then(() => this.take());
        this.chain = next.catch(() => undefined);
        return next;
    }

    private async take(): Promise<void> {
        for (;;) {
            const now = this.nowMs();
            while (this.stamps.length && now - this.stamps[0]! >= this.windowMs) {
                this.stamps.shift();
            }
            if (this.stamps.length < this.maxCalls) {
                this.stamps.push(now);
                return;
            }
            await this.sleep(this.windowMs - (now - this.stamps[0]!) + 5);
        }
    }
}

export type IntradayQueryKind = 'kbars' | 'ticks';

/** Per-day caps for kbars/ticks issued during the cash session. */
export class IntradayQueryBudget {
    private day = '';
    private used: Record<IntradayQueryKind, number> = { kbars: 0, ticks: 0 };

    constructor(
        private caps: Record<IntradayQueryKind, number>,
        private inSession: (d: Date) => boolean = isShadowCashSession,
        private now: () => Date = () => new Date(),
    ) {}

    /** false = refuse the call (cap reached during session). */
    take(kind: IntradayQueryKind): boolean {
        const d = this.now();
        if (!this.inSession(d)) return true;
        const ymd = taipeiYmd(d);
        if (ymd !== this.day) {
            this.day = ymd;
            this.used = { kbars: 0, ticks: 0 };
        }
        if (this.used[kind] >= this.caps[kind]) return false;
        this.used[kind] += 1;
        return true;
    }

    usage(): { day: string; used: Record<IntradayQueryKind, number>; caps: Record<IntradayQueryKind, number> } {
        return { day: this.day, used: { ...this.used }, caps: { ...this.caps } };
    }
}

/**
 * Snapshot polling is only a fallback for a stalled quote stream: pre-open auction and
 * cash session only, stream silent for staleMs, and at most once per minIntervalMs.
 */
export function shouldPollSnapshotFallback(opts: {
    now: Date;
    lastStreamEventAt: number;
    lastPollAt: number;
    staleMs?: number;
    minIntervalMs?: number;
    inSession?: (d: Date) => boolean;
}): boolean {
    const inSession = opts.inSession ?? isPreopenOrCashSession;
    if (!inSession(opts.now)) return false;
    const t = opts.now.getTime();
    if (t - opts.lastStreamEventAt < (opts.staleMs ?? 60_000)) return false;
    return t - opts.lastPollAt >= (opts.minIntervalMs ?? 60_000);
}
