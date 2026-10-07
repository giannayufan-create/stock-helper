// server/src/lib/preopen-scan/preopen-scan.test.ts
// Run: npx tsx src/lib/preopen-scan/preopen-scan.test.ts

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { AppContext } from '../../context.ts';
import type { ScannerItem } from '../../types/dto.ts';
import {
    isPreopenCaptureWindow,
    isPreopenRankWindow,
    preopenScanFile,
    recordPreopenScan,
    resetPreopenCaptureThrottle,
} from './capture.ts';
import { listPreopenDates, preopenReportPath, runPreopenAnalysis } from './analysis-runner.ts';
import { isPreopenRunBlocked, registerPreopenScanRoutes } from '../../routes/preopen-scan.ts';

let passed = 0;
function pass(name: string) {
    passed++;
    console.log(`PASS ${name}`);
}

// 2026-10-08 is a Thursday trading day; 2026-10-03 is a Saturday.
const tpe = (ymd: string, hms: string) => new Date(`${ymd}T${hms}+08:00`);
const DAY = '2026-10-08';

const item = (code: string, close: number, change: number): ScannerItem =>
    ({
        code,
        name: code,
        date: DAY,
        close,
        open: close,
        high: close,
        low: close,
        change_price: change,
        change_type: 1,
        average_price: close,
        price_range: 0,
        rank_value: 0,
        total_volume: 100,
        total_amount: close * 100,
        volume_ratio: 1,
        yesterday_volume: 100,
        tick_type: 1,
        buy_price: close,
        sell_price: close,
    }) as unknown as ScannerItem;

const readRows = (file: string) =>
    readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));

{
    assert.equal(isPreopenRankWindow(tpe(DAY, '08:29:59')), false);
    assert.equal(isPreopenRankWindow(tpe(DAY, '08:30:00')), true);
    assert.equal(isPreopenRankWindow(tpe(DAY, '08:59:59')), true);
    assert.equal(isPreopenRankWindow(tpe(DAY, '09:00:00')), false);
    assert.equal(isPreopenRankWindow(tpe('2026-10-03', '08:45:00')), false);
    assert.equal(isPreopenCaptureWindow(tpe(DAY, '08:24:59')), false);
    assert.equal(isPreopenCaptureWindow(tpe(DAY, '08:25:00')), true);
    assert.equal(isPreopenCaptureWindow(tpe(DAY, '09:09:59')), true);
    assert.equal(isPreopenCaptureWindow(tpe(DAY, '09:10:00')), false);
    pass('rank_window_0830_0900_capture_window_0825_0910_trading_days_only');
}

const dir = mkdtempSync(join(tmpdir(), 'preopen-scan-'));
try {
    {
        resetPreopenCaptureThrottle();
        const file = preopenScanFile(DAY, dir);
        const rows = [item('1111', 55, 5), item('2222', 22, 2)];
        recordPreopenScan('ChangePercentRank', 'shioaji', rows, false, tpe(DAY, '08:20:00'), dir);
        assert.equal(existsSync(file), false);
        recordPreopenScan('ChangePercentRank', 'shioaji', rows, true, tpe(DAY, '08:31:00'), dir);
        assert.equal(existsSync(file), false);
        recordPreopenScan('ChangePercentRank', 'shioaji', [], false, tpe(DAY, '08:31:00'), dir);
        assert.equal(existsSync(file), false);
        pass('skips_outside_window_ascending_and_empty');

        recordPreopenScan('ChangePercentRank', 'shioaji', rows, false, tpe(DAY, '08:31:00'), dir);
        recordPreopenScan('ChangePercentRank', 'shioaji', rows, false, tpe(DAY, '08:31:15'), dir);
        recordPreopenScan('VolumeRank', 'shioaji', rows, false, tpe(DAY, '08:31:15'), dir);
        recordPreopenScan('ChangePercentRank', 'overnight', rows, false, tpe(DAY, '08:31:15'), dir);
        recordPreopenScan('ChangePercentRank', 'shioaji', rows, false, tpe(DAY, '08:32:00'), dir);
        let got = readRows(file);
        assert.deepEqual(
            got.map((r) => `${r.type}|${r.source}|${r.t.slice(11, 19)}`),
            [
                'ChangePercentRank|shioaji|00:31:00',
                'VolumeRank|shioaji|00:31:15',
                'ChangePercentRank|overnight|00:31:15',
                'ChangePercentRank|shioaji|00:32:00',
            ],
        );
        assert.deepEqual(
            got[0].items.map((i: { rank: number; code: string }) => [i.rank, i.code]),
            [
                [1, '1111'],
                [2, '2222'],
            ],
        );
        assert.equal(got[0].items[0].change_price, 5);
        pass('one_row_per_type_and_source_per_minute');

        recordPreopenScan('ChangePercentRank', 'shioaji', rows, false, tpe(DAY, '08:58:00'), dir);
        recordPreopenScan('ChangePercentRank', 'shioaji', rows, false, tpe(DAY, '08:58:15'), dir);
        recordPreopenScan('ChangePercentRank', 'shioaji', rows, false, tpe(DAY, '08:59:45'), dir);
        got = readRows(file);
        assert.equal(got.length, 7);
        pass('last_three_minutes_before_open_are_not_throttled');
    }

    {
        assert.equal(isPreopenRunBlocked(tpe(DAY, '08:24:00')), false);
        assert.equal(isPreopenRunBlocked(tpe(DAY, '08:25:00')), true);
        assert.equal(isPreopenRunBlocked(tpe(DAY, '13:34:00')), true);
        assert.equal(isPreopenRunBlocked(tpe(DAY, '13:35:00')), false);
        assert.equal(isPreopenRunBlocked(tpe('2026-10-03', '10:00:00')), false);
        pass('manual_run_blocked_0825_1335_on_trading_days');
    }

    {
        const script = join(dir, 'fake.mjs');
        writeFileSync(
            script,
            "const code = Number(process.argv[process.argv.indexOf('--date') + 1].slice(-1));\n" +
                "process.stdout.write('args ' + process.argv.slice(2).join(' '));\n" +
                "setTimeout(() => process.exit(code), 50);\n",
        );
        const opts = { pythonBin: process.execPath, script };
        const [a, b] = await Promise.all([
            runPreopenAnalysis(dir, '2026-10-03', opts),
            runPreopenAnalysis(dir, '2026-10-03', opts),
        ]);
        assert.equal(a.status, 'eod_not_ready');
        assert.equal(a.exit_code, 3);
        assert.match(a.stdout_tail, /--data-dir/);
        assert.equal(b.status, 'busy');
        assert.equal((await runPreopenAnalysis(dir, '2026-10-02', opts)).status, 'no_scans');
        assert.equal((await runPreopenAnalysis(dir, '2026-10-00', opts)).status, 'ok');
        assert.equal((await runPreopenAnalysis(dir, '2026-10-01', opts)).status, 'failed');
        const slow = join(dir, 'slow.mjs');
        writeFileSync(slow, 'setTimeout(() => {}, 10_000);\n');
        const t = await runPreopenAnalysis(dir, DAY, { pythonBin: process.execPath, script: slow, timeoutMs: 200 });
        assert.equal(t.status, 'timeout');
        const missing = await runPreopenAnalysis(dir, DAY, { pythonBin: join(dir, 'no-such-python') });
        assert.equal(missing.status, 'failed');
        pass('runner_maps_exit_codes_single_flight_and_timeout');
    }

    {
        const app = Fastify();
        registerPreopenScanRoutes(app, {} as AppContext, dir);
        assert.equal((await app.inject({ url: '/api/v1/research/preopen-scans?date=bad' })).statusCode, 400);
        assert.equal((await app.inject({ url: '/api/v1/research/preopen-scans?date=2026-10-01' })).statusCode, 404);
        const scans = await app.inject({ url: `/api/v1/research/preopen-scans?date=${DAY}` });
        assert.equal(scans.statusCode, 200);
        assert.match(String(scans.headers['content-type']), /ndjson/);
        assert.equal(scans.body.trim().split('\n').length, 7);

        const miss = await app.inject({ url: `/api/v1/research/preopen-limitup?date=${DAY}` });
        assert.equal(miss.statusCode, 404);
        assert.equal(miss.json().has_scans, true);

        mkdirSync(join(dir, 'preopen-reports'), { recursive: true });
        writeFileSync(preopenReportPath(dir, DAY, 'json'), JSON.stringify({ label: DAY, mutates_strategy: false }));
        writeFileSync(preopenReportPath(dir, DAY, 'md'), '# 盤前名單');
        const rep = await app.inject({ url: `/api/v1/research/preopen-limitup?date=${DAY}` });
        assert.equal(rep.statusCode, 200);
        assert.equal(rep.json().label, DAY);
        const md = await app.inject({ url: `/api/v1/research/preopen-limitup?date=${DAY}&format=md` });
        assert.match(String(md.headers['content-type']), /markdown/);
        assert.equal(md.body, '# 盤前名單');

        const dates = await app.inject({ url: '/api/v1/research/preopen-limitup/dates' });
        assert.deepEqual(dates.json().scans, [DAY]);
        assert.deepEqual(dates.json().reports, [DAY]);
        assert.deepEqual(listPreopenDates(dir).reports, [DAY]);
        await app.close();
        pass('routes_serve_scans_and_reports');
    }
} finally {
    rmSync(dir, { recursive: true, force: true });
}

{
    const hits: unknown[] = [];
    let fail = false;
    const srv = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            hits.push({ url: req.url, body: JSON.parse(body) });
            if (fail) {
                res.writeHead(503).end('{"detail":"login"}');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(
                JSON.stringify([item('1111', 55, 5)]),
            );
        });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    process.env.SHIOAJI_BRIDGE_URL = `http://127.0.0.1:${port}/`;
    const { fetchShioajiScanner } = await import('../../providers/shioaji/bridge-scanner.ts');
    const ok = await fetchShioajiScanner('ChangePercentRank', 50, false);
    assert.equal(ok.length, 1);
    assert.deepEqual(hits[0], {
        url: '/scanner',
        body: { scanner_type: 'ChangePercentRank', count: 50, ascending: false },
    });
    fail = true;
    assert.deepEqual(await fetchShioajiScanner('VolumeRank', 50, false), []);
    await new Promise<void>((r) => srv.close(() => r()));
    assert.deepEqual(await fetchShioajiScanner('VolumeRank', 50, false, 1_000), []);
    pass('bridge_scanner_returns_rows_or_empty_on_error');
}

console.log(`\nOK ${passed} tests`);
