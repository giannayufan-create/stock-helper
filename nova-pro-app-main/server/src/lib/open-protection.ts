// server/src/lib/open-protection.ts
// 08:30–09:30 on trading days belongs to pre-open detection and the open gate.
// Research reports that scan whole day files are refused in that window so a
// page refresh cannot stall the event loop or push the 512MB instance over.

import type { FastifyInstance } from 'fastify';
import { isTradingDay } from './market-calendar/trading-day.ts';
import { sessionMinuteTaipei, taipeiYmd } from './shadow/session.ts';

const WINDOW_START_MIN = -30;
const WINDOW_END_MIN = 30;

export function isOpenProtectedWindow(d: Date = new Date()): boolean {
    if (!isTradingDay(taipeiYmd(d))) return false;
    const sm = sessionMinuteTaipei(d);
    return sm >= WINDOW_START_MIN && sm < WINDOW_END_MIN;
}

/** Seconds until 09:30 Taipei; only meaningful inside the window. */
export function secondsUntilWindowEnd(d: Date = new Date()): number {
    const sm = sessionMinuteTaipei(d);
    return Math.max(1, (WINDOW_END_MIN - sm) * 60 - d.getUTCSeconds());
}

export const HEAVY_RESEARCH_ROUTES: readonly string[] = [
    'GET /api/v1/live-acceptance/report',
    'GET /api/v1/system/live-acceptance/today',
    'GET /api/v1/system/live-acceptance/report',
    'GET /api/v1/system/live-acceptance/samples',
    'POST /api/v1/system/live-acceptance/finalize',
    'GET /api/v1/research/outcomes/summary',
    'GET /api/v1/research/strategy-validation/summary',
    'GET /api/v1/research/context/overview',
    'GET /api/v1/research/context/market',
    'GET /api/v1/research/context/sectors',
    'GET /api/v1/research/context/events',
    'GET /api/v1/research/context/combinations',
    'GET /api/v1/data/radar-rescue/early/daily-report',
    'POST /api/v1/data/radar-rescue/eod-truth/run',
    'GET /api/v1/research/preopen-scans',
];

export function registerOpenProtection(
    app: FastifyInstance,
    routes: readonly string[] = HEAVY_RESEARCH_ROUTES,
    now: () => Date = () => new Date(),
): void {
    const blocked = new Set(routes);
    app.addHook('onRequest', async (req, reply) => {
        const path = req.url.split('?')[0];
        if (!blocked.has(`${req.method} ${path}`)) return;
        const d = now();
        if (!isOpenProtectedWindow(d)) return;
        const retry = secondsUntilWindowEnd(d);
        return reply
            .code(503)
            .header('Retry-After', String(retry))
            .send({
                error: 'open_protection',
                detail: '08:30～09:30 開盤保護時段，研究報表請 9:30 後再查',
                retry_after_sec: retry,
            });
    });
}
