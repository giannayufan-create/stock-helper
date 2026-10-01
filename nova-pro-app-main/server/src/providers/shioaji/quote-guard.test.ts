// server/src/providers/shioaji/quote-guard.test.ts
// Run: npx tsx src/providers/shioaji/quote-guard.test.ts

import assert from 'node:assert/strict';
import {
    IntradayQueryBudget,
    QuoteRateLimiter,
    shouldPollSnapshotFallback,
} from './quote-guard.ts';
import { checkAdmin } from '../../lib/admin-auth.ts';

async function testRateLimiterCapsWindow(): Promise<void> {
    let now = 0;
    const slept: number[] = [];
    const limiter = new QuoteRateLimiter(
        3,
        10_000,
        () => now,
        async (ms) => {
            slept.push(ms);
            now += ms;
        },
    );
    for (let i = 0; i < 3; i++) await limiter.acquire();
    assert.equal(slept.length, 0);
    await limiter.acquire();
    assert.equal(slept.length, 1, '4th call waits for the window');
    assert.ok(now >= 10_000);
}

function testIntradayBudget(): void {
    let inSession = true;
    let now = new Date('2026-10-05T02:00:00.000Z');
    const budget = new IntradayQueryBudget(
        { kbars: 2, ticks: 1 },
        () => inSession,
        () => now,
    );
    assert.equal(budget.take('kbars'), true);
    assert.equal(budget.take('kbars'), true);
    assert.equal(budget.take('kbars'), false, 'cap reached in session');
    assert.equal(budget.take('ticks'), true);
    assert.equal(budget.take('ticks'), false);

    inSession = false;
    assert.equal(budget.take('kbars'), true, 'off-session not capped');

    inSession = true;
    now = new Date('2026-10-06T02:00:00.000Z');
    assert.equal(budget.take('kbars'), true, 'resets next trading day');
}

function testSnapshotFallbackGate(): void {
    const now = new Date('2026-10-05T02:00:00.000Z');
    const t = now.getTime();
    const on = () => true;
    const off = () => false;
    assert.equal(
        shouldPollSnapshotFallback({ now, lastStreamEventAt: 0, lastPollAt: 0, inSession: off }),
        false,
        'never off-session',
    );
    assert.equal(
        shouldPollSnapshotFallback({ now, lastStreamEventAt: t - 5_000, lastPollAt: 0, inSession: on }),
        false,
        'stream alive',
    );
    assert.equal(
        shouldPollSnapshotFallback({ now, lastStreamEventAt: t - 120_000, lastPollAt: 0, inSession: on }),
        true,
        'stream stalled',
    );
    assert.equal(
        shouldPollSnapshotFallback({
            now,
            lastStreamEventAt: t - 120_000,
            lastPollAt: t - 20_000,
            inSession: on,
        }),
        false,
        'at most once per minute',
    );
}

function testAdminCheck(): void {
    assert.deepEqual(
        checkAdmin({ headers: { 'x-admin-token': 's3cret' }, remoteAddress: '10.0.0.5', adminToken: 's3cret' }),
        { ok: true },
    );
    const wrong = checkAdmin({ headers: { 'x-admin-token': 'nope' }, remoteAddress: '10.0.0.5', adminToken: 's3cret' });
    assert.equal(wrong.ok, false);
    assert.equal(!wrong.ok && wrong.status, 401);
    const missing = checkAdmin({ headers: {}, remoteAddress: '127.0.0.1', adminToken: 's3cret' });
    assert.equal(missing.ok, false, 'token set: loopback still needs it');

    assert.deepEqual(
        checkAdmin({ headers: {}, remoteAddress: '127.0.0.1', adminToken: undefined }),
        { ok: true },
        'no token: direct loopback allowed',
    );
    const proxied = checkAdmin({
        headers: { 'x-forwarded-for': '127.0.0.1' },
        remoteAddress: '127.0.0.1',
        adminToken: undefined,
    });
    assert.equal(proxied.ok, false, 'no token: proxied request refused');
    const remote = checkAdmin({ headers: {}, remoteAddress: '10.0.0.5', adminToken: '' });
    assert.equal(remote.ok, false);
    assert.equal(!remote.ok && remote.status, 403);
}

async function main(): Promise<void> {
    await testRateLimiterCapsWindow();
    testIntradayBudget();
    testSnapshotFallbackGate();
    testAdminCheck();
    console.log('quote-guard tests: OK');
}

void main().catch((err) => {
    console.error(err);
    process.exit(1);
});
