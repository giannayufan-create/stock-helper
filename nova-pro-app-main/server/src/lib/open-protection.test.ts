// server/src/lib/open-protection.test.ts
// Run: npx tsx src/lib/open-protection.test.ts

import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {
    isOpenProtectedWindow,
    registerOpenProtection,
    secondsUntilWindowEnd,
} from './open-protection.ts';

let passed = 0;
function pass(name: string) {
    passed++;
    console.log(`PASS ${name}`);
}

// 2026-10-05 is a Monday trading day; 2026-10-03 is a Saturday.
const tpe = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+08:00`);

{
    assert.equal(isOpenProtectedWindow(tpe('2026-10-05', '08:29')), false);
    assert.equal(isOpenProtectedWindow(tpe('2026-10-05', '08:30')), true);
    assert.equal(isOpenProtectedWindow(tpe('2026-10-05', '09:00')), true);
    assert.equal(isOpenProtectedWindow(tpe('2026-10-05', '09:29')), true);
    assert.equal(isOpenProtectedWindow(tpe('2026-10-05', '09:30')), false);
    assert.equal(isOpenProtectedWindow(tpe('2026-10-03', '09:00')), false);
    pass('window_is_0830_to_0930_on_trading_days');
}

{
    assert.equal(secondsUntilWindowEnd(tpe('2026-10-05', '09:29')), 60);
    assert.equal(secondsUntilWindowEnd(tpe('2026-10-05', '08:30')), 3600);
    pass('retry_after_counts_down_to_0930');
}

{
    let clock = tpe('2026-10-05', '09:10');
    const app = Fastify();
    registerOpenProtection(
        app,
        ['GET /heavy', 'POST /heavy-post'],
        () => clock,
    );
    app.get('/heavy', async () => ({ ok: true }));
    app.post('/heavy-post', async () => ({ ok: true }));
    app.get('/core', async () => ({ ok: true }));

    const blocked = await app.inject({ method: 'GET', url: '/heavy?date=2026-10-05' });
    assert.equal(blocked.statusCode, 503);
    assert.equal(blocked.headers['retry-after'], '1200');
    assert.equal(blocked.json().error, 'open_protection');
    assert.equal((await app.inject({ method: 'POST', url: '/heavy-post' })).statusCode, 503);
    assert.equal((await app.inject({ method: 'GET', url: '/core' })).statusCode, 200);

    clock = tpe('2026-10-05', '09:30');
    assert.equal((await app.inject({ method: 'GET', url: '/heavy' })).statusCode, 200);
    await app.close();
    pass('heavy_routes_503_only_inside_window');
}

console.log(`\nOK ${passed} tests`);
