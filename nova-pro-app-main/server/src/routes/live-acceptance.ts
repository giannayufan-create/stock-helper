// server/src/routes/live-acceptance.ts — observe-only Full + Daily Live Acceptance APIs

import { readFileSync, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

function commitHash(): string | null {
    return (
        process.env.RENDER_GIT_COMMIT ??
        process.env.GIT_COMMIT ??
        null
    );
}

export function registerLiveAcceptanceRoutes(
    app: FastifyInstance,
    ctx: AppContext,
) {
    const la = () => ctx.liveAcceptance;

    const guard = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
        const svc = la();
        if (!svc) {
            reply.code(503).send({ error: 'disabled', mutates_strategy: false });
            return null;
        }
        return svc;
    };

    // ---- Legacy paths (keep) ----
    app.get('/api/v1/live-acceptance/status', async () => {
        const svc = la();
        if (!svc) {
            return {
                enabled: false,
                instrumentation_ready: false,
                mutates_strategy: false,
                creates_upstream_subscription: false,
            };
        }
        return { enabled: true, ...svc.getStatus() };
    });

    app.post('/api/v1/live-acceptance/sample', async (_req, reply) => {
        const svc = guard(reply);
        if (!svc) return;
        const runtime = await svc.sampleRuntime();
        const coverage = await svc.sampleCoverage();
        return {
            runtime,
            coverage,
            mutates_strategy: false,
            creates_upstream_subscription: false,
        };
    });

    app.get('/api/v1/live-acceptance/report', async (_req, reply) => {
        const svc = guard(reply);
        if (!svc) return;
        return svc.buildAcceptanceReport(commitHash());
    });

    // ---- Daily Live Acceptance Report v1 (system namespace) ----
    app.get('/api/v1/system/live-acceptance/today', async (_req, reply) => {
        const svc = guard(reply);
        if (!svc) return;
        return svc.getTodaySummary();
    });

    app.get('/api/v1/system/live-acceptance/report', async (_req, reply) => {
        const svc = guard(reply);
        if (!svc) return;
        const today = svc.getTodaySummary();
        if (today.finalized) {
            const samples = svc.getDailySamples();
            return {
                ...today,
                samples: samples.samples,
                anomalies: samples.anomalies,
                download: {
                    json: `/api/v1/system/live-acceptance/download/json`,
                    md: `/api/v1/system/live-acceptance/download/md`,
                    csv: `/api/v1/system/live-acceptance/download/csv`,
                },
            };
        }
        // Preview without writing
        const preview = svc.getDailySamples();
        return {
            ...today,
            preview: true,
            samples: preview.samples,
            anomalies: preview.anomalies,
            mutates_strategy: false,
        };
    });

    app.get('/api/v1/system/live-acceptance/samples', async (_req, reply) => {
        const svc = guard(reply);
        if (!svc) return;
        return svc.getDailySamples();
    });

    app.post('/api/v1/system/live-acceptance/finalize', async (_req, reply) => {
        const svc = guard(reply);
        if (!svc) return;
        const report = svc.finalizeDailyReport(commitHash());
        return {
            ok: true,
            overall: report.overall,
            trading_day: report.trading_day,
            paths: report.paths,
            quality: report.quality,
            mutates_strategy: false,
            creates_upstream_subscription: false,
        };
    });

    const sendFile = (
        reply: {
            type: (t: string) => unknown;
            header: (k: string, v: string) => unknown;
            send: (b: unknown) => unknown;
            code: (n: number) => { send: (b: unknown) => unknown };
        },
        kind: 'json' | 'md' | 'csv',
    ) => {
        const svc = la();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const report = svc.finalizeDailyReport(commitHash());
        const path =
            kind === 'json'
                ? report.paths.json
                : kind === 'md'
                  ? report.paths.md
                  : report.paths.csv;
        if (!existsSync(path)) {
            return reply.code(404).send({ error: 'not_found', path });
        }
        const body = readFileSync(path, 'utf8');
        const type =
            kind === 'json'
                ? 'application/json'
                : kind === 'md'
                  ? 'text/markdown; charset=utf-8'
                  : 'text/csv; charset=utf-8';
        reply.type(type);
        reply.header(
            'Content-Disposition',
            `attachment; filename="${path.split(/[/\\]/).pop()}"`,
        );
        return reply.send(body);
    };

    app.get('/api/v1/system/live-acceptance/download/json', async (_req, reply) =>
        sendFile(reply, 'json'),
    );
    app.get('/api/v1/system/live-acceptance/download/md', async (_req, reply) =>
        sendFile(reply, 'md'),
    );
    app.get('/api/v1/system/live-acceptance/download/csv', async (_req, reply) =>
        sendFile(reply, 'csv'),
    );
}
