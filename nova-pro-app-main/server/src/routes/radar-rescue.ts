// server/src/routes/radar-rescue.ts

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import {
    isValidReportSource,
    LIVE_EARLY_DAILY_REPORT_MESSAGE,
    LIVE_EARLY_DAILY_REPORT_WIRED,
    gateEarlyDailyReportDate,
} from '../lib/radar-rescue/early-daily-report.ts';

export function registerRadarRescueRoutes(
    app: FastifyInstance,
    ctx: AppContext,
): void {
    const svc = () => ctx.radarRescue;

    app.get('/api/v1/data/radar-rescue/health', async () => {
        const s = svc();
        if (!s) return { enabled: false, status: 'DISABLED' };
        return s.getHealth();
    });

    app.get('/api/v1/data/radar-rescue', async (_req, reply) => {
        const s = svc();
        if (!s) return reply.code(503).send({ error: 'disabled' });
        const batch = s.getLastBatch() ?? (await s.evaluate());
        return batch ?? { error: 'warming_up' };
    });

    app.get('/api/v1/data/radar-rescue/focus', async (_req, reply) => {
        const s = svc();
        if (!s) return reply.code(503).send({ error: 'disabled' });
        const batch = s.getLastBatch();
        return batch?.focus ?? { early: [], confirmed: [] };
    });

    app.get<{ Params: { symbol: string } }>(
        '/api/v1/data/radar-rescue/:symbol',
        async (req, reply) => {
            const s = svc();
            if (!s) return reply.code(503).send({ error: 'disabled' });
            const item = s.getSymbol(req.params.symbol);
            if (!item) return reply.code(404).send({ error: 'not_found' });
            return item;
        },
    );

    app.get('/api/v1/data/radar-rescue/funnel', async (_req, reply) => {
        const s = svc();
        if (!s) return reply.code(503).send({ error: 'disabled' });
        return { items: s.getFunnel(), count: s.getFunnel().length };
    });

    app.get('/api/v1/data/radar-rescue/recall', async (_req, reply) => {
        const s = svc();
        if (!s) return reply.code(503).send({ error: 'disabled' });
        return s.getRecall() ?? { error: 'not_ready' };
    });

    /**
     * EARLY daily validation — read-only.
     * Query: date=YYYY-MM-DD&source=replay|synthetic|live[&run_id=]
     * Without source: returns list payload (full evaluable by default).
     * Invalid date → 400. Live rates omitted while pipeline is not wired.
     */
    app.get('/api/v1/data/radar-rescue/early/daily-report', async (req, reply) => {
        const s = svc();
        if (!s) return reply.code(503).send({ error: 'disabled' });
        const q = req.query as Record<string, string | undefined>;
        const dateGate = gateEarlyDailyReportDate(q.date);
        if (!dateGate.ok) {
            return reply.code(dateGate.httpStatus).send({
                error: dateGate.error,
                message: dateGate.message,
                received: dateGate.received,
            });
        }
        const date = dateGate.date;
        const source = q.source as
            | 'replay'
            | 'synthetic'
            | 'live'
            | undefined;
        const includePartial =
            q.include_partial === '1' || q.include_partial === 'true';

        if (source) {
            if (!isValidReportSource(source)) {
                return reply.code(400).send({
                    error: 'invalid_source',
                    allowed: ['replay', 'synthetic', 'live'],
                });
            }
            if (
                source === 'live' &&
                !LIVE_EARLY_DAILY_REPORT_WIRED
            ) {
                return reply.code(404).send({
                    error: 'live_not_wired',
                    date,
                    source,
                    message: LIVE_EARLY_DAILY_REPORT_MESSAGE,
                });
            }
            const report = s.getEarlyDailyReport(date, source);
            if (!report) {
                return reply.code(404).send({
                    error: 'not_found',
                    date,
                    source,
                    message: '尚無該來源的完整 EARLY 日報',
                });
            }
            return report;
        }

        return s.listEarlyDailyReportApi(date, includePartial);
    });

    app.post('/api/v1/data/radar-rescue/eod-truth/run', async (_req, reply) => {
        const s = svc();
        if (!s) return reply.code(503).send({ error: 'disabled' });
        const report = await s.runEodTruthAndRecall();
        return { ok: true, recall: report, truth_count: s.getEodTruth().length };
    });

    app.get('/api/v1/data/radar-rescue/eod-truth', async (_req, reply) => {
        const s = svc();
        if (!s) return reply.code(503).send({ error: 'disabled' });
        const items = s.getEodTruth();
        return { count: items.length, items };
    });
}
