// server/src/lib/historical-replay/replay-clock.ts
// Sole "now" in replay mode. Implements Clock.

import type { Clock } from '../market-runtime/clock.ts';

export type ReplayClockStatus =
    | 'idle'
    | 'running'
    | 'paused'
    | 'completed'
    | 'failed';

export class ReplayClock implements Clock {
    private _current: Date;
    readonly startTime: Date;
    readonly endTime: Date;
    /** 1 = realtime, 10 = 10x, Infinity = max */
    speed: number;
    status: ReplayClockStatus = 'idle';

    constructor(opts: {
        startTime: Date;
        endTime: Date;
        speed?: number;
    }) {
        this.startTime = new Date(opts.startTime);
        this.endTime = new Date(opts.endTime);
        this._current = new Date(opts.startTime);
        this.speed = opts.speed ?? Number.POSITIVE_INFINITY;
    }

    now(): Date {
        return new Date(this._current);
    }

    get currentTime(): Date {
        return this.now();
    }

    start(): void {
        if (this.status === 'completed') return;
        this.status = 'running';
    }

    pause(): void {
        if (this.status === 'running') this.status = 'paused';
    }

    resume(): void {
        if (this.status === 'paused') this.status = 'running';
    }

    stop(): void {
        this.status = 'idle';
        this._current = new Date(this.startTime);
    }

    /** Advance exactly one minute (bar step). */
    stepMinute(): Date {
        if (this.status === 'idle') this.status = 'running';
        const next = new Date(this._current.getTime() + 60_000);
        if (next.getTime() > this.endTime.getTime()) {
            this._current = new Date(this.endTime);
            this.status = 'completed';
            return this.now();
        }
        this._current = next;
        if (this._current.getTime() >= this.endTime.getTime()) {
            this.status = 'completed';
        }
        return this.now();
    }

    /** Jump clock to an absolute time (must be within [start, end]). */
    setCurrent(t: Date): void {
        const ms = t.getTime();
        if (ms < this.startTime.getTime()) {
            this._current = new Date(this.startTime);
        } else if (ms > this.endTime.getTime()) {
            this._current = new Date(this.endTime);
            this.status = 'completed';
        } else {
            this._current = new Date(ms);
            this.status = 'running';
        }
    }

    runToEnd(): void {
        this.status = 'running';
        this._current = new Date(this.endTime);
        this.status = 'completed';
    }
}

export function parseSpeed(raw: string | undefined): number {
    if (!raw || raw === 'max') return Number.POSITIVE_INFINITY;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
}
