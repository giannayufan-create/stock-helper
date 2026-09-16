// server/src/routes/calendar.ts — Market Calendar APIs (read-only)

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { taipeiYmd } from '../lib/market-calendar/index.ts';

export function registerCalendarRoutes(app: FastifyInstance, ctx: AppContext) {
    const cal = () => ctx.marketCalendar;

    app.get('/api/v1/calendar/health', async () => {
        const svc = cal();
        if (!svc) {
            return {
                enabled: false,
                status: 'UNAVAILABLE',
                market_calendar_available: false,
            };
        }
        return { market_calendar_available: true, ...svc.getHealth() };
    });

    app.get('/api/v1/calendar/today', async (req, reply) => {
        const svc = cal();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const q = req.query as { date?: string };
        const asOf =
            q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date)
                ? q.date
                : taipeiYmd();
        const snap = svc.getToday(asOf);
        // Soft-attach major event count if EI available
        let major_event_count = 0;
        try {
            const ei = ctx.eventIntelligence;
            if (ei) {
                major_event_count = ei.getActive().length;
            }
        } catch {
            /* soft */
        }
        return {
            ...snap,
            major_event_count,
            creates_upstream_subscription: false,
            mutates_strategy: false,
        };
    });

    app.get('/api/v1/calendar/expiry', async (req, reply) => {
        const svc = cal();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const q = req.query as { date?: string };
        const asOf =
            q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date)
                ? q.date
                : taipeiYmd();
        const monthly = svc.getMonthlyExpiry(asOf);
        const weekly = svc.getWeeklyExpiry(asOf);
        return {
            as_of: asOf,
            monthly_expiry: monthly,
            weekly_expiry: weekly,
            /** Soft context — never a directional call. */
            calendar_context: {
                label: monthly.is_monthly_expiry_day
                    ? '台指期月結算'
                    : '台指期月契約',
                phase: monthly.expiry_phase,
                days_to_monthly_expiry: monthly.days_to_monthly_expiry,
                institutional_roll_sensitive:
                    monthly.institutional_roll_sensitive,
                note: '法人轉倉敏感期（非多空結論）',
            },
            creates_upstream_subscription: false,
            mutates_strategy: false,
        };
    });

    app.get('/api/v1/calendar/corporate-actions', async (req, reply) => {
        const svc = cal();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const q = req.query as {
            from?: string;
            to?: string;
            symbol?: string;
            action_type?: string;
            market?: string;
        };
        const items = svc.getActions({
            from: q.from,
            to: q.to,
            symbol: q.symbol,
            action_type: q.action_type,
            market: q.market,
        });
        return {
            count: items.length,
            items,
            creates_upstream_subscription: false,
            mutates_strategy: false,
        };
    });

    app.get<{ Params: { symbol: string } }>(
        '/api/v1/calendar/corporate-actions/:symbol',
        async (req, reply) => {
            const svc = cal();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const symbol = req.params.symbol.trim();
            const q = req.query as { date?: string };
            const asOf =
                q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date)
                    ? q.date
                    : taipeiYmd();
            const ctxCa = svc.getCorporateActionContext(symbol, asOf);
            const upcoming = svc.getActions({ symbol }).filter(
                (a) => a.action_date >= asOf,
            );
            return {
                symbol,
                as_of: asOf,
                corporate_action_context: ctxCa,
                upcoming,
                creates_upstream_subscription: false,
                mutates_strategy: false,
            };
        },
    );
}
