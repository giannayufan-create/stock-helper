// server/src/lib/ai-budget.ts
// Process-wide Gemini call budget (billing guard). Every Gemini fetch takes one unit;
// callers treat a refusal like "Gemini unavailable" and use their rule-based fallback.

import { dateTimeFormat } from './intl-cache.ts';

const DEFAULT_DAILY = 600;
const DEFAULT_PER_MINUTE = 30;

function envInt(name: string, fallback: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function taipeiYmd(ms: number): string {
    return dateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(ms));
}

export class GeminiBudget {
    private day = '';
    private dayCount = 0;
    private minuteStart = 0;
    private minuteCount = 0;

    constructor(
        private dailyLimit = envInt('GEMINI_DAILY_LIMIT', DEFAULT_DAILY),
        private perMinuteLimit = envInt('GEMINI_PER_MINUTE_LIMIT', DEFAULT_PER_MINUTE),
    ) {}

    /** Take one call unit; returns a refusal reason when over budget. */
    take(nowMs = Date.now()): { ok: true } | { ok: false; reason: string } {
        const day = taipeiYmd(nowMs);
        if (day !== this.day) {
            this.day = day;
            this.dayCount = 0;
        }
        if (nowMs - this.minuteStart >= 60_000) {
            this.minuteStart = nowMs;
            this.minuteCount = 0;
        }
        if (this.dayCount >= this.dailyLimit) {
            return { ok: false, reason: `Gemini daily budget reached (${this.dailyLimit})` };
        }
        if (this.minuteCount >= this.perMinuteLimit) {
            return { ok: false, reason: `Gemini per-minute budget reached (${this.perMinuteLimit})` };
        }
        this.dayCount++;
        this.minuteCount++;
        return { ok: true };
    }

    snapshot() {
        return {
            day: this.day,
            used_today: this.dayCount,
            daily_limit: this.dailyLimit,
            per_minute_limit: this.perMinuteLimit,
        };
    }
}

export const geminiBudget = new GeminiBudget();
