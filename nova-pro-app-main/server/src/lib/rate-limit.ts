// server/src/lib/rate-limit.ts
// In-memory fixed-window limits for expensive / state-changing routes.
// Per-client and route-wide caps; single instance (Render Starter), so no shared store.

import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface RateRule {
    method: string;
    path: string;
    windowMs: number;
    perClient: number;
    global: number;
}

export const DEFAULT_RATE_RULES: readonly RateRule[] = [
    // Python analyzer + Gemini coach
    { method: 'POST', path: '/api/v1/ai/analyze', windowMs: 5 * 60_000, perClient: 30, global: 90 },
    { method: 'POST', path: '/api/v1/ai/analyze-symbol', windowMs: 5 * 60_000, perClient: 30, global: 90 },
    { method: 'POST', path: '/api/v1/ai/coach', windowMs: 5 * 60_000, perClient: 30, global: 90 },
    // Full-market fan-out to TWSE/TPEx/Yahoo
    { method: 'POST', path: '/api/v1/data/full-screener', windowMs: 5 * 60_000, perClient: 6, global: 15 },
    // Swaps the live market provider
    { method: 'POST', path: '/api/v1/config/market', windowMs: 10 * 60_000, perClient: 5, global: 10 },
    // Spawns Python + TWSE/TPEx closing fetch
    { method: 'POST', path: '/api/v1/research/preopen-limitup/run', windowMs: 10 * 60_000, perClient: 3, global: 6 },
    // Real Fugle REST calls + optional extra WebSocket connection
    { method: 'GET', path: '/api/v1/system/fugle-plan', windowMs: 10 * 60_000, perClient: 3, global: 6 },
    // Runs the in-process CPU profiler for up to 30s
    { method: 'POST', path: '/api/v1/system/cpu-profiles/run', windowMs: 10 * 60_000, perClient: 2, global: 3 },
];

/** Render sits behind Cloudflare: prefer the edge-set client IP over spoofable XFF heads. */
export function clientKey(req: FastifyRequest): string {
    const h = req.headers;
    const one = (v: string | string[] | undefined) =>
        (Array.isArray(v) ? v[0] : v)?.trim() || '';
    const xff = one(h['x-forwarded-for']).split(',').map((s) => s.trim()).filter(Boolean);
    return (
        one(h['cf-connecting-ip']) ||
        one(h['true-client-ip']) ||
        xff[xff.length - 1] ||
        req.ip ||
        'unknown'
    );
}

export class FixedWindowLimiter {
    private buckets = new Map<string, { start: number; count: number }>();

    hit(key: string, limit: number, windowMs: number, nowMs: number): number | null {
        let b = this.buckets.get(key);
        if (!b || nowMs - b.start >= windowMs) {
            b = { start: nowMs, count: 0 };
            this.buckets.set(key, b);
        }
        if (b.count >= limit) {
            return Math.max(1, Math.ceil((b.start + windowMs - nowMs) / 1000));
        }
        b.count++;
        if (this.buckets.size > 5000) this.sweep(nowMs, windowMs);
        return null;
    }

    private sweep(nowMs: number, windowMs: number): void {
        for (const [k, b] of this.buckets) {
            if (nowMs - b.start >= windowMs) this.buckets.delete(k);
        }
    }
}

export function registerRateLimits(
    app: FastifyInstance,
    rules: readonly RateRule[] = DEFAULT_RATE_RULES,
    now: () => number = Date.now,
): void {
    const limiter = new FixedWindowLimiter();
    app.addHook('onRequest', async (req, reply) => {
        const path = req.url.split('?')[0];
        const rule = rules.find((r) => r.method === req.method && r.path === path);
        if (!rule) return;
        const t = now();
        // Client first so one blocked client does not keep draining the route-wide cap.
        const retry =
            limiter.hit(`c:${rule.method}:${rule.path}:${clientKey(req)}`, rule.perClient, rule.windowMs, t) ??
            limiter.hit(`g:${rule.method}:${rule.path}`, rule.global, rule.windowMs, t);
        if (retry != null) {
            return reply
                .code(429)
                .header('Retry-After', String(retry))
                .send({ error: 'rate_limited', detail: `請求太頻繁，請 ${retry} 秒後再試` });
        }
    });
}
