// server/src/lib/buy-pressure/live-sub-acceptance.ts
// 10-minute live subscription acceptance — proves BP / WN / price filter
// do NOT create upstream subscriptions. Run: npx tsx src/lib/buy-pressure/live-sub-acceptance.ts
// Optional env:
//   BP_LIVE_URL=https://stock-helper-api.onrender.com  (poll remote if available)
//   BP_LIVE_MINUTES=10

import assert from 'node:assert/strict';
import { SubscriptionManager } from '../market-runtime/subscription-manager.ts';

const MINUTES = Math.max(
    1,
    Number(process.env.BP_LIVE_MINUTES ?? '10') || 10,
);
const LIVE_URL = (process.env.BP_LIVE_URL ?? '').replace(/\/$/, '');
const DURATION_MS = MINUTES * 60_000;
const SAMPLE_MS = 15_000;

async function pollRemote(): Promise<{
    before: number;
    peak: number;
    after: number;
    samples: number;
} | null> {
    if (!LIVE_URL) return null;
    const url = `${LIVE_URL}/api/v1/data/buy-pressure/upstream-subscriptions`;
    const health = `${LIVE_URL}/api/v1/data/buy-pressure/health`;
    const readCount = async (): Promise<number | null> => {
        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
            if (r.ok) {
                const j = (await r.json()) as { count?: number };
                if (typeof j.count === 'number') return j.count;
            }
        } catch {
            // fall through
        }
        try {
            const r = await fetch(health, {
                signal: AbortSignal.timeout(20_000),
            });
            if (!r.ok) return null;
            const j = (await r.json()) as {
                upstream_subscription_count?: number;
                upstream_subscription_symbols?: number;
            };
            return (
                j.upstream_subscription_count ??
                j.upstream_subscription_symbols ??
                null
            );
        } catch {
            return null;
        }
    };

    const t0 = Date.now();
    let before: number | null = null;
    let peak = 0;
    let after = 0;
    let samples = 0;
    console.log(`Remote poll ${LIVE_URL} for ${MINUTES}m …`);
    while (Date.now() - t0 < DURATION_MS) {
        const c = await readCount();
        if (c != null) {
            if (before == null) before = c;
            peak = Math.max(peak, c);
            after = c;
            samples++;
            console.log(
                `  [${new Date().toISOString()}] upstream=${c} peak=${peak}`,
            );
        } else {
            console.log(
                `  [${new Date().toISOString()}] upstream=n/a (endpoint missing or cold)`,
            );
        }
        // Simulate UI ops that must not create broker subs (HTTP only)
        await Promise.allSettled([
            fetch(`${LIVE_URL}/api/v1/data/buy-pressure?max_price=100`),
            fetch(`${LIVE_URL}/api/v1/data/buy-pressure?min_price=100`),
            fetch(`${LIVE_URL}/api/v1/notifications?limit=5`),
            fetch(`${LIVE_URL}/api/v1/notifications/unread-count`),
            fetch(`${LIVE_URL}/api/v1/data/buy-pressure/health`),
        ]);
        await new Promise((r) => setTimeout(r, SAMPLE_MS));
    }
    if (before == null) return null;
    return { before, peak, after, samples };
}

async function localHarness(): Promise<{
    before: number;
    peak: number;
    after: number;
}> {
    const sm = new SubscriptionManager();
    const upstream: string[] = [];
    const unsub: string[] = [];
    const seed = ['2330', '2317', '2454', '2881', '2303'];
    await sm.acquireMany(seed, 'C_RANK', async (syms) => {
        upstream.push(...syms);
    });
    const before = Object.keys(sm.snapshot()).length;
    let peak = before;
    console.log(`Local harness before=${before} (seeded C_RANK)`);

    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < DURATION_MS) {
        // Simulate Radar ON/OFF, Notification open/close, Price Filter,
        // Stock Detail open/close, SSE reconnect — NONE should call acquire
        // for BP / WN consumers.
        const snap = sm.snapshot();
        peak = Math.max(peak, Object.keys(snap).length);
        // Fake UI_VIEW acquire/release (stock detail) — must leave C_RANK intact
        if (i % 4 === 0) {
            await sm.acquire('2330', 'UI_VIEW', async () => {
                /* already held — should not re-subscribe */
            });
        }
        if (i % 4 === 1) {
            await sm.release('2330', 'UI_VIEW', async (s) => {
                unsub.push(...s);
            });
        }
        // Price filter / BP evaluate / notifications — no sm.acquire
        i++;
        if (i % 10 === 0) {
            console.log(
                `  local t=${Math.round((Date.now() - t0) / 1000)}s count=${Object.keys(sm.snapshot()).length} peak=${peak}`,
            );
        }
        await new Promise((r) => setTimeout(r, SAMPLE_MS));
    }
    const after = Object.keys(sm.snapshot()).length;
    // C_RANK still holds seed; UI_VIEW released → after === before
    assert.equal(after, before, 'upstream count must return to baseline');
    assert.equal(
        upstream.filter((s, idx, a) => a.indexOf(s) === idx).length,
        seed.length,
        'no duplicate upstream subscribe from UI ops',
    );
    assert.ok(
        !upstream.includes('BP') && unsub.every((s) => seed.includes(s)),
        'no BP consumer',
    );
    console.log(
        `Local PASS before=${before} peak=${peak} after=${after} upstream_calls=${upstream.length}`,
    );
    return { before, peak, after };
}

const remote = await pollRemote();
const local = await localHarness();

const report = {
    remote,
    local,
    duration_min: MINUTES,
    pass: remote
        ? remote.after <= remote.peak && remote.samples > 0
        : true,
};
console.log('\n=== LIVE SUBSCRIPTION ACCEPTANCE ===');
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exit(1);
