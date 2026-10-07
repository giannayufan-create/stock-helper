// Pre-open scan capture + post-close limit-up analysis (read-only research).
//   GET  /api/v1/research/preopen-live                    latest live pre-open ranking (memory)
//   GET  /api/v1/research/preopen-scans?date=            raw ndjson rows
//   GET  /api/v1/research/preopen-limitup?date=[&format=md|csv]
//   GET  /api/v1/research/preopen-limitup/dates
//   POST /api/v1/research/preopen-limitup/run?date=       outside market hours only

import { createReadStream, existsSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { serverDataDir } from '../lib/data-janitor.ts';
import { isTradingDay } from '../lib/market-calendar/trading-day.ts';
import { sessionMinuteTaipei, taipeiYmd } from '../lib/shadow/session.ts';
import { isPreopenRankWindow, preopenLiveState, preopenScanFile } from '../lib/preopen-scan/capture.ts';
import {
    lastPreopenRun,
    listPreopenDates,
    preopenReportPath,
    runPreopenAnalysis,
} from '../lib/preopen-scan/analysis-runner.ts';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** 08:25–13:35 on trading days: the analysis spawns Python and fetches EOD, keep it off the session. */
export function isPreopenRunBlocked(d: Date = new Date()): boolean {
    if (!isTradingDay(taipeiYmd(d))) return false;
    const sm = sessionMinuteTaipei(d);
    return sm >= -35 && sm < 275;
}

export function registerPreopenScanRoutes(
    app: FastifyInstance,
    _ctx: AppContext,
    dataDir: string = serverDataDir(),
) {
    const pickDate = (q: Record<string, string | undefined>) =>
        q.date && YMD.test(q.date) ? q.date : q.date ? null : taipeiYmd();

    app.get('/api/v1/research/preopen-scans', async (req, reply) => {
        const date = pickDate(req.query as Record<string, string | undefined>);
        if (!date) return reply.code(400).send({ error: 'invalid_date' });
        const file = preopenScanFile(date, dataDir);
        if (!existsSync(file)) {
            return reply.code(404).send({ error: 'not_found', date, message: '這天沒有盤前掃描紀錄' });
        }
        return reply
            .header('Content-Type', 'application/x-ndjson; charset=utf-8')
            .send(createReadStream(file));
    });

    app.get('/api/v1/research/preopen-live', async () => {
        const date = taipeiYmd();
        const state = preopenLiveState(date, dataDir);
        return {
            date,
            rank_window: isPreopenRankWindow(),
            state,
        };
    });

    app.get('/api/v1/research/preopen-limitup/dates', async () => ({
        ...listPreopenDates(dataDir),
        last_run: lastPreopenRun(),
    }));

    app.get('/api/v1/research/preopen-limitup', async (req, reply) => {
        const q = req.query as Record<string, string | undefined>;
        const date = pickDate(q);
        if (!date) return reply.code(400).send({ error: 'invalid_date' });
        const ext = q.format === 'md' ? 'md' : q.format === 'csv' ? 'csv' : 'json';
        const file = preopenReportPath(dataDir, date, ext);
        if (!existsSync(file)) {
            return reply.code(404).send({
                error: 'not_found',
                date,
                has_scans: existsSync(preopenScanFile(date, dataDir)),
                last_run: lastPreopenRun(),
                message: '這天的盤前漲停分析尚未產生（收盤資料約 14:30 公布，14:45 起自動分析）',
            });
        }
        const body = readFileSync(file, 'utf8');
        if (ext === 'json') return reply.header('Content-Type', 'application/json; charset=utf-8').send(body);
        if (ext === 'csv') return reply.header('Content-Type', 'text/csv; charset=utf-8').send(body);
        return reply.header('Content-Type', 'text/markdown; charset=utf-8').send(body);
    });

    app.post('/api/v1/research/preopen-limitup/run', async (req, reply) => {
        const date = pickDate(req.query as Record<string, string | undefined>);
        if (!date) return reply.code(400).send({ error: 'invalid_date' });
        if (isPreopenRunBlocked()) {
            return reply.code(409).send({ error: 'market_hours', message: '盤中不跑分析，13:35 後再試' });
        }
        const r = await runPreopenAnalysis(dataDir, date);
        const code = r.status === 'ok' ? 200 : r.status === 'busy' ? 409 : r.status === 'no_scans' ? 404 : 503;
        return reply.code(code).send(r);
    });
}
