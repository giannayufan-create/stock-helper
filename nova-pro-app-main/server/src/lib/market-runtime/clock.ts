// server/src/lib/market-runtime/clock.ts
// Live → SystemClock. Replay → ReplayClock. B/C must never use wall clock in replay.

export interface Clock {
    now(): Date;
}

export class SystemClock implements Clock {
    now(): Date {
        return new Date();
    }
}
