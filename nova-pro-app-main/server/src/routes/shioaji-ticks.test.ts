// Run: npx tsx src/routes/shioaji-ticks.test.ts

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import type { AppContext } from '../context.ts';
import { registerShioajiTicksRoutes, shioajiTicksBlocked } from './shioaji-ticks.ts';

// 2026-10-12 is a Monday trading day; 2026-10-11 a Sunday.
assert.equal(shioajiTicksBlocked(new Date('2026-10-12T00:24:00Z')), false); // 08:24
assert.equal(shioajiTicksBlocked(new Date('2026-10-12T00:25:00Z')), true); // 08:25
assert.equal(shioajiTicksBlocked(new Date('2026-10-12T05:34:00Z')), true); // 13:34
assert.equal(shioajiTicksBlocked(new Date('2026-10-12T05:35:00Z')), false); // 13:35
assert.equal(shioajiTicksBlocked(new Date('2026-10-11T02:00:00Z')), false); // Sunday 10:00

let remaining = 400 * 1024 * 1024;
let ticksCalls = 0;
let lastBody: Record<string, unknown> | null = null;
let release: (() => void) | null = null;
const bridge = createServer((req, res) => {
    if (req.url === '/usage') {
        res.end(JSON.stringify({ available: true, remaining_bytes: remaining }));
        return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
        ticksCalls += 1;
        lastBody = JSON.parse(raw);
        const send = () =>
            res.end(JSON.stringify({ date: '2026-10-08', datetime: ['2026-10-08T09:00:00.479+00:00'], close: [415], volume: [413], tick_type: [1] }));
        if (release === null && (lastBody as { contract: { code: string } }).contract.code === '9999') {
            release = send;
        } else send();
    });
});
await new Promise<void>((r) => bridge.listen(0, '127.0.0.1', r));
const port = (bridge.address() as AddressInfo).port;

let clock = new Date('2026-10-12T07:00:00Z'); // 15:00 Taipei
const app = Fastify();
registerShioajiTicksRoutes(app, { config: { shioajiBridgeUrl: `http://127.0.0.1:${port}/` } } as unknown as AppContext, () => clock);
const get = (qs: string) => app.inject({ method: 'GET', url: `/api/v1/research/shioaji-ticks?${qs}` });

assert.equal((await get('code=24&date=2026-10-08')).statusCode, 400);
assert.equal((await get('code=2492&date=2026-10-12')).statusCode, 503, 'same-day refused');

const ok = await get('code=2492&date=2026-10-08&exchange=otc');
assert.equal(ok.statusCode, 200);
assert.equal(ok.json().tick_type[0], 1);
assert.equal(ok.headers['x-shioaji-remaining-mb'], '400');
assert.deepEqual(lastBody, { contract: { security_type: 'STK', exchange: 'OTC', code: '2492' }, date: '2026-10-08' });

clock = new Date('2026-10-12T02:00:00Z'); // 10:00 Taipei, in session
const calls = ticksCalls;
assert.equal((await get('code=2492&date=2026-10-08')).statusCode, 503);
assert.equal(ticksCalls, calls, 'no bridge call during the session');

clock = new Date('2026-10-12T07:00:00Z');
remaining = 149 * 1024 * 1024;
const low = await get('code=2492&date=2026-10-08');
assert.equal(low.statusCode, 503);
assert.equal(low.json().error, 'quota_floor');
assert.equal(ticksCalls, calls, 'no bridge call under the quota floor');

remaining = 400 * 1024 * 1024;
const slow = get('code=9999&date=2026-10-08');
while (release === null) await new Promise((r) => setTimeout(r, 5));
assert.equal((await get('code=2492&date=2026-10-08')).statusCode, 429, 'one fetch at a time');
(release as () => void)();
assert.equal((await slow).statusCode, 200);
assert.equal((await get('code=2492&date=2026-10-08')).statusCode, 200, 'free again after the slow fetch');

await app.close();
bridge.close();
console.log('OK shioaji-ticks route: session/quota guards, single flight, passthrough');
