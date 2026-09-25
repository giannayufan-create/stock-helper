// server/src/lib/historical-replay/replay.test.ts
// Run: npx tsx src/lib/historical-replay/replay.test.ts

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockMarketDataProvider } from '../../providers/mock/market.ts';
import { MarketManager } from '../../providers/manager.ts';
import { loadOpenGateConfig } from '../open-gate-v2/config.ts';
import { resolvePhase } from '../open-gate-v2/open-gate-evaluator.ts';
import { HistoricalProfileCache } from '../open-gate-v2/historical-intraday-profile.ts';
import {
    buildSyntheticDayBars,
    learningEligible,
    parseBarTs,
    resolveBarTimeWindow,
    runHistoricalReplay,
    stableSnapshot,
} from './index.ts';
import { ReplayClock } from './replay-clock.ts';
import { EarlyDailyReportStore } from '../radar-rescue/early-daily-report.ts';

async function mockMarket(): Promise<MarketManager> {
    const manager = new MarketManager();
    const mock = new MockMarketDataProvider();
    await mock.init();
    manager.start(mock, 'mock');
    return manager;
}

function tempDirs(): {
    signalsDir: string;
    outcomesDir: string;
    earlyReportsDir: string;
    cleanup: () => void;
} {
    const signalsDir = mkdtempSync(join(tmpdir(), 'rp-sig-'));
    const outcomesDir = mkdtempSync(join(tmpdir(), 'rp-out-'));
    const earlyReportsDir = mkdtempSync(join(tmpdir(), 'rp-early-'));
    return {
        signalsDir,
        outcomesDir,
        earlyReportsDir,
        cleanup: () => {
            rmSync(signalsDir, { recursive: true, force: true });
            rmSync(outcomesDir, { recursive: true, force: true });
            rmSync(earlyReportsDir, { recursive: true, force: true });
        },
    };
}

function at(date: string, hhmm: string): Date {
    return new Date(parseBarTs(`${date} ${hhmm}:00`));
}

async function testBarKnownAt(): Promise<void> {
    const label = parseBarTs('2026-06-15 09:00:00');
    const win = resolveBarTimeWindow(label, 'bar_start');
    assert.equal(win.bar_start, label);
    assert.equal(win.bar_end, label + 60_000);
    assert.equal(win.known_at, label + 60_000);
    // Must NOT evaluate at bar_start with full OHLC
    assert.notEqual(win.known_at, win.bar_start);
    console.log('OK bar known_at semantics');
}

async function testReplayClockPhases(): Promise<void> {
    const date = '2026-06-15';
    const cfg = loadOpenGateConfig();
    const clock = new ReplayClock({
        startTime: at(date, '09:00'),
        endTime: at(date, '13:30'),
    });

    const check = (hhmm: string, expect: string) => {
        clock.setCurrent(at(date, hhmm));
        const { phase } = resolvePhase(cfg, clock.now());
        assert.equal(phase, expect, `${hhmm} → ${expect}, got ${phase}`);
    };

    check('09:02', 'provisional');
    check('09:06', 'early');
    check('09:15', 'confirmed');
    check('10:30', 'after');
    console.log('OK ReplayClock phases');
}

async function testAtomicBatchDeterministic(): Promise<void> {
    const market = await mockMarket();
    const d1 = tempDirs();
    const d2 = tempDirs();
    try {
        const r1 = await runHistoricalReplay({
            date: '2026-06-15',
            symbols: ['2330', '2317', '2367'],
            synthetic: true,
            market,
            until: '10:15',
            speed: 'max',
            universe_source: 'synthetic',
            signalsDir: d1.signalsDir,
            outcomesDir: d1.outcomesDir,
        });
        const r2 = await runHistoricalReplay({
            date: '2026-06-15',
            symbols: ['2367', '2330', '2317'],
            synthetic: true,
            market,
            until: '10:15',
            speed: 'max',
            universe_source: 'synthetic',
            signalsDir: d2.signalsDir,
            outcomesDir: d2.outcomesDir,
        });
        assert.equal(stableSnapshot(r1), stableSnapshot(r2));
        assert.equal(r1.learning_eligible, false);
        assert.ok(r1.timeline[0]!.known_at.startsWith('09:01'));
        console.log('OK atomic batch + symbol-order independent');
    } finally {
        d1.cleanup();
        d2.cleanup();
    }
}

async function testSpeedInvariant(): Promise<void> {
    const market = await mockMarket();
    const d1 = tempDirs();
    const d2 = tempDirs();
    try {
        const a = await runHistoricalReplay({
            date: '2026-06-15',
            symbols: ['2330', '2317'],
            synthetic: true,
            market,
            until: '09:20',
            speed: 'max',
            signalsDir: d1.signalsDir,
            outcomesDir: d1.outcomesDir,
        });
        const b = await runHistoricalReplay({
            date: '2026-06-15',
            symbols: ['2330', '2317'],
            synthetic: true,
            market,
            until: '09:20',
            speed: 1000,
            signalsDir: d2.signalsDir,
            outcomesDir: d2.outcomesDir,
        });
        assert.equal(stableSnapshot(a), stableSnapshot(b));
        console.log('OK speed invariant');
    } finally {
        d1.cleanup();
        d2.cleanup();
    }
}

async function testNoFutureLeak(): Promise<void> {
    const date = '2026-06-15';
    const base = buildSyntheticDayBars({
        symbol: '2330',
        date,
        startPrice: 100,
        withAmount: true,
    });
    const mutated = buildSyntheticDayBars({
        symbol: '2330',
        date,
        startPrice: 100,
        withAmount: true,
        mutateAfter: (sm, close) => (sm > 75 ? close * 1.5 : close),
    });
    // 10:15 bar known_at = 10:16
    const cut = parseBarTs(`${date} 10:15:00`) + 60_000;
    const b1 = base.bars.filter((b) => b.known_at <= cut);
    const b2 = mutated.bars.filter((b) => b.known_at <= cut);
    assert.equal(b1.length, b2.length);
    for (let i = 0; i < b1.length; i++) {
        assert.equal(b1[i]!.close, b2[i]!.close);
    }
    console.log('OK no-future-leak bar prefix @ known_at');
}

async function testRvolPit(): Promise<void> {
    const cfg = loadOpenGateConfig();
    const market = await mockMarket();
    const cache = new HistoricalProfileCache(market, cfg);
    const byMinute = new Map<number, number>();
    for (let m = 0; m <= 270; m++) byMinute.set(m, 5000 * (m + 1));
    cache.injectCurve('2330', byMinute, 20);
    const rvol1 = cache.rvolSameTime('2330', 50_000, 75);
    const cache2 = new HistoricalProfileCache(market, cfg);
    cache2.injectCurve('2330', new Map(byMinute), 20);
    assert.equal(rvol1, cache2.rvolSameTime('2330', 50_000, 75));
    console.log('OK same-time RVOL PIT contract');
}

async function testLearningEligible(): Promise<void> {
    assert.equal(learningEligible('synthetic', true), false);
    assert.equal(learningEligible('manual_test', false), false);
    assert.equal(learningEligible('historical_A', false), true);
    assert.equal(learningEligible('historical_universe', false), true);
    console.log('OK learning_eligible gates');
}

async function testNoTradeVsMissing(): Promise<void> {
    const day = buildSyntheticDayBars({
        symbol: '2330',
        date: '2026-06-15',
        startPrice: 100,
        noTradeMinutes: [30, 31, 32],
        withAmount: true,
    });
    assert.ok(day.no_trade_count >= 3);
    assert.equal(day.data_missing_count, 0);
    console.log('OK NO_TRADE vs DATA_MISSING');
}

async function testFullDay(): Promise<void> {
    const market = await mockMarket();
    const d = tempDirs();
    try {
        const report = await runHistoricalReplay({
            date: '2026-06-15',
            symbols: ['2367', '2330', '2317'],
            synthetic: true,
            market,
            speed: 'max',
            ...d,
        });
        assert.equal(report.status, 'completed');
        assert.equal(report.learning_eligible, false);
        assert.ok(report.timeline.length > 100);
        assert.ok(report.signals);
        assert.ok(report.outcomes);
        const phases = new Set(report.timeline.map((t) => t.phase));
        assert.ok(phases.has('provisional'));
        assert.ok(phases.has('after'));
        console.log(
            `OK full-day meanCoverage=${report.feature_coverage_pct}% signals=${report.signals.total}`,
        );
    } finally {
        d.cleanup();
    }
}

async function testFullThenPartialEarlyReport(): Promise<void> {
    const market = await mockMarket();
    const earlyReportsDir = mkdtempSync(join(tmpdir(), 'rp-early-'));
    const dFull = tempDirs();
    const dPart = tempDirs();
    try {
        const full = await runHistoricalReplay({
            date: '2026-06-15',
            symbols: ['2330', '2317'],
            synthetic: true,
            market,
            speed: 'max',
            universe_source: 'synthetic',
            signalsDir: dFull.signalsDir,
            outcomesDir: dFull.outcomesDir,
            earlyReportsDir,
        });
        const partial = await runHistoricalReplay({
            date: '2026-06-15',
            symbols: ['2330'],
            synthetic: true,
            market,
            until: '10:15',
            speed: 'max',
            universe_source: 'synthetic',
            signalsDir: dPart.signalsDir,
            outcomesDir: dPart.outcomesDir,
            earlyReportsDir,
        });
        assert.notEqual(full.replay_run_id, partial.replay_run_id);

        const store = new EarlyDailyReportStore(earlyReportsDir);
        const api = store.listForApi('2026-06-15');
        assert.ok(
            api.reports.some((r) => r.run_id === full.replay_run_id),
            'full report still listed after partial',
        );
        assert.ok(
            api.partial_reports.some((r) => r.run_id === partial.replay_run_id),
            'partial report stored separately',
        );
        const stillFull = store.loadByRun(
            '2026-06-15',
            'synthetic',
            'full',
            full.replay_run_id,
        );
        assert.ok(stillFull);
        assert.equal(stillFull!.coverage, 'full');
        assert.equal(stillFull!.evaluable, true);
        assert.deepEqual(stillFull!.symbols, ['2317', '2330']);

        const part = store.loadByRun(
            '2026-06-15',
            'synthetic',
            'partial',
            partial.replay_run_id,
        );
        assert.ok(part);
        assert.equal(part!.coverage, 'partial');
        assert.equal(part!.until_label, '10:15');
        assert.ok(!api.sources.includes('live'));
        assert.equal(api.live_pipeline.wired, false);

        console.log(
            `OK full+partial early reports preserved full=${full.replay_run_id} partial=${partial.replay_run_id}`,
        );
    } finally {
        dFull.cleanup();
        dPart.cleanup();
        rmSync(earlyReportsDir, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    await testBarKnownAt();
    await testReplayClockPhases();
    await testAtomicBatchDeterministic();
    await testSpeedInvariant();
    await testNoFutureLeak();
    await testRvolPit();
    await testLearningEligible();
    await testNoTradeVsMissing();
    await testFullDay();
    await testFullThenPartialEarlyReport();
    console.log('\nAll replay fairness tests passed.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
