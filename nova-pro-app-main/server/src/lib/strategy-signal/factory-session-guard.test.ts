// server/src/lib/strategy-signal/factory-session-guard.test.ts
// Run: npx tsx src/lib/strategy-signal/factory-session-guard.test.ts

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenConfirmResult } from '../open-gate-v2/types.ts';
import { MemoryStrategySignalRepository } from '../research-persistence/memory-signal-repository.ts';
import { StrategySignalFactory, type SignalContext } from './factory.ts';
import { SignalLifecycleManager } from './lifecycle.ts';
import { RawSignalStore } from './raw-signal-store.ts';

let passed = 0;
function pass(name: string) {
    passed++;
    console.log(`PASS ${name}`);
}

function openPass(symbol: string, iso: string): OpenConfirmResult {
    return {
        symbol,
        name: symbol,
        timestamp: iso,
        generated_at: iso,
        tradeable_candidate: true,
        signal_expired: false,
        open_confirm: 'pass',
        final_open_score: 82,
        a_score: 70,
        raw_open_score: 80,
        market_adjustment: 0,
        liquidity_adjustment: 0,
        risk_adjustment: 0,
        phase: 'confirmed',
        liquidity_score: 70,
        market_regime: 'bull',
        data_health: 'healthy',
        evaluation_id: `ev_${symbol}`,
        metrics: {
            gap_pct: 1,
            rvol_same_time: 1.5,
            vwap_pos_pct: 0.5,
            open_pos_pct: 0.5,
            high_pullback_pct: 0.2,
            momentum_score: 70,
        },
        risk: { chase_risk: 'low', invalid_price: 99, invalid_reason: 'x' },
    } as unknown as OpenConfirmResult;
}

function ctx(mode: SignalContext['source_mode']): SignalContext {
    return {
        source_mode: mode,
        data_resolution: mode === 'live' ? 'tick' : '1m',
        learning_eligible: true,
        config_hash: 'cfg_guard',
    };
}

const dir = mkdtempSync(join(tmpdir(), 'sig-guard-'));
try {
    const repo = new MemoryStrategySignalRepository();
    const raw = new RawSignalStore(dir);
    const factory = new StrategySignalFactory(
        repo,
        new SignalLifecycleManager(),
        raw,
    );

    // Thu 2026-10-01 10:00 Taipei — inside cash session
    const inSession = factory.maybeCreateFromB(
        null,
        openPass('2330', '2026-10-01T02:00:00.000Z'),
        ctx('live'),
        100,
    );
    assert.ok(inSession, 'live signal inside session is recorded');
    assert.ok(repo.findById(inSession!.signal_id));
    assert.equal(inSession!.metadata?.writer_service, 'local');
    assert.equal(
        raw.findById(inSession!.signal_id)?.trigger_conditions.writer_service,
        'local',
    );
    pass('live_in_session_recorded_with_writer');

    // Thu 2026-10-01 19:55 Taipei — after close
    const afterHours = factory.maybeCreateFromB(
        null,
        openPass('2317', '2026-10-01T11:55:00.000Z'),
        ctx('live'),
        100,
    );
    assert.equal(afterHours, null);
    pass('live_after_close_dropped');

    // Sat 2026-10-03 10:00 Taipei — weekend
    const weekend = factory.maybeCreateFromB(
        null,
        openPass('2454', '2026-10-03T02:00:00.000Z'),
        ctx('live'),
        100,
    );
    assert.equal(weekend, null);
    pass('live_weekend_dropped');

    // Replay keeps historical timestamps and is not session-gated
    const replay = factory.maybeCreateFromB(
        null,
        openPass('2603', '2026-10-01T11:55:00.000Z'),
        ctx('replay'),
        100,
    );
    assert.ok(replay, 'replay is not session-gated');
    pass('replay_not_gated');

    assert.equal(repo.listRange('2026-09-01', '2026-12-31').length, 2);
    pass('only_two_persisted');

    console.log(`\nOK ${passed} tests`);
} finally {
    rmSync(dir, { recursive: true, force: true });
}
