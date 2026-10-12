// server/src/routes/shioaji-ticks.ts — research only: one stock-day of historical
// Shioaji ticks straight from the bridge, whatever the live market provider is.
// Refused during the session and when the shared daily data quota runs low, so
// backtest fetches can never starve live quotes. One fetch at a time.

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { isTradingDay } from '../lib/market-calendar/trading-day.ts';
import { sessionMinuteTaipei, taipeiYmd } from '../lib/shadow/session.ts';

/** Bytes that must stay unused for the live session after any research fetch. */
export const SHIOAJI_TICKS_QUOTA_FLOOR_BYTES = 150 * 1024 * 1024;

/** 08:25–13:35 on trading days belongs to the live session. */
export function shioajiTicksBlocked(d: Date = new Date()): boolean {
    if (!isTradingDay(taipeiYmd(d))) return false;
    const sm = sessionMinuteTaipei(d);
    return sm >= -35 && sm < 275;
}

export function registerShioajiTicksRoutes(
    app: FastifyInstance,
    ctx: AppContext,
    now: () => Date = () => new Date(),
): void {
    let busy = false;
    app.get('/api/v1/research/shioaji-ticks', async (req, reply) => {
        const q = req.query as Record<string, string | undefined>;
        const code = q.code ?? '';
        const date = q.date ?? '';
        const exchange = (q.exchange ?? 'TSE').toUpperCase();
        if (!/^\d{4,6}[A-Z]?$/.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !['TSE', 'OTC'].includes(exchange)) {
            return reply.code(400).send({ error: 'invalid_query', detail: 'code, date=YYYY-MM-DD, exchange=TSE|OTC' });
        }
        if (date >= taipeiYmd(now()) || shioajiTicksBlocked(now())) {
            return reply.code(503).send({ error: 'session_protected', detail: '盤中或當日不提供歷史逐筆，請收盤後查前一交易日以前的資料' });
        }
        if (busy) {
            return reply.code(429).header('Retry-After', '5').send({ error: 'busy', detail: '一次只處理一檔' });
        }
        busy = true;
        try {
            const base = ctx.config.shioajiBridgeUrl.replace(/\/$/, '');
            const usageRes = await fetch(`${base}/usage`, { signal: AbortSignal.timeout(10_000) });
            const usage = usageRes.ok ? ((await usageRes.json()) as { remaining_bytes?: number }) : {};
            const remaining = Number(usage.remaining_bytes);
            if (!Number.isFinite(remaining) || remaining < SHIOAJI_TICKS_QUOTA_FLOOR_BYTES) {
                return reply.code(503).send({
                    error: 'quota_floor',
                    detail: '永豐每日流量剩餘不足，保留給盤中使用',
                    remaining_mb: Number.isFinite(remaining) ? Math.round(remaining / 1048576) : null,
                });
            }
            const res = await fetch(`${base}/ticks`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ contract: { security_type: 'STK', exchange, code }, date }),
                signal: AbortSignal.timeout(90_000),
            });
            if (!res.ok) {
                return reply.code(502).send({ error: 'bridge_error', status: res.status });
            }
            return reply
                .header('content-type', 'application/json; charset=utf-8')
                .header('x-shioaji-remaining-mb', String(Math.round(remaining / 1048576)))
                .send(Buffer.from(await res.arrayBuffer()));
        } catch (err) {
            return reply.code(502).send({ error: 'bridge_unreachable', detail: err instanceof Error ? err.name : 'error' });
        } finally {
            busy = false;
        }
    });
}
