// server/src/routes/live-acceptance.ts — observe-only Full + Daily Live Acceptance APIs

import { readFileSync, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { buildZip } from '../lib/live-acceptance/zip-pack.ts';

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

    const guard = (
        reply: {
            code: (n: number) => { send: (b: unknown) => unknown };
        },
    ) => {
        const svc = la();
        if (!svc) {
            reply.code(503).send({
                error: 'disabled',
                detail: 'live acceptance disabled',
                mutates_strategy: false,
            });
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
                    zip: `/api/v1/system/live-acceptance/download/zip`,
                    json: `/api/v1/system/live-acceptance/download/json`,
                    md: `/api/v1/system/live-acceptance/download/md`,
                    csv: `/api/v1/system/live-acceptance/download/csv`,
                },
            };
        }
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
        try {
            const report = svc.finalizeDailyReport(commitHash());
            return {
                ok: true,
                overall: report.overall,
                trading_day: report.trading_day,
                generated_at: report.generated_at,
                paths: report.paths,
                quality: report.quality,
                anomalies_count: report.anomalies.length,
                mutates_strategy: false,
                creates_upstream_subscription: false,
            };
        } catch (e) {
            return reply.code(500).send({
                ok: false,
                error: 'finalize_failed',
                detail: e instanceof Error ? e.message : String(e),
                mutates_strategy: false,
            });
        }
    });

    const sendTextFile = (
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
        const paths = svc.getFinalizedPaths();
        if (!paths) {
            return reply.code(409).send({
                error: 'not_generated',
                detail: '尚未產生，請先產生今日驗收報告',
            });
        }
        const path =
            kind === 'json' ? paths.json : kind === 'md' ? paths.md : paths.csv;
        if (!existsSync(path)) {
            return reply.code(404).send({
                error: 'not_found',
                detail: '報告檔案不存在，請重新產生',
                path,
            });
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

    app.get(
        '/api/v1/system/live-acceptance/download/json',
        async (_req, reply) => sendTextFile(reply, 'json'),
    );
    app.get('/api/v1/system/live-acceptance/download/md', async (_req, reply) =>
        sendTextFile(reply, 'md'),
    );
    app.get(
        '/api/v1/system/live-acceptance/download/csv',
        async (_req, reply) => sendTextFile(reply, 'csv'),
    );

    /** Single ZIP pack for mobile — md + json + csv. */
    app.get(
        '/api/v1/system/live-acceptance/download/zip',
        async (_req, reply) => {
            const svc = la();
            if (!svc) {
                return reply.code(503).send({
                    error: 'disabled',
                    detail: 'live acceptance disabled',
                });
            }
            const paths = svc.getFinalizedPaths();
            if (!paths) {
                return reply.code(409).send({
                    error: 'not_generated',
                    detail: '尚未產生，請先產生今日驗收報告',
                });
            }
            for (const p of [paths.md, paths.json, paths.csv]) {
                if (!existsSync(p)) {
                    return reply.code(404).send({
                        error: 'not_found',
                        detail: '報告檔案不完整，請重新產生',
                        path: p,
                    });
                }
            }
            try {
                const day = paths.trading_day;
                const zip = buildZip([
                    {
                        name: `${day}-live-acceptance.md`,
                        data: readFileSync(paths.md),
                    },
                    {
                        name: `${day}-live-acceptance.json`,
                        data: readFileSync(paths.json),
                    },
                    {
                        name: `${day}-signal-samples.csv`,
                        data: readFileSync(paths.csv),
                    },
                ]);
                reply.type('application/zip');
                reply.header(
                    'Content-Disposition',
                    `attachment; filename="${paths.zip_name}"`,
                );
                reply.header('Content-Length', String(zip.length));
                return reply.send(zip);
            } catch (e) {
                return reply.code(500).send({
                    error: 'zip_failed',
                    detail: e instanceof Error ? e.message : String(e),
                });
            }
        },
    );
}
