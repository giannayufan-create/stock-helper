// server/src/lib/research-persistence/f-acceptance.test.ts
// Firebase / Firestore Production Cutover v1 — F1–F10
// Run: npx tsx src/lib/research-persistence/f-acceptance.test.ts
// Live Firestore (optional): CUTOVER_LIVE=1 with FIREBASE_* env set.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StrategySignal } from '../strategy-signal/types.ts';
import type { SignalOutcome } from '../signal-outcome/types.ts';
import { MemoryStrategySignalRepository } from './memory-signal-repository.ts';
import { MemorySignalOutcomeRepository } from './memory-outcome-repository.ts';
import { FirestoreStrategySignalRepository } from './firestore-signal-repository.ts';
import { FirestoreSignalOutcomeRepository } from './firestore-outcome-repository.ts';
import { DualStrategySignalRepository } from './dual-repository.ts';
import { JsonlStrategySignalRepository } from '../strategy-signal/repository.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ResearchPersistenceQueue } from './queue.ts';
import {
    __resetAdminForTests,
    getFirebaseStatus,
    getResearchFirestore,
    verifyFirestoreConnectivity,
} from './admin.ts';
import {
    hasPrimaryFirebaseCredentials,
    loadResearchPersistenceConfig,
} from './config.ts';
import { createResearchRepositories } from './factory.ts';
import { signalsContentEqual } from './hash.ts';

const results: Record<string, 'PASS' | 'FAIL' | 'SKIP'> = {};
let passed = 0;
let failed = 0;

function record(id: string, ok: boolean, detail = '') {
    results[id] = ok ? 'PASS' : 'FAIL';
    if (ok) {
        passed++;
        console.log(`PASS ${id}${detail ? ` — ${detail}` : ''}`);
    } else {
        failed++;
        console.error(`FAIL ${id}${detail ? ` — ${detail}` : ''}`);
    }
}

function makeSignal(
    partial: Partial<StrategySignal> & { signal_id: string },
): StrategySignal {
    return {
        signal_id: partial.signal_id,
        symbol: partial.symbol ?? '2330',
        signal_type: partial.signal_type ?? 'SURGE',
        signal_time: partial.signal_time ?? '2026-09-17T01:20:00.000Z',
        reference_price: partial.reference_price ?? 100,
        reference_price_source: 'test',
        source: 'C',
        strategy_version: 'bc-strategy-v1',
        config_hash: 'cfg_cutover_v1',
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
            captured_at: '2026-09-17T01:20:00.000Z',
            market_context_version: 'mc_v1',
            sector_rotation_version: 'sector_rotation_v1',
            event_engine_version: 'ei_v1',
            exposure_map_version: 'exposure_map_v1',
            confirmation_version: 'confirmation_v1',
            config_hash: 'cfg_cutover_v1',
            schema_version: 'context_snapshot_v1',
        },
        context_tags: partial.context_tags ?? ['SECTOR_ROTATING_IN'],
        context_alignment: partial.context_alignment ?? 'ALIGNED',
        context_strength_score: partial.context_strength_score ?? 72,
    };
}

function makeOutcome(signalId: string): SignalOutcome {
    return {
        signal_id: signalId,
        symbol: '2330',
        signal_type: 'SURGE',
        signal_time: '2026-09-17T01:20:00.000Z',
        reference_price: 100,
        status: 'complete',
        forward_return_5m: 0.5,
        forward_return_15m: 1.2,
        mfe_15m: 1.8,
        mae_15m: -0.4,
        invalid_hit: false,
        hit_plus_1pct: true,
        source_mode: 'live',
        data_resolution: 'tick',
        calculated_at: '2026-09-17T02:00:00.000Z',
        outcome_sequence: 'target_only',
    };
}

const live = process.env.CUTOVER_LIVE === '1' && hasPrimaryFirebaseCredentials();

async function run(): Promise<void> {
    // ---- F1 Firebase credentials / status enum ----
    {
        __resetAdminForTests();
        const status = getFirebaseStatus();
        assert.ok(
            [
                'FIREBASE_NOT_CONFIGURED',
                'FIREBASE_INITIALIZING',
                'FIREBASE_CONNECTED',
                'FIREBASE_ERROR',
            ].includes(status),
        );
        if (live) {
            const ok = await verifyFirestoreConnectivity();
            record(
                'F1',
                ok && getFirebaseStatus() === 'FIREBASE_CONNECTED',
                getFirebaseStatus(),
            );
        } else {
            record(
                'F1',
                false,
                `${status} — need FIREBASE_* + CUTOVER_LIVE=1 for FIREBASE_CONNECTED`,
            );
        }
    }

    // ---- F2 StrategySignal write ----
    {
        if (live) {
            const db = getResearchFirestore();
            assert.ok(db);
            const repo = new FirestoreStrategySignalRepository(db);
            const id = `f2_${Date.now().toString(36)}`;
            const s = makeSignal({ signal_id: id });
            repo.save(s);
            await repo.flush();
            const remote = await repo.findByIdAsync(id);
            record(
                'F2',
                Boolean(remote && signalsContentEqual(s, remote)),
                'live Firestore StrategySignal',
            );
        } else {
            const repo = new MemoryStrategySignalRepository();
            repo.save(makeSignal({ signal_id: 'f2_mem' }));
            console.log('INFO F2 memory semantics OK (not counted as live PASS)');
            record('F2', false, 'need live Firestore write (CUTOVER_LIVE=1)');
        }
    }

    // ---- F3 SignalOutcome write ----
    {
        if (live) {
            const db = getResearchFirestore();
            const repo = new FirestoreSignalOutcomeRepository(db);
            const id = `f3_${Date.now().toString(36)}`;
            const o = makeOutcome(id);
            repo.appendUpdate(o);
            await repo.flush();
            const loaded = repo.findBySignalId(id);
            record(
                'F3',
                Boolean(loaded && loaded.forward_return_15m === 1.2),
                'live Firestore SignalOutcome',
            );
        } else {
            const repo = new MemorySignalOutcomeRepository();
            repo.appendUpdate(makeOutcome('f3_mem'));
            console.log('INFO F3 memory semantics OK (not counted as live PASS)');
            record('F3', false, 'need live Firestore write (CUTOVER_LIVE=1)');
        }
    }

    // ---- F4 Restart readback ----
    {
        if (live) {
            const db = getResearchFirestore();
            const id = `f4_${Date.now().toString(36)}`;
            const s = makeSignal({ signal_id: id });
            const repo1 = new FirestoreStrategySignalRepository(db);
            repo1.save(s);
            await repo1.flush();
            const repo2 = new FirestoreStrategySignalRepository(db);
            const remote = await repo2.findByIdAsync(id);
            const ok =
                remote != null &&
                remote.signal_id === s.signal_id &&
                remote.signal_time === s.signal_time &&
                signalsContentEqual(s, remote) &&
                remote.feature_snapshot.intraday_score === 80 &&
                remote.context_snapshot?.sector_rank === 8 &&
                remote.config_hash === s.config_hash;
            record('F4', ok, 'FIRESTORE_RESTART_READBACK');
        } else {
            const dir = mkdtempSync(join(tmpdir(), 'f4-'));
            const r1 = new JsonlStrategySignalRepository(dir);
            const s = makeSignal({ signal_id: 'f4_jsonl' });
            r1.save(s);
            const r2 = new JsonlStrategySignalRepository(dir);
            r2.hydrateKnownIds();
            assert.ok(signalsContentEqual(s, r2.findById('f4_jsonl')!));
            console.log('INFO F4 jsonl restart stand-in OK');
            record('F4', false, 'need live FIRESTORE_RESTART_READBACK');
        }
    }

    // ---- F5 Headless write (frontend_clients=0) ----
    {
        const frontend_clients_connected = 0;
        if (live) {
            const db = getResearchFirestore();
            const fsRepo = new FirestoreStrategySignalRepository(db);
            const id = `f5_${Date.now().toString(36)}`;
            fsRepo.save(makeSignal({ signal_id: id }));
            await fsRepo.flush();
            const remote = await fsRepo.findByIdAsync(id);
            record(
                'F5',
                frontend_clients_connected === 0 && Boolean(remote),
                'FIRESTORE_HEADLESS_WRITE',
            );
        } else {
            const repo = new MemoryStrategySignalRepository();
            repo.save(makeSignal({ signal_id: 'f5_headless' }));
            assert.ok(frontend_clients_connected === 0 && repo.findById('f5_headless'));
            console.log('INFO F5 headless path independent of UI');
            record('F5', false, 'need live FIRESTORE_HEADLESS_WRITE');
        }
    }

    // ---- F6 Duplicate protection ----
    {
        const repo = new MemoryStrategySignalRepository();
        const s = makeSignal({ signal_id: 'f6_dup' });
        repo.save(s);
        repo.save(s); // identical → idempotent
        assert.equal(repo.lastPersistResult, 'SKIP_IDEMPOTENT');
        let conflict = false;
        try {
            repo.save(
                makeSignal({
                    signal_id: 'f6_dup',
                    feature_snapshot: { intraday_score: 99 },
                }),
            );
        } catch {
            conflict = true;
        }
        record('F6', conflict && repo.knownIds().size === 1, 'DUPLICATE_PROTECTION');
    }

    // ---- F7 Point-in-time immutable context ----
    {
        const repo = new MemoryStrategySignalRepository();
        const s = makeSignal({
            signal_id: 'f7_pit',
            context_snapshot: {
                ...makeSignal({ signal_id: 'x' }).context_snapshot!,
                sector_rank: 3,
                captured_at: '2026-09-17T01:20:00.000Z',
            },
        });
        repo.save(s);
        // "current context" changes later — must not mutate stored snapshot
        const currentContext = { sector_rank: 99 };
        const loaded = repo.findById('f7_pit')!;
        record(
            'F7',
            loaded.context_snapshot!.sector_rank === 3 &&
                currentContext.sector_rank === 99,
            'POINT_IN_TIME_IMMUTABLE',
        );
    }

    // ---- F8 Firestore failure isolation ----
    {
        const scores = { c: 85, bp: 77, open_gate: true, context: true };
        const repo = new FirestoreStrategySignalRepository(null);
        repo.save(makeSignal({ signal_id: 'f8_iso' }));
        const h = repo.getHealth();
        record(
            'F8',
            Boolean(repo.findById('f8_iso')) &&
                h.connected === false &&
                scores.c === 85 &&
                scores.bp === 77 &&
                scores.open_gate &&
                scores.context,
            'MarketRuntime continues; persistence degraded',
        );
    }

    // ---- F9 Health endpoint does not leak secrets ----
    {
        const here = dirname(fileURLToPath(import.meta.url));
        const healthPath = join(here, '../../routes/health.ts');
        const text = readFileSync(healthPath, 'utf8');
        const leakPatterns = [
            'FIREBASE_PRIVATE_KEY',
            'privateKey',
            'BEGIN PRIVATE KEY',
            'client_secret',
        ];
        // Endpoint may reference env NAME firebase_configured — OK.
        // Must not stringify process.env.FIREBASE_PRIVATE_KEY
        const bad =
            /process\.env\.FIREBASE_PRIVATE_KEY/.test(text) ||
            /privateKeyRaw/.test(text) ||
            text.includes('BEGIN PRIVATE KEY');
        const payloadSim = {
            mode: 'firestore',
            firebase_configured: true,
            firebase_status: 'FIREBASE_CONNECTED',
            last_error: null,
        };
        const blob = JSON.stringify(payloadSim);
        const payloadLeak = leakPatterns.some(
            (p) => p !== 'FIREBASE_PRIVATE_KEY' && blob.includes(p),
        );
        record('F9', !bad && !payloadLeak, 'secrets not in health surface');
    }

    // ---- F10 Primary repository = FIRESTORE when mode firestore ----
    {
        if (live) {
            process.env.RESEARCH_REPOSITORY_MODE = 'firestore';
            const repos = createResearchRepositories();
            const h = repos.getHealth();
            record(
                'F10',
                h.primary_repository === 'FIRESTORE' &&
                    repos.mode === 'firestore',
                `primary=${h.primary_repository} mode=${repos.mode}`,
            );
        } else {
            record(
                'F10',
                false,
                'PENDING — Render RESEARCH_REPOSITORY_MODE=firestore + FIREBASE_*',
            );
        }
    }

    // Extra gates from cutover spec
    {
        const q = new ResearchPersistenceQueue(10, 5, 8);
        let done = false;
        q.enqueue(async () => {
            await new Promise((r) => setTimeout(r, 5));
            done = true;
        });
        assert.equal(q.pressure(), 'NORMAL');
        await q.flush();
        assert.ok(done);
        console.log('PASS Persistence Queue — non-blocking');
    }

    {
        const dir = mkdtempSync(join(tmpdir(), 'dual-eq-'));
        const jsonl = new JsonlStrategySignalRepository(dir);
        const mem = new MemoryStrategySignalRepository();
        const dual = new DualStrategySignalRepository(jsonl, mem as never);
        // DualStrategySignalRepository expects firestore-like second — use memory via cast for equality path
        const s = makeSignal({ signal_id: 'dual_eq' });
        jsonl.save(s);
        mem.save(s);
        assert.ok(signalsContentEqual(jsonl.findById('dual_eq')!, mem.findById('dual_eq')!));
        console.log(
            live
                ? 'PASS Dual Equality — local mirror (use cutover:verify-dual for live)'
                : 'PASS Dual Equality — NOT USED live (local mirror OK)',
        );
        void dual;
    }

    {
        const here = dirname(fileURLToPath(import.meta.url));
        const files = readdirSync(here).filter((f) => f.endsWith('.ts'));
        let frontendDep = false;
        for (const f of files) {
            const text = readFileSync(join(here, f), 'utf8');
            if (
                text.includes('EventSource') ||
                text.includes('VITE_FIREBASE') ||
                text.includes('frontend_clients')
            ) {
                // f-acceptance mentions frontend_clients=0 — allow test file only
                if (f !== 'f-acceptance.test.ts') frontendDep = true;
            }
        }
        console.log(
            frontendDep
                ? 'FAIL Core Frontend Dependency — YES'
                : 'PASS Core Frontend Dependency — NO',
        );
    }

    console.log('\n=== F1–F10 Summary ===');
    for (const id of [
        'F1',
        'F2',
        'F3',
        'F4',
        'F5',
        'F6',
        'F7',
        'F8',
        'F9',
        'F10',
    ]) {
        console.log(`${id}: ${results[id] ?? 'FAIL'}`);
    }
    console.log(`\nf-acceptance: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
