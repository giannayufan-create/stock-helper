// Outcome summary on slim signals must equal the summary on full signals.
// Run: npx tsx src/lib/signal-outcome/summary-signals.test.ts
// Optional: SUMMARY_SIGNALS_DIR=<signals dir> compares against those day files too.

import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlStrategySignalRepository } from '../strategy-signal/repository.ts';
import type { StrategySignal } from '../strategy-signal/types.ts';
import type { SignalOutcome } from './types.ts';
import { groupBySignalType, heatBuckets, scoreBucketsC } from './analytics.ts';
import { listSummarySignals } from './summary-signals.ts';

function outcomeFor(s: StrategySignal, i: number): SignalOutcome {
    const r = ((i * 37) % 11) - 5;
    return {
        signal_id: s.signal_id,
        symbol: s.symbol,
        signal_type: s.signal_type,
        signal_time: s.signal_time,
        reference_price: s.reference_price,
        status: i % 7 === 0 ? 'ambiguous' : 'complete',
        forward_return_5m: r / 2,
        forward_return_15m: r,
        forward_return_30m: r * 1.5,
        forward_return_60m: r * 2,
        mfe_15m: Math.abs(r),
        mae_15m: -Math.abs(r) / 2,
        invalid_hit: i % 5 === 0,
        hit_plus_1pct: r >= 1,
        hit_plus_2pct: r >= 2,
        hit_plus_3pct: r >= 3,
        corporate_action_crossed: i % 13 === 0,
        source_mode: s.source_mode,
        data_resolution: s.data_resolution,
    } as SignalOutcome;
}

function summarize(signals: StrategySignal[], outcomes: SignalOutcome[]) {
    const filters = [
        {},
        { high_confidence_only: true },
        { learning_eligible: true },
        { source_mode: 'live' as const, data_resolution: 'tick' as const },
        { score_min: 70, heat_min: 60 },
    ];
    return filters.map((f) => ({
        type: groupBySignalType(signals, outcomes, f),
        c: scoreBucketsC(signals, outcomes, f),
        heat: heatBuckets(signals, outcomes, f),
    }));
}

function compare(repo: JsonlStrategySignalRepository, from: string, to: string) {
    const full = repo.listRange(from, to);
    const slim = listSummarySignals(repo, from, to);
    assert.equal(slim.length, full.length);
    const outcomes = full.map(outcomeFor);
    assert.deepEqual(summarize(slim, outcomes), summarize(full, outcomes));
    for (const s of slim) {
        assert.deepEqual(s.feature_snapshot, {});
        assert.equal(s.context_snapshot, undefined);
    }
    return full.length;
}

const sample: StrategySignal[] = [];
const types = ['OPEN_PASS', 'SURGE', 'C_STRONG'] as const;
for (let i = 0; i < 60; i += 1) {
    sample.push({
        signal_id: `sig-${i}`,
        symbol: String(2300 + i),
        signal_type: types[i % 3] as StrategySignal['signal_type'],
        signal_time: `2026-10-0${1 + (i % 3)}T0${1 + (i % 4)}:00:00.000Z`,
        reference_price: 50 + i,
        reference_price_source: 'last',
        source: i % 2 ? 'C' : 'B',
        score: 55 + (i % 40),
        heat_score: i % 4 === 0 ? undefined : 50 + (i % 45),
        market_regime: i % 2 ? 'trend' : 'range',
        strategy_version: 'v1',
        config_hash: 'h',
        source_mode: i % 6 === 0 ? 'replay' : 'live',
        data_resolution: i % 6 === 0 ? '1m' : 'tick',
        score_confidence: (['high', 'medium', 'low'] as const)[i % 3],
        learning_eligible: i % 4 !== 1,
        feature_snapshot: { big: 'x'.repeat(2000) },
        context_tags: [],
    } as StrategySignal);
}

const dir = mkdtempSync(join(tmpdir(), 'summary-signals-'));
try {
    const repo = new JsonlStrategySignalRepository(dir);
    for (const s of sample) repo.save(s);
    assert.equal(compare(repo, '2026-10-01', '2026-10-03'), 60);
    assert.equal(compare(repo, '2026-10-02', '2026-10-02'), 20);
} finally {
    rmSync(dir, { recursive: true, force: true });
}

const realDir = process.env.SUMMARY_SIGNALS_DIR;
if (realDir) {
    const copy = mkdtempSync(join(tmpdir(), 'summary-signals-real-'));
    try {
        for (const f of readdirSync(realDir)) {
            if (f.endsWith('.jsonl')) copyFileSync(join(realDir, f), join(copy, f));
        }
        const repo = new JsonlStrategySignalRepository(copy);
        const n = compare(repo, '1970-01-01', '9999-12-31');
        console.log(`real signals compared: ${n}`);
        const gc = (globalThis as { gc?: () => void }).gc;
        if (gc) {
            const retainedMb = (load: () => unknown[]) => {
                gc();
                const base = process.memoryUsage().heapUsed;
                const rows = load();
                gc();
                const mb = (process.memoryUsage().heapUsed - base) / 1048576;
                assert.ok(rows.length > 0);
                return Math.round(mb * 10) / 10;
            };
            const all = ['1970-01-01', '9999-12-31'] as const;
            console.log(
                `retained heap MB: full=${retainedMb(() => repo.listRange(...all))} ` +
                    `slim=${retainedMb(() => listSummarySignals(repo, ...all))}`,
            );
        }
    } finally {
        rmSync(copy, { recursive: true, force: true });
    }
}

console.log('OK outcome summary: slim signals give identical stats');
