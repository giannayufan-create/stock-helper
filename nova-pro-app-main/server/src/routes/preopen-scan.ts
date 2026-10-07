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
import { isLimitQueueWindow, latestLimitQueue } from '../lib/preopen-scan/limit-queue.ts';
import {
    lastFuglePreopenDiag,
    type FuglePreopenDiag,
    type FugleQueueRow,
} from '../lib/preopen-scan/fugle-preopen.ts';
import { twLimitUpPrice } from '../lib/strategy-validation/bar-source.ts';
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

export interface PreopenLiveItem {
    rank: number;
    code: string;
    name: string;
    trial_price: number;
    trial_pct: number | null;
    limit_up_price: number | null;
    at_limit: boolean;
    trial_volume: number;
    top10_minutes: number;
    /** 09:00+ best-bid snapshot; queue_lots is the bid size when the bid sits at limit-up. */
    locked: boolean | null;
    queue_lots: number | null;
    last_price: number | null;
}

export interface PreopenLiveDto {
    date: string;
    phase: 'before' | 'trial' | 'open' | 'after';
    ranked_at: string | null;
    source: string | null;
    queue_at: string | null;
    queue_source: string | null;
    /** Latest Fugle pre-open check today: why Fugle was or was not used. */
    fugle_check: { at: string; ok: boolean; reason: string | null; confirmed: number } | null;
    items: PreopenLiveItem[];
}

function fugleCheck(diag: FuglePreopenDiag | null, date: string): PreopenLiveDto['fugle_check'] {
    if (!diag || taipeiYmd(new Date(diag.at)) !== date) return null;
    return { at: diag.at, ok: diag.ok, reason: diag.reason, confirmed: diag.confirmed };
}

export function buildPreopenLive(now: Date, dataDir: string): PreopenLiveDto {
    const date = taipeiYmd(now);
    const sm = sessionMinuteTaipei(now);
    const phase: PreopenLiveDto['phase'] = !isTradingDay(date)
        ? 'after'
        : sm < -30
          ? 'before'
          : isPreopenRankWindow(now)
            ? 'trial'
            : isLimitQueueWindow(now)
              ? 'open'
              : 'after';
    const state = preopenLiveState(date, dataDir);
    const queue = latestLimitQueue(date);
    const byCode = new Map((queue?.items ?? []).map((q) => [q.code, q]));
    const items: PreopenLiveItem[] = (state?.items ?? []).map((it) => {
        const ref = it.close - it.change_price;
        const limit = it.close > 0 && ref > 0 ? twLimitUpPrice(ref) : null;
        const q = byCode.get(it.code);
        const fugleFlag = q && 'limit_up_bid' in q ? (q as FugleQueueRow).limit_up_bid : false;
        const locked = q && limit != null ? fugleFlag || q.buy_price + 1e-6 >= limit : null;
        return {
            rank: it.rank,
            code: it.code,
            name: it.name,
            trial_price: it.close,
            trial_pct: ref > 0 ? Math.round((it.change_price / ref) * 10_000) / 100 : null,
            limit_up_price: limit,
            at_limit: limit != null && it.close + 1e-6 >= limit,
            trial_volume: it.total_volume,
            top10_minutes: state?.top10_minutes[it.code] ?? 0,
            locked,
            queue_lots: locked ? q!.buy_volume : null,
            last_price: q ? q.close : null,
        };
    });
    return {
        date,
        phase,
        ranked_at: state?.at ?? null,
        source: state?.source ?? null,
        queue_at: queue?.at ?? null,
        queue_source: queue?.source ?? null,
        fugle_check: fugleCheck(lastFuglePreopenDiag(), date),
        items,
    };
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

    app.get('/api/v1/research/preopen-live', async () => buildPreopenLive(new Date(), dataDir));

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
