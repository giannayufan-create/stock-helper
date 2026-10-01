// Run: npx tsx src/lib/rate-limit.test.ts

import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { GeminiBudget } from './ai-budget.ts';
import { registerRateLimits, type RateRule } from './rate-limit.ts';

let passed = 0;
function pass(name: string) {
    passed++;
    console.log(`PASS ${name}`);
}

// ---- per-client and global caps, other routes untouched ----
{
    let now = 1_000_000;
    const rules: RateRule[] = [
        { method: 'POST', path: '/x', windowMs: 60_000, perClient: 2, global: 3 },
    ];
    const app = Fastify();
    registerRateLimits(app, rules, () => now);
    app.post('/x', async () => ({ ok: true }));
    app.post('/y', async () => ({ ok: true }));
    const hit = (path: string, ip: string) =>
        app.inject({ method: 'POST', url: path, headers: { 'cf-connecting-ip': ip } });

    assert.equal((await hit('/x', 'a')).statusCode, 200);
    assert.equal((await hit('/x?q=1', 'a')).statusCode, 200);
    const limited = await hit('/x', 'a');
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal((await hit('/x', 'b')).statusCode, 200);
    assert.equal((await hit('/x', 'c')).statusCode, 429, 'global cap');
    for (let i = 0; i < 10; i++) {
        assert.equal((await hit('/y', 'a')).statusCode, 200);
    }
    now += 60_000;
    assert.equal((await hit('/x', 'a')).statusCode, 200, 'window resets');
    await app.close();
    pass('rate_limit_per_client_global_and_reset');
}

// ---- Gemini budget: per-minute and daily caps, daily reset at Taipei midnight ----
{
    const b = new GeminiBudget(3, 2);
    let t = Date.parse('2026-10-01T02:00:00.000Z');
    assert.equal(b.take(t).ok, true);
    assert.equal(b.take(t).ok, true);
    assert.equal(b.take(t).ok, false, 'per-minute');
    t += 60_000;
    assert.equal(b.take(t).ok, true);
    t += 60_000;
    assert.equal(b.take(t).ok, false, 'daily');
    t = Date.parse('2026-10-01T16:05:00.000Z'); // 00:05 Taipei next day
    assert.equal(b.take(t).ok, true);
    pass('gemini_budget_caps_and_daily_reset');
}

console.log(`\nOK ${passed} tests`);
