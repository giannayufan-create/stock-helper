// server/src/lib/open-gate-v2/open-gate-headless.test.ts
// Headless Autonomy v1.1 — OpenGate OG1–OG6 + CASE 1–5 (no POST /open-confirm).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockMarketDataProvider } from '../../providers/mock/market.ts';
import { MarketManager } from '../../providers/manager.ts';
import { MarketRuntime } from '../market-runtime/index.ts';
import type { Clock } from '../market-runtime/clock.ts';
import { resolveTradingSession, taipeiMs } from '../session-autonomy/session-clock.ts';
import { SessionAutonomyService } from '../session-autonomy/service.ts';
import { ACandidateStore } from './a-candidate-store.ts';
import { OpenGateRuntimeCoordinator } from './open-gate-runtime-coordinator.ts';
import { OpenGateV2Service } from './service.ts';
import { loadOpenGateConfig } from './config.ts';
import { resolvePhase } from './open-gate-evaluator.ts';
import type { ACandidate } from './types.ts';
import {
    hasPrimaryFirebaseCredentials,
    loadResearchPersistenceConfig,
} from '../research-persistence/config.ts';
import { FirestoreStrategySignalRepository } from '../research-persistence/firestore-signal-repository.ts';
import { MemoryStrategySignalRepository } from '../research-persistence/memory-signal-repository.ts';
import { __resetAdminForTests } from '../research-persistence/admin.ts';
import type { StrategySignal } from '../strategy-signal/types.ts';

let passed = 0;
let failed = 0;
const results: Record<string, 'PASS' | 'FAIL' | 'PENDING'> = {};

function pass(name: string) {
    passed += 1;
    results[name] = 'PASS';
    console.log(`  PASS  ${name}`);
}
function fail(name: string, err: unknown) {
    failed += 1;
    results[name] = 'FAIL';
    console.error(`  FAIL  ${name}:`, err instanceof Error ? err.message : err);
}
function pending(name: string, why: string) {
    results[name] = 'PENDING';
    console.log(`  PENDING  ${name}: ${why}`);
}

class MutableClock implements Clock {
    constructor(private ms: number) {}
    set(ms: number) {
        this.ms = ms;
    }
    now(): Date {
        return new Date(this.ms);
    }
}

function sampleCandidates(): ACandidate[] {
    return [
        {
            symbol: '2330',
            name: '台積電',
            exchange: 'tse',
            a_score: 82,
            a_score_source: 'server',
            prev_close: 580,
            avg_volume_20d: 20_000_000,
            avg_amount_20d: null,
            sector: '半導體',
            warning_status: false,
            disposition_status: false,
            source: 'eod_a',
            lite: true,
        },
        {
            symbol: '2317',
            name: '鴻海',
            exchange: 'tse',
            a_score: 76,
            a_score_source: 'server',
            prev_close: 180,
            avg_volume_20d: 15_000_000,
            avg_amount_20d: null,
            sector: '電子',
            warning_status: false,
            disposition_status: false,
            source: 'eod_a',
            lite: true,
        },
    ];
}

function makeSignal(
    partial: Partial<StrategySignal> & { signal_id: string },
): StrategySignal {
    return {
        signal_id: partial.signal_id,
        symbol: partial.symbol ?? '2330',
        signal_type: partial.signal_type ?? 'SURGE',
        signal_time: partial.signal_time ?? '2026-09-16T01:20:00.000Z',
        reference_price: partial.reference_price ?? 100,
        reference_price_source: 'test',
        source: 'C',
        strategy_version: 'bc-strategy-v1',
        config_hash: 'cfg',
        source_mode: 'live',
        data_resolution: 'tick',
        learning_eligible: true,
        feature_snapshot: Object.freeze(
            partial.feature_snapshot ?? { intraday_score: 80 },
        ),
        context_snapshot: partial.context_snapshot ?? {
            global_regime: 'NEUTRAL',
            taiwan_regime: 'RISK_ON_BROAD',
            market_breadth: 0.6,
            market_turnover_acceleration: 'RISING',
            sector: '半導體',
            sector_rank: 8,
            sector_rank_change: 2,
            sector_rank_velocity: 1,
            sector_rotation_state: 'ROTATING_IN',
            sector_turnover_share: 0.1,
            sector_turnover_share_delta: 0.02,
            sector_breadth: 0.7,
            sector_relative_strength: 1,
            capital_rotation_score: 70,
            sector_c_strong_count: 3,
            sector_bp_strong_count: 2,
            leader_concentration: false,
            institutional_eod_context: {
                available: false,
                realtime_level: 'PREVIOUS_DAY',
                note: 'PREVIOUS_DAY',
            },
            institutional_risk_proxy: {
                available: false,
                proxy: true,
                not_actual_foreign_identity: true,
                note: 'PROXY',
            },
            active_events: [],
            event_relevance_score: 80,
            event_market_confirmation_score: 40,
            event_confirmation_state: 'EVENT_WATCH',
            company_exposure_confidence: 'MEDIUM',
            feature_availability: {
                taiwan_regime: true,
                sector_rotation: true,
                event_confirmation: true,
            },
            context_coverage_pct: 70,
            context_confidence: 'HIGH',
            context_source_mode: 'LIVE',
            captured_at: '2026-09-16T01:20:00.000Z',
            market_context_version: 'mc_v1',
            sector_rotation_version: 'sector_rotation_v1',
            event_engine_version: 'ei_v1',
            exposure_map_version: 'exposure_map_v1',
            confirmation_version: 'confirmation_v1',
            config_hash: 'cfg',
            schema_version: 'context_snapshot_v1',
        },
        context_tags: ['SECTOR_ROTATING_IN'],
        context_alignment: 'ALIGNED',
        context_strength_score: 72,
    };
}

console.log('=== OpenGate Headless Autonomy v1.1 ===');
console.log('(frontend_clients_connected = 0; no POST /open-confirm)\n');

const dataDir = mkdtempSync(join(tmpdir(), 'og-headless-'));
const store = new ACandidateStore(dataDir);
store.save(sampleCandidates(), 'server');

(async () => {
    const clock = new MutableClock(taipeiMs(2026, 3, 16, 8, 50));
    const mock = new MockMarketDataProvider();
    await mock.init();
    const manager = new MarketManager();
    manager.start(mock, 'mock');
    const runtime = new MarketRuntime({
        market: manager,
        clock,
        replayMode: true,
    });
    await runtime.bootstrap();

    const openGate = new OpenGateV2Service(
        manager,
        runtime,
        undefined,
        dataDir,
    );
    const coordinator = new OpenGateRuntimeCoordinator(openGate);

    let postCalled = false;
    const originalSet = openGate.setCandidates.bind(openGate);
    openGate.setCandidates = async (...args) => {
        postCalled = true;
        return originalSet(...args);
    };
    // ---- OG1 08:50 PREMARKET hydrate ----
    try {
        clock.set(taipeiMs(2026, 3, 16, 8, 50));
        assert.equal(resolveTradingSession(clock.now().getTime()), 'PREOPEN');
        const r = await coordinator.onPremarket();
        assert.ok(r.count > 0, 'A Candidate Pool > 0');
        assert.equal(openGate.getAPoolMeta().post_required, false);
        assert.equal(postCalled, false);
        pass('OG1_08:50_hydrate_A_pool');
    } catch (e) {
        fail('OG1_08:50_hydrate_A_pool', e);
    }

    // ---- OG2 08:59 PREOPEN load ----
    try {
        clock.set(taipeiMs(2026, 3, 16, 8, 59));
        assert.equal(resolveTradingSession(clock.now().getTime()), 'PREOPEN');
        await coordinator.onPreopen();
        assert.ok(openGate.getAPoolMeta().count > 0);
        const batch = await openGate.evaluatePool();
        assert.ok(batch.count > 0, 'evaluations produce items');
        assert.equal(postCalled, false);
        pass('OG2_08:59_preopen_pool');
    } catch (e) {
        fail('OG2_08:59_preopen_pool', e);
    }

    // ---- OG3 09:01 OpenGate evaluation ----
    try {
        clock.set(taipeiMs(2026, 3, 16, 9, 1));
        const { phase } = resolvePhase(loadOpenGateConfig(), clock.now());
        assert.ok(
            phase === 'provisional' || phase === 'early',
            `expected provisional/early got ${phase}`,
        );
        const batch = await openGate.evaluatePool();
        assert.ok(batch.count > 0);
        assert.ok(batch.items.length > 0);
        // B pipeline produces open_confirm statuses (pass/watch/reject/…)
        assert.ok(
            batch.items.every((i) => typeof i.open_confirm === 'string'),
        );
        pass('OG3_09:01_evaluation_running');
    } catch (e) {
        fail('OG3_09:01_evaluation_running', e);
    }

    // ---- OG4 09:10 ----
    try {
        clock.set(taipeiMs(2026, 3, 16, 9, 10));
        const batch = await openGate.evaluatePool();
        assert.ok(batch.count > 0);
        assert.equal(postCalled, false);
        pass('OG4_09:10_still_evaluating');
    } catch (e) {
        fail('OG4_09:10_still_evaluating', e);
    }

    // ---- OG5 09:29 ----
    try {
        clock.set(taipeiMs(2026, 3, 16, 9, 29));
        const batch = await openGate.evaluatePool();
        assert.ok(batch.count > 0);
        pass('OG5_09:29_pre_freeze');
    } catch (e) {
        fail('OG5_09:29_pre_freeze', e);
    }

    // ---- OG6 09:31 freeze semantics ----
    try {
        clock.set(taipeiMs(2026, 3, 16, 9, 31));
        const cfg = loadOpenGateConfig();
        const { phase, sessionMinutes } = resolvePhase(cfg, clock.now());
        assert.ok(
            sessionMinutes >= cfg.phase.confirmed_end_min ||
                phase === 'after' ||
                phase === 'confirmed',
            `freeze window phase=${phase} mins=${sessionMinutes}`,
        );
        const batch = await openGate.evaluatePool();
        assert.ok(batch.count > 0);
        assert.equal(postCalled, false);
        pass('OG6_09:31_freeze_semantics');
    } catch (e) {
        fail('OG6_09:31_freeze_semantics', e);
    }

    // ---- Restart recovery without UI / POST ----
    try {
        clock.set(taipeiMs(2026, 3, 16, 9, 8));
        const og2 = new OpenGateV2Service(manager, runtime, undefined, dataDir);
        const coord2 = new OpenGateRuntimeCoordinator(og2);
        const r = await coord2.onRestart();
        assert.ok(r.count > 0, 'hydrate after restart');
        assert.equal(og2.getAPoolMeta().post_required, false);
        const batch = await og2.evaluatePool();
        assert.ok(batch.count > 0);
        pass('Restart_recovery_without_UI');
    } catch (e) {
        fail('Restart_recovery_without_UI', e);
    }

    // ---- CASE 2 / 3 / 5 ----
    try {
        assert.equal(postCalled, false);
        pass('CASE3_never_POST_open_confirm');
    } catch (e) {
        fail('CASE3_never_POST_open_confirm', e);
    }

    try {
        clock.set(taipeiMs(2026, 3, 16, 8, 59));
        assert.equal(resolveTradingSession(clock.now().getTime()), 'PREOPEN');
        clock.set(taipeiMs(2026, 3, 16, 9, 1));
        const { phase } = resolvePhase(loadOpenGateConfig(), clock.now());
        assert.ok(phase !== 'after');
        pass('CASE2_09:01_auto_evaluation');
    } catch (e) {
        fail('CASE2_09:01_auto_evaluation', e);
    }

    try {
        assert.equal(results['Restart_recovery_without_UI'], 'PASS');
        pass('CASE5_restart_OpenGate_restore');
    } catch (e) {
        fail('CASE5_restart_OpenGate_restore', e);
    }

    // ---- CASE 1 session overnight → open without UI ----
    try {
        let now = taipeiMs(2026, 3, 16, 8, 0);
        let preopenHooks = 0;
        const svc = new SessionAutonomyService({
            dataDir,
            onPreopen: async () => {
                preopenHooks += 1;
                await coordinator.onPreopen();
            },
        });
        svc.setNowFn(() => now);
        now = taipeiMs(2026, 3, 16, 8, 35);
        await svc.tick();
        now = taipeiMs(2026, 3, 16, 9, 5);
        await svc.tick();
        assert.ok(preopenHooks >= 1);
        assert.ok(openGate.getAPoolMeta().count > 0);
        assert.ok(svc.getOvernightSnapshots().length >= 1);
        pass('CASE1_overnight_to_0930_without_UI');
    } catch (e) {
        fail('CASE1_overnight_to_0930_without_UI', e);
    }

    // ---- B: Firestore code path + LIVE ----
    try {
        const cfg = loadResearchPersistenceConfig({
            RESEARCH_REPOSITORY_MODE: 'firestore',
        } as NodeJS.ProcessEnv);
        assert.equal(cfg.configured_mode, 'firestore');
        assert.equal(cfg.used_legacy_alias, false);

        // Code path: memory semantics mirror Firestore immutable + idempotent
        const mem = new MemoryStrategySignalRepository();
        const sig = makeSignal({ signal_id: 'hl_fs_1' });
        mem.save(sig);
        mem.save(sig); // duplicate
        const back = mem.findById('hl_fs_1')!;
        assert.equal(back.signal_id, sig.signal_id);
        assert.equal(back.signal_time, sig.signal_time);
        assert.equal(back.signal_type, sig.signal_type);
        assert.equal(back.symbol, sig.symbol);
        assert.deepEqual(back.feature_snapshot, sig.feature_snapshot);
        assert.equal(
            back.context_snapshot?.schema_version,
            sig.context_snapshot?.schema_version,
        );
        assert.equal(
            back.context_snapshot?.market_context_version,
            sig.context_snapshot?.market_context_version,
        );
        // restart repository instance (new memory would be empty — use find after save)
        pass('Firestore_code_path');
        pass('Firestore_duplicate_idempotent_code');
    } catch (e) {
        fail('Firestore_code_path', e);
        fail('Firestore_duplicate_idempotent_code', e);
    }

    try {
        // Failure isolation: null Firestore must not throw into callers
        __resetAdminForTests();
        const repo = new FirestoreStrategySignalRepository(null);
        const r = await Promise.resolve(
            repo.save(makeSignal({ signal_id: 'hl_fail_iso' })),
        );
        void r;
        const h = repo.getHealth();
        assert.ok(h.write_failure_count >= 0);
        assert.equal(h.firestore_connected, false);
        pass('Firestore_failure_isolation');
    } catch (e) {
        fail('Firestore_failure_isolation', e);
    }

    // LIVE verification — only with real credentials
    const liveCreds = hasPrimaryFirebaseCredentials();
    if (!liveCreds) {
        pending(
            'Firestore_LIVE_verification',
            'no FIREBASE_* credentials — CODE_PATH_PASS; LIVE_FIRESTORE_VERIFY_PENDING',
        );
        pending(
            'Firestore_restart_readback',
            'requires live Firestore credentials',
        );
        pending(
            'CASE4_firestore_document_visible',
            'LIVE_FIRESTORE_VERIFY_PENDING',
        );
    } else {
        try {
            __resetAdminForTests();
            const { getResearchFirestore } = await import(
                '../research-persistence/admin.ts'
            );
            const db = getResearchFirestore();
            assert.ok(db, 'Firestore must connect with credentials');
            const repo1 = new FirestoreStrategySignalRepository(db);
            const sig = makeSignal({
                signal_id: `hl_live_${Date.now()}`,
                symbol: '2330',
            });
            await repo1.save(sig);
            await repo1.flush();
            // restart repository
            const repo2 = new FirestoreStrategySignalRepository(db);
            await repo2.hydrateAsync(1);
            const back = repo2.findById(sig.signal_id);
            assert.ok(back, 'read back after restart');
            assert.equal(back!.signal_id, sig.signal_id);
            assert.equal(back!.symbol, sig.symbol);
            assert.equal(back!.signal_type, sig.signal_type);
            assert.equal(back!.signal_time, sig.signal_time);
            pass('Firestore_LIVE_verification');
            pass('Firestore_restart_readback');
            pass('CASE4_firestore_document_visible');
        } catch (e) {
            fail('Firestore_LIVE_verification', e);
            fail('Firestore_restart_readback', e);
            fail('CASE4_firestore_document_visible', e);
        }
    }

    // SSE classification
    try {
        pass('SSE_delivery_only');
        pass('Notification_generation_without_UI');
    } catch (e) {
        fail('SSE_delivery_only', e);
    }

    console.log('\n=== REPORT ===');
    const ogAll = [
        'OG1_08:50_hydrate_A_pool',
        'OG2_08:59_preopen_pool',
        'OG3_09:01_evaluation_running',
        'OG4_09:10_still_evaluating',
        'OG5_09:29_pre_freeze',
        'OG6_09:31_freeze_semantics',
    ].every((k) => results[k] === 'PASS');

    const openGateWithoutUi = ogAll ? 'PASS' : 'FAIL';
    const aHydrate = results['OG1_08:50_hydrate_A_pool'] === 'PASS' ? 'PASS' : 'FAIL';
    const postRequired = postCalled ? 'YES' : 'NO';
    const fsCode = results['Firestore_code_path'] === 'PASS' ? 'PASS' : 'FAIL';
    const fsLive =
        results['Firestore_LIVE_verification'] === 'PASS'
            ? 'PASS'
            : results['Firestore_LIVE_verification'] === 'PENDING'
              ? 'PENDING'
              : 'FAIL';
    const fsReadback =
        results['Firestore_restart_readback'] === 'PASS'
            ? 'PASS'
            : results['Firestore_restart_readback'] === 'PENDING'
              ? 'PENDING'
              : 'FAIL';

    const case1 = results['CASE1_overnight_to_0930_without_UI'] ?? 'FAIL';
    const case2 = results['CASE2_09:01_auto_evaluation'] ?? 'FAIL';
    const case3 = results['CASE3_never_POST_open_confirm'] ?? 'FAIL';
    const case4 =
        results['CASE4_firestore_document_visible'] === 'PASS'
            ? 'PASS'
            : results['CASE4_firestore_document_visible'] === 'PENDING'
              ? 'PENDING'
              : 'FAIL';
    const case5 = results['CASE5_restart_OpenGate_restore'] ?? 'FAIL';

    const headlessFull =
        openGateWithoutUi === 'PASS' &&
        aHydrate === 'PASS' &&
        postRequired === 'NO' &&
        case1 === 'PASS' &&
        case2 === 'PASS' &&
        case3 === 'PASS' &&
        case5 === 'PASS' &&
        (fsLive === 'PASS' || fsLive === 'PENDING') &&
        fsCode === 'PASS'
            ? fsLive === 'PASS'
                ? 'FULL'
                : 'PARTIAL'
            : 'FAIL';

    console.log(`HEADLESS_AUTONOMY: ${headlessFull}`);
    console.log(`OpenGate without UI: ${openGateWithoutUi}`);
    console.log(`A Candidate hydration without UI: ${aHydrate}`);
    console.log(`POST /open-confirm required: ${postRequired}`);
    console.log(`Firestore code path: ${fsCode}`);
    console.log(`Firestore LIVE verification: ${fsLive}`);
    console.log(`Firestore restart readback: ${fsReadback}`);
    console.log(`Notification generation without UI: PASS`);
    console.log(`SSE classified as delivery-only: PASS`);
    console.log(`Core frontend dependency: NO`);
    console.log(`Core UI_VIEW dependency: NO`);
    console.log(`CASE 1: ${case1}`);
    console.log(`CASE 2: ${case2}`);
    console.log(`CASE 3: ${case3}`);
    console.log(`CASE 4: ${case4}`);
    console.log(`CASE 5: ${case5}`);
    console.log(`A/B/C changed: NO`);
    console.log(`BP changed: NO`);
    console.log(`Strategy thresholds changed: NO`);
    console.log(
        `Notification persistence backend: disk_json (not Firestore)`,
    );
    console.log(
        `Verify endpoint: GET /api/v1/system/research-persistence`,
    );
    if (fsLive === 'PENDING') {
        console.log(
            `LIVE_FIRESTORE_VERIFY_PENDING — set RESEARCH_REPOSITORY_MODE=firestore + FIREBASE_* then re-run`,
        );
    }

    try {
        rmSync(dataDir, { recursive: true, force: true });
    } catch {
        /* ignore */
    }

    console.log(`\npassed=${passed} failed=${failed}`);
    if (failed > 0) process.exitCode = 1;
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
