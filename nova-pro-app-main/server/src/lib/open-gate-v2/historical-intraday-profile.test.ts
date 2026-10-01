// server/src/lib/open-gate-v2/historical-intraday-profile.test.ts
// Run: npx tsx src/lib/open-gate-v2/historical-intraday-profile.test.ts

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MarketManager } from '../../providers/manager.ts';
import { loadOpenGateConfig } from './config.ts';
import { HistoricalProfileCache } from './historical-intraday-profile.ts';

const END = '2026-10-05';

function fakeMarket(emptyFor: Set<string> = new Set()): {
    market: MarketManager;
    calls: string[];
} {
    const calls: string[] = [];
    const market = {
        async kbars(contract: { code: string }) {
            calls.push(contract.code);
            const datetime: string[] = [];
            const Volume: number[] = [];
            if (!emptyFor.has(contract.code)) {
                for (const day of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']) {
                    for (let m = 0; m < 60; m++) {
                        const hh = String(9 + Math.floor(m / 60)).padStart(2, '0');
                        const mm = String(m % 60).padStart(2, '0');
                        datetime.push(`${day} ${hh}:${mm}:00`);
                        Volume.push(100);
                    }
                }
            }
            return { datetime, Volume };
        },
    } as unknown as MarketManager;
    return { market, calls };
}

async function testLoadsEachSymbolOncePerDay(): Promise<void> {
    const cfg = loadOpenGateConfig();
    const { market, calls } = fakeMarket();
    const cache = new HistoricalProfileCache(market, cfg);
    await cache.preload(['2330', '2317'], { asOfExclusiveYmd: END });
    await cache.preload(['2330', '2317', '2454'], { asOfExclusiveYmd: END });
    await cache.preload(['2330'], { asOfExclusiveYmd: END });
    assert.deepEqual(calls.sort(), ['2317', '2330', '2454']);
    assert.equal(cache.isReady(), true);
    assert.ok(cache.getCurve('2330'));
}

async function testConcurrentPreloadDedupes(): Promise<void> {
    const cfg = loadOpenGateConfig();
    const { market, calls } = fakeMarket();
    const cache = new HistoricalProfileCache(market, cfg);
    await Promise.all([
        cache.preload(['2330', '2317'], { asOfExclusiveYmd: END }),
        cache.preload(['2330', '2317'], { asOfExclusiveYmd: END }),
    ]);
    assert.equal(calls.length, 2);
}

async function testMissRetriesAfterWindow(): Promise<void> {
    const cfg = loadOpenGateConfig();
    const { market, calls } = fakeMarket(new Set(['9999']));
    let now = 1_000_000;
    const cache = new HistoricalProfileCache(market, cfg, { nowMs: () => now });
    await cache.preload(['9999'], { asOfExclusiveYmd: END });
    await cache.preload(['9999'], { asOfExclusiveYmd: END });
    assert.equal(calls.length, 1, 'empty kbars not retried immediately');
    assert.equal(cache.isReady(), false);
    now += 31 * 60 * 1000;
    await cache.preload(['9999'], { asOfExclusiveYmd: END });
    assert.equal(calls.length, 2, 'retried after miss window');
}

async function testNewDayRefetches(): Promise<void> {
    const cfg = loadOpenGateConfig();
    const { market, calls } = fakeMarket();
    const cache = new HistoricalProfileCache(market, cfg);
    await cache.preload(['2330'], { asOfExclusiveYmd: END });
    await cache.preload(['2330'], { asOfExclusiveYmd: '2026-10-06' });
    assert.equal(calls.length, 2);
}

async function testDiskCacheSurvivesRestart(): Promise<void> {
    const cfg = loadOpenGateConfig();
    const dir = mkdtempSync(join(tmpdir(), 'hp-'));
    try {
        const first = fakeMarket();
        const a = new HistoricalProfileCache(first.market, cfg, { cacheDir: dir });
        await a.preload(['2330', '2317'], { asOfExclusiveYmd: END });
        assert.equal(first.calls.length, 2);
        assert.ok(existsSync(join(dir, `${END}.json`)));

        const second = fakeMarket();
        const b = new HistoricalProfileCache(second.market, cfg, { cacheDir: dir });
        await b.preload(['2330', '2317'], { asOfExclusiveYmd: END });
        assert.equal(second.calls.length, 0, 'restored from disk, no refetch');
        assert.equal(b.isReady(), true);
        assert.equal(
            b.rvolSameTime('2330', 1000, 5),
            a.rvolSameTime('2330', 1000, 5),
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

async function testInjectedCurveSurvivesFirstPreload(): Promise<void> {
    const cfg = loadOpenGateConfig();
    const { market } = fakeMarket(new Set(['2330']));
    const cache = new HistoricalProfileCache(market, cfg);
    const byMinute = new Map<number, number>();
    for (let m = 0; m <= 30; m++) byMinute.set(m, 1000 * (m + 1));
    cache.injectCurve('2330', byMinute, 20);
    await cache.preload(['2330'], { asOfExclusiveYmd: END });
    assert.equal(cache.isReady(), true);
}

async function main(): Promise<void> {
    await testLoadsEachSymbolOncePerDay();
    await testConcurrentPreloadDedupes();
    await testMissRetriesAfterWindow();
    await testNewDayRefetches();
    await testDiskCacheSurvivesRestart();
    await testInjectedCurveSurvivesFirstPreload();
    console.log('historical-intraday-profile tests: OK');
}

void main().catch((err) => {
    console.error(err);
    process.exit(1);
});
