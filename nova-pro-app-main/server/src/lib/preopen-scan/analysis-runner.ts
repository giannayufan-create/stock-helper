// Post-close: run server/py/preopen_limitup.py on the day's pre-open scans
// against TWSE/TPEx closing data. Read-only research; the script never touches
// A/B/C/BP/Rank or any order path.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTradingDay } from '../market-calendar/trading-day.ts';
import { sessionMinuteTaipei, taipeiYmd } from '../shadow/session.ts';
import { PREOPEN_SCAN_DIR, preopenScanFile } from './capture.ts';

export const PREOPEN_REPORT_DIR = 'preopen-reports';

const SCRIPT = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'py',
    'preopen_limitup.py',
);
const RUN_TIMEOUT_MS = 300_000;
const TICK_MS = 5 * 60_000;
/** 14:45 Taipei — TWSE/TPEx closing tables are usually out by ~14:30. */
const START_AFTER_SESSION_MIN = 345;
const MAX_ATTEMPTS_PER_DAY = 8;

export const EXIT_NO_SCANS = 2;
export const EXIT_EOD_NOT_READY = 3;

export interface PreopenRunResult {
    date: string;
    exit_code: number | null;
    status: 'ok' | 'no_scans' | 'eod_not_ready' | 'failed' | 'busy' | 'timeout';
    duration_ms: number;
    stdout_tail: string;
    stderr_tail: string;
}

export function preopenReportPath(dataDir: string, ymd: string, ext: 'json' | 'md' | 'csv'): string {
    return join(dataDir, PREOPEN_REPORT_DIR, `${ymd}.${ext}`);
}

export function listPreopenDates(dataDir: string): { scans: string[]; reports: string[] } {
    const dated = (dir: string, ext: string) => {
        try {
            return readdirSync(join(dataDir, dir))
                .filter((n) => /^\d{4}-\d{2}-\d{2}\./.test(n) && n.endsWith(ext))
                .map((n) => n.slice(0, 10))
                .sort()
                .reverse();
        } catch {
            return [];
        }
    };
    return { scans: dated(PREOPEN_SCAN_DIR, '.jsonl'), reports: dated(PREOPEN_REPORT_DIR, '.json') };
}

let running: Promise<PreopenRunResult> | null = null;
let lastResult: PreopenRunResult | null = null;

export function lastPreopenRun(): PreopenRunResult | null {
    return lastResult;
}

const tail = (s: string) => (s.length > 2000 ? s.slice(-2000) : s);

export function runPreopenAnalysis(
    dataDir: string,
    ymd: string,
    opts: { pythonBin?: string; script?: string; timeoutMs?: number } = {},
): Promise<PreopenRunResult> {
    if (running) {
        return Promise.resolve({
            date: ymd,
            exit_code: null,
            status: 'busy',
            duration_ms: 0,
            stdout_tail: '',
            stderr_tail: 'another analysis is running',
        });
    }
    const started = Date.now();
    const python = opts.pythonBin ?? process.env.PYTHON_BIN ?? 'python3';
    const args = [
        opts.script ?? SCRIPT,
        '--date',
        ymd,
        '--data-dir',
        dataDir,
        '--out-dir',
        join(dataDir, PREOPEN_REPORT_DIR),
    ];
    running = new Promise<PreopenRunResult>((resolve) => {
        let out = '';
        let err = '';
        let timedOut = false;
        const child = spawn(python, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, opts.timeoutMs ?? RUN_TIMEOUT_MS);
        child.stdout.on('data', (b: Buffer) => {
            out = tail(out + b.toString('utf8'));
        });
        child.stderr.on('data', (b: Buffer) => {
            err = tail(err + b.toString('utf8'));
        });
        const finish = (code: number | null, spawnError?: Error) => {
            clearTimeout(timer);
            const status: PreopenRunResult['status'] = timedOut
                ? 'timeout'
                : code === 0
                  ? 'ok'
                  : code === EXIT_NO_SCANS
                    ? 'no_scans'
                    : code === EXIT_EOD_NOT_READY
                      ? 'eod_not_ready'
                      : 'failed';
            resolve({
                date: ymd,
                exit_code: code,
                status,
                duration_ms: Date.now() - started,
                stdout_tail: out,
                stderr_tail: spawnError ? String(spawnError.message) : err,
            });
        };
        child.on('error', (e) => finish(null, e));
        child.on('close', (code) => finish(code));
    }).then((r) => {
        lastResult = r;
        running = null;
        console.log(
            `[preopen-analysis] ${r.date} status=${r.status} exit=${r.exit_code} ms=${r.duration_ms}`,
        );
        return r;
    });
    return running;
}

/** After 14:45 on a trading day with scans but no report: run, retrying while closing data is not out. */
export function startPreopenAnalysisScheduler(dataDir: string): () => void {
    const attempts = new Map<string, number>();
    const tick = () => {
        const now = new Date();
        const ymd = taipeiYmd(now);
        if (!isTradingDay(ymd)) return;
        if (sessionMinuteTaipei(now) < START_AFTER_SESSION_MIN) return;
        if (!existsSync(preopenScanFile(ymd, dataDir))) return;
        if (existsSync(preopenReportPath(dataDir, ymd, 'json'))) return;
        const n = attempts.get(ymd) ?? 0;
        if (n >= MAX_ATTEMPTS_PER_DAY || running) return;
        attempts.set(ymd, n + 1);
        void runPreopenAnalysis(dataDir, ymd);
    };
    const timer = setInterval(tick, TICK_MS);
    timer.unref();
    return () => clearInterval(timer);
}
