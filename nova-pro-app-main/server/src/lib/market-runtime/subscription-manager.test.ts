// server/src/lib/market-runtime/subscription-manager.test.ts
// Run: npx tsx src/lib/market-runtime/subscription-manager.test.ts

import assert from 'node:assert/strict';
import { SubscriptionManager } from './subscription-manager.ts';

async function run(): Promise<void> {
    const sm = new SubscriptionManager();
    const subscribed: string[][] = [];
    const unsubscribed: string[][] = [];

    const subscribe = async (syms: string[]) => {
        subscribed.push([...syms]);
    };
    const unsubscribe = async (syms: string[]) => {
        unsubscribed.push([...syms]);
    };

    // acquire twice same consumer → one upstream subscribe
    await sm.acquire('2330', 'OPEN_GATE', subscribe);
    await sm.acquire('2330', 'OPEN_GATE', subscribe);
    assert.equal(sm.refCount('2330'), 1);
    assert.deepEqual(subscribed, [['2330']]);

    // second consumer → no new subscribe
    await sm.acquire('2330', 'INTRADAY_RANK', subscribe);
    assert.equal(sm.refCount('2330'), 2);
    assert.deepEqual(subscribed, [['2330']]);

    // B release must NOT drop while C still holds
    await sm.release('2330', 'OPEN_GATE', unsubscribe);
    assert.equal(sm.refCount('2330'), 1);
    assert.deepEqual(unsubscribed, []);
    assert.deepEqual(sm.consumersOf('2330'), ['INTRADAY_RANK']);

    // idempotent release
    await sm.release('2330', 'OPEN_GATE', unsubscribe);
    assert.equal(sm.refCount('2330'), 1);
    assert.deepEqual(unsubscribed, []);

    // last release → upstream unsubscribe once
    await sm.release('2330', 'INTRADAY_RANK', unsubscribe);
    assert.equal(sm.refCount('2330'), 0);
    assert.deepEqual(unsubscribed, [['2330']]);

    // acquireMany / releaseMany idempotent
    subscribed.length = 0;
    unsubscribed.length = 0;
    await sm.acquireMany(['2330', '2317', '2330'], 'OPEN_GATE', subscribe);
    await sm.acquireMany(['2330', '2317'], 'OPEN_GATE', subscribe);
    assert.equal(subscribed.length, 1);
    assert.deepEqual(subscribed[0]!.sort(), ['2317', '2330']);

    await sm.acquireMany(['2330'], 'INTRADAY_RANK', subscribe);
    await sm.releaseMany(['2330', '2317'], 'OPEN_GATE', unsubscribe);
    assert.equal(sm.refCount('2330'), 1);
    assert.equal(sm.refCount('2317'), 0);
    assert.deepEqual(unsubscribed, [['2317']]);

    console.log('subscription-manager.test.ts: OK');
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
