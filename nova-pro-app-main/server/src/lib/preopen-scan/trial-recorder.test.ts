// server/src/lib/preopen-scan/trial-recorder.test.ts
// Run: npx tsx src/lib/preopen-scan/trial-recorder.test.ts

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTrialPool, isTrialRecordWindow, preopenTrialsFile, TrialRecorder } from './trial-recorder.ts';

const DAY = '2026-10-13'; // Tuesday
const tpe = (hms: string, ymd = DAY) => new Date(`${ymd}T${hms}+08:00`);

assert.equal(isTrialRecordWindow(tpe('08:27:59')), false);
assert.equal(isTrialRecordWindow(tpe('08:28:00')), true);
assert.equal(isTrialRecordWindow(tpe('09:03:59')), true);
assert.equal(isTrialRecordWindow(tpe('09:04:00')), false);
assert.equal(isTrialRecordWindow(tpe('08:45:00', '2026-10-10')), false); // Saturday
assert.equal(isTrialRecordWindow(tpe('08:45:00', '2026-10-09')), false); // National Day holiday
console.log('PASS window 08:28–09:03 on trading days only');

const snap = (symbol: string, changePercent: number, tradeValue: number) => ({
    symbol,
    closePrice: 50,
    changePercent,
    tradeValue,
});
{
    const rows = [
        snap('1111', 9.9, 1e8),
        snap('2222', 2.9, 9e9),
        snap('3333', 5, 2e8),
        snap('00878', 8, 9e10), // ETF: not a 4-digit common stock
        snap('4444', 3, 1e7),
    ];
    const pool = buildTrialPool(rows, ['5555', '1111', '00878'], DAY, tpe('08:28:00'), { date: '2026-10-12', error: null });
    assert.deepEqual(
        pool.members.map((m) => [m.symbol, m.reasons.join('+')]),
        [
            ['5555', 'watchlist'],
            ['1111', 'watchlist+prev_strong+prev_value'],
            ['3333', 'prev_strong+prev_value'],
            ['4444', 'prev_strong+prev_value'],
            ['2222', 'prev_value'],
        ],
    );
    assert.equal(pool.members.find((m) => m.symbol === '1111')?.prev_change_pct, 9.9);
    assert.equal(pool.basis_date, '2026-10-12');
    const many = Array.from({ length: 300 }, (_, i) => snap(String(6000 + i), 3 + i / 100, 1e6 * (300 - i)));
    assert.equal(buildTrialPool(many, [], DAY, tpe('08:28:00'), { date: null, error: null }).members.length, 80);
    const watch = Array.from({ length: 60 }, (_, i) => String(7000 + i));
    const capped = buildTrialPool(many, watch, DAY, tpe('08:28:00'), { date: null, error: null });
    assert.equal(capped.members.length, 100);
    assert.equal(capped.members.filter((m) => m.reasons.includes('watchlist')).length, 40);
    console.log('PASS pool: watchlist, previous-session movers ≥3%, turnover leaders, common stocks only');
}

const quote = (symbol: string, over: Record<string, unknown> = {}) => ({
    date: DAY,
    symbol,
    referencePrice: 50,
    previousClose: 50,
    lastTrial: { bid: 51, ask: 51.1, price: 51, size: 120, time: 1791853500123456, serial: 77 },
    bids: [1, 2, 3, 4, 5, 6].map((i) => ({ price: 51 - i * 0.1, size: i * 10 })),
    asks: [1, 2, 3, 4, 5].map((i) => ({ price: 51 + i * 0.1, size: i })),
    total: { tradeVolume: 0, tradeVolumeAtBid: 0, tradeVolumeAtAsk: 0, transaction: 0 },
    isTrial: true,
    lastUpdated: 1791853500123456,
    serial: 77,
    ...over,
});

const dir = mkdtempSync(join(tmpdir(), 'trial-rec-'));
try {
    const calls: string[] = [];
    let snapshotStatus = 500;
    let quoteStatus = 200;
    let opened = new Set<string>();
    const rec = new TrialRecorder({
        dataDir: dir,
        watchlist: () => ['5555'],
        get: async (path) => {
            calls.push(path);
            if (path.startsWith('/snapshot/')) {
                return snapshotStatus === 200
                    ? { status: 200, body: { date: '2026-10-12', data: [snap('1111', 9.9, 1e8), snap('2222', 4, 5e8)] } }
                    : { status: snapshotStatus, body: null };
            }
            if (quoteStatus !== 200) return { status: quoteStatus, body: null };
            const sym = path.split('/').pop()!;
            return {
                status: 200,
                body: opened.has(sym)
                    ? quote(sym, { isTrial: false, openPrice: 51.5, openTime: 1791853200000000 })
                    : quote(sym),
            };
        },
    });

    // Snapshot down at 08:28: watchlist-only pool, recorded with the reason, rebuilt next cycle.
    const r1 = await rec.tick(tpe('08:28:00'));
    assert.equal(r1?.requested, 1);
    assert.equal(rec.currentPool()?.basis_error, 'snapshot_TSE_http_500');
    assert.equal(await rec.tick(tpe('08:28:30')), null, '60s cadence before 08:55');
    snapshotStatus = 200;
    const r2 = await rec.tick(tpe('08:29:00'));
    assert.equal(r2?.requested, 3);
    assert.deepEqual(rec.currentPool()?.members.map((m) => m.symbol), ['5555', '1111', '2222']);
    console.log('PASS pool rebuilt after snapshot failure; 60s cadence');

    calls.length = 0;
    assert.ok(await rec.tick(tpe('08:55:00')));
    assert.ok(await rec.tick(tpe('08:55:20')), '20s cadence from 08:55');
    assert.equal(await rec.tick(tpe('08:55:30')), null);
    assert.equal(calls.filter((c) => c.startsWith('/snapshot/')).length, 0, 'pool fixed once built');
    console.log('PASS 20s cadence 08:55–09:03');

    quoteStatus = 429;
    const r3 = await rec.tick(tpe('08:56:00'));
    assert.equal(r3?.http['429'] !== undefined, true);
    quoteStatus = 200;
    assert.equal(await rec.tick(tpe('08:56:20')), null);
    assert.equal(await rec.tick(tpe('08:56:40')), null);
    assert.ok(await rec.tick(tpe('08:57:00')));
    console.log('PASS 429 stops the cycle and backs off');

    opened = new Set(['1111']);
    const r4 = await rec.tick(tpe('09:00:00'));
    assert.equal(r4?.requested, 3);
    const r5 = await rec.tick(tpe('09:00:20'));
    assert.equal(r5?.requested, 2, 'opened symbols are not polled again after 09:00');
    console.log('PASS after 09:00 only symbols still in trial / delayed open are polled');

    const rows = readFileSync(preopenTrialsFile(DAY, dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const pools = rows.filter((r) => r.k === 'pool');
    assert.equal(pools.length, 2);
    assert.equal(pools[1].basis_date, '2026-10-12');
    const q = rows.find((r) => r.k === 'q' && r.s === '1111');
    assert.deepEqual(q.trial, { p: 51, s: 120, b: 51, a: 51.1, t: 1791853500123456, n: 77 });
    assert.equal(q.bids.length, 5);
    assert.deepEqual(q.asks[0], [51.1, 1]);
    assert.deepEqual(q.f, ['isTrial']);
    assert.equal(q.d, DAY);
    const cycles = rows.filter((r) => r.k === 'cycle');
    assert.equal(cycles.length, 8);
    assert.equal(cycles.find((c) => c.rate_limited)?.http['429'] > 0, true);
    console.log('PASS raw rows: trial match, five-level book, flags, exchange time, cycle meta');
} finally {
    rmSync(dir, { recursive: true, force: true });
}

console.log('\nOK trial-recorder');
