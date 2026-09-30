// src/lib/trigger-engine.test.ts
// Mock-only scenarios — never hits a real broker.
// Run: npx tsx src/lib/trigger-engine.test.ts

import assert from 'node:assert/strict';
import {
    TriggerEngineCore,
    type TriggerEngineDeps,
    type TriggerOrder,
} from './trigger-engine-core.ts';
import type { Trade } from './types/order.ts';
import type { ContractBase } from './types/contract.ts';

function stockContract(code = '2330'): ContractBase {
    return {
        security_type: 'STK',
        exchange: 'TSE',
        code,
    } as ContractBase;
}

function tradeOf(opts: {
    id: string;
    status: Trade['status']['status'];
    qty?: number;
    deal?: number;
    custom_field?: string;
    msg?: string;
}): Trade {
    const qty = opts.qty ?? 1;
    return {
        contract: stockContract(),
        order: {
            id: opts.id,
            seqno: 's1',
            ordno: 'o1',
            action: 'Sell',
            price: 0,
            quantity: qty,
            custom_field: opts.custom_field,
        },
        status: {
            id: opts.id,
            status: opts.status,
            status_code: '0',
            order_quantity: qty,
            deal_quantity: opts.deal ?? (opts.status === 'Filled' ? qty : 0),
            cancel_quantity: 0,
            modified_price: 0,
            msg: opts.msg ?? '',
            deals: [],
        },
    };
}

function makeDeps(overrides: Partial<TriggerEngineDeps> = {}): {
    deps: TriggerEngineDeps;
    placed: Array<{ key?: string; qty: number }>;
    notices: Array<{ title: string; body: string }>;
} {
    const placed: Array<{ key?: string; qty: number }> = [];
    const notices: Array<{ title: string; body: string }> = [];
    let now = 1_000_000;
    const deps: TriggerEngineDeps = {
        placeOrder: async (_c, _a, _p, qty, opts) => {
            placed.push({ key: opts?.clientOrderKey, qty });
            return tradeOf({
                id: `ord-${placed.length}`,
                status: 'Filled',
                qty,
                custom_field: opts?.clientOrderKey,
            });
        },
        queryTrades: async () => [],
        flattenableQty: async () => 10,
        ensureContract: async (code) => stockContract(code),
        notify: (n) => notices.push({ title: n.title, body: n.body }),
        now: () => now,
        futuresTrading: () => true,
        submitTimeoutMs: 50,
        ...overrides,
    };
    return {
        deps: {
            ...deps,
            now: () => {
                now += 1;
                return overrides.now?.() ?? now;
            },
        },
        placed,
        notices,
    };
}

function arm(
    engine: TriggerEngineCore,
    partial: Partial<TriggerOrder> &
        Pick<TriggerOrder, 'code' | 'condition' | 'price' | 'action' | 'quantity' | 'kind'>,
): TriggerOrder {
    return engine.add(partial);
}

async function testHappyPathSubmit(): Promise<void> {
    const { deps, placed } = makeDeps();
    const eng = new TriggerEngineCore(deps);
    eng.setRunning(true);
    const t = arm(eng, {
        code: '2330',
        condition: 'below',
        price: 100,
        action: 'Sell',
        quantity: 2,
        kind: 'stop',
    });
    await eng.onTick('2330', 99);
    assert.equal(placed.length, 1);
    assert.equal(placed[0]!.qty, 2);
    const after = eng.getAll().find((x) => x.id === t.id)!;
    assert.equal(after.status, 'filled');
    console.log('OK happy path submit → filled');
}

async function testExplicitRejectKeepsConfig(): Promise<void> {
    const { deps, placed } = makeDeps({
        placeOrder: async () => {
            throw new Error('券商拒絕：Insufficient buying power');
        },
    });
    const eng = new TriggerEngineCore(deps);
    eng.setRunning(true);
    const t = arm(eng, {
        code: '2330',
        condition: 'below',
        price: 100,
        action: 'Sell',
        quantity: 1,
        kind: 'stop',
    });
    await eng.onTick('2330', 99);
    await eng.onTick('2330', 98); // must NOT resubmit every tick
    await eng.onTick('2330', 97);
    assert.equal(placed.length, 0);
    const after = eng.getAll().find((x) => x.id === t.id)!;
    assert.equal(after.status, 'rejected');
    assert.ok(after.fail_reason?.includes('拒絕'));
    assert.equal(eng.getAll().length, 1, 'config retained');
    assert.equal(eng.rearm(t.id), true);
    assert.equal(eng.getAll().find((x) => x.id === t.id)!.status, 'armed');
    console.log('OK explicit reject retains config; no per-tick resubmit; rearm works');
}

async function testSubmitTimeoutLocksNoResubmit(): Promise<void> {
    let placeCalls = 0;
    const { deps } = makeDeps({
        placeOrder: async () => {
            placeCalls += 1;
            return new Promise((resolve) => {
                setTimeout(
                    () =>
                        resolve(
                            tradeOf({ id: 'late', status: 'Filled', qty: 1 }),
                        ),
                    200,
                );
            });
        },
        queryTrades: async () => [],
        submitTimeoutMs: 30,
    });
    const eng = new TriggerEngineCore(deps);
    eng.setRunning(true);
    const t = arm(eng, {
        code: '2330',
        condition: 'below',
        price: 100,
        action: 'Sell',
        quantity: 1,
        kind: 'stop',
    });
    await eng.onTick('2330', 99);
    const after = eng.getAll().find((x) => x.id === t.id)!;
    assert.equal(after.status, 'locked');
    assert.ok(after.fail_reason);
    // further ticks must not place
    await eng.onTick('2330', 90);
    assert.equal(placeCalls, 1, 'only one in-flight attempt');
    console.log('OK submit timeout → query → lock; no blind resubmit');
}

async function testConsecutiveTicksSingleFire(): Promise<void> {
    let resolvePlace!: (t: Trade) => void;
    let placeCalls = 0;
    const { deps } = makeDeps({
        placeOrder: () => {
            placeCalls += 1;
            return new Promise<Trade>((resolve) => {
                resolvePlace = resolve;
            });
        },
        submitTimeoutMs: 5_000,
    });
    const eng = new TriggerEngineCore(deps);
    eng.setRunning(true);
    arm(eng, {
        code: '2330',
        condition: 'below',
        price: 100,
        action: 'Sell',
        quantity: 1,
        kind: 'stop',
    });
    const p1 = eng.onTick('2330', 99);
    const p2 = eng.onTick('2330', 98);
    const p3 = eng.onTick('2330', 97);
    // Wait until first placeOrder is entered
    for (let i = 0; i < 50 && placeCalls === 0; i++) {
        await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(placeCalls, 1);
    assert.equal(
        eng.getAll().filter((t) => t.status === 'submitting').length,
        1,
    );
    resolvePlace!(tradeOf({ id: 'o1', status: 'Filled', qty: 1 }));
    await Promise.all([p1, p2, p3]);
    assert.equal(placeCalls, 1);
    console.log('OK consecutive ticks → single fire (re-entry guard)');
}

async function testOcoBothSidesOnlyOneSubmits(): Promise<void> {
    const { deps, placed } = makeDeps({
        placeOrder: async (_c, _a, _p, qty, opts) => {
            placed.push({ key: opts?.clientOrderKey, qty });
            await new Promise((r) => setTimeout(r, 20));
            return tradeOf({
                id: `ord-${placed.length}`,
                status: 'Filled',
                qty,
                custom_field: opts?.clientOrderKey,
            });
        },
        submitTimeoutMs: 5_000,
    });
    const eng = new TriggerEngineCore(deps);
    eng.setRunning(true);
    const stop = arm(eng, {
        code: '2330',
        condition: 'below',
        price: 100,
        action: 'Sell',
        quantity: 1,
        kind: 'stop',
        group: 'oco-1',
    });
    const take = arm(eng, {
        code: '2330',
        condition: 'above',
        price: 110,
        action: 'Sell',
        quantity: 1,
        kind: 'take',
        group: 'oco-1',
    });
    // Simultaneous: stop hits AND we'd also check take — only stop should submit.
    // Force both conditions by sequential calls at extreme prices in same turn:
    await Promise.all([eng.onTick('2330', 99), eng.onTick('2330', 111)]);
    assert.equal(placed.length, 1, 'OCO must not dual-submit');
    const stopAfter = eng.getAll().find((x) => x.id === stop.id)!;
    const takeAfter = eng.getAll().find((x) => x.id === take.id)!;
    assert.ok(
        stopAfter.status === 'filled' || stopAfter.status === 'submitting',
    );
    assert.ok(
        takeAfter.status === 'oco_suspended' ||
            takeAfter.status === 'done' ||
            takeAfter.status === 'armed',
    );
    // Protection settings still present until winner fills finalize
    assert.equal(eng.getAll().length, 2);
    console.log('OK OCO simultaneous trigger → one submit; sibling suspended not deleted');
}

async function testPartialFillStatus(): Promise<void> {
    const { deps } = makeDeps({
        placeOrder: async (_c, _a, _p, qty, opts) =>
            tradeOf({
                id: 'p1',
                status: 'PartFilled',
                qty,
                deal: Math.max(1, Math.floor(qty / 2)),
                custom_field: opts?.clientOrderKey,
            }),
    });
    const eng = new TriggerEngineCore(deps);
    eng.setRunning(true);
    const t = arm(eng, {
        code: '2330',
        condition: 'below',
        price: 100,
        action: 'Sell',
        quantity: 4,
        kind: 'stop',
    });
    await eng.onTick('2330', 99);
    assert.equal(eng.getAll().find((x) => x.id === t.id)!.status, 'partial_fill');
    console.log('OK partial fill → partial_fill status');
}

async function testResumeReconcileLocksWhenUnknown(): Promise<void> {
    const { deps } = makeDeps({
        queryTrades: async () => {
            throw new Error('offline');
        },
    });
    const eng = new TriggerEngineCore(deps, [
        {
            id: 'tg-1',
            client_order_key: 'tg-1',
            code: '2330',
            condition: 'below',
            price: 100,
            action: 'Sell',
            quantity: 1,
            kind: 'stop',
            status: 'submitting',
            created_at_ms: 1,
            submitted_at_ms: 1,
        },
    ]);
    await eng.reconcileOnResume();
    assert.equal(eng.getAll()[0]!.status, 'locked');
    console.log('OK resume reconcile query fail → locked (no resubmit)');
}

async function testFlattenableCapsQty(): Promise<void> {
    const { deps, placed } = makeDeps({
        flattenableQty: async () => 1,
    });
    const eng = new TriggerEngineCore(deps);
    eng.setRunning(true);
    arm(eng, {
        code: '2330',
        condition: 'below',
        price: 100,
        action: 'Sell',
        quantity: 5,
        kind: 'stop',
    });
    await eng.onTick('2330', 99);
    assert.equal(placed[0]!.qty, 1);
    console.log('OK flattenable qty caps order (no reverse oversize)');
}

async function testZeroPositionRejects(): Promise<void> {
    const { deps, placed } = makeDeps({
        flattenableQty: async () => 0,
    });
    const eng = new TriggerEngineCore(deps);
    eng.setRunning(true);
    const t = arm(eng, {
        code: '2330',
        condition: 'below',
        price: 100,
        action: 'Sell',
        quantity: 1,
        kind: 'stop',
    });
    await eng.onTick('2330', 99);
    assert.equal(placed.length, 0);
    assert.equal(eng.getAll().find((x) => x.id === t.id)!.status, 'rejected');
    console.log('OK zero position → reject without order');
}

async function testOcoRejectRestoresSibling(): Promise<void> {
    const { deps } = makeDeps({
        placeOrder: async () => {
            throw new Error('明確拒絕：帳號鎖定');
        },
    });
    const eng = new TriggerEngineCore(deps);
    eng.setRunning(true);
    const stop = arm(eng, {
        code: '2330',
        condition: 'below',
        price: 100,
        action: 'Sell',
        quantity: 1,
        kind: 'stop',
        group: 'oco-r',
    });
    const take = arm(eng, {
        code: '2330',
        condition: 'above',
        price: 110,
        action: 'Sell',
        quantity: 1,
        kind: 'take',
        group: 'oco-r',
    });
    await eng.onTick('2330', 99);
    assert.equal(eng.getAll().find((x) => x.id === stop.id)!.status, 'rejected');
    assert.equal(eng.getAll().find((x) => x.id === take.id)!.status, 'armed');
    console.log('OK OCO reject restores sibling to armed');
}

async function main(): Promise<void> {
    await testHappyPathSubmit();
    await testExplicitRejectKeepsConfig();
    await testSubmitTimeoutLocksNoResubmit();
    await testConsecutiveTicksSingleFire();
    await testOcoBothSidesOnlyOneSubmits();
    await testPartialFillStatus();
    await testResumeReconcileLocksWhenUnknown();
    await testFlattenableCapsQty();
    await testZeroPositionRejects();
    await testOcoRejectRestoresSibling();
    console.log('\nAll trigger-engine tests passed');
}

void main();
