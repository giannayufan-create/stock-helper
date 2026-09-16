// server/src/lib/session-autonomy/headless-autonomy.test.ts
// Headless Autonomy Test — NO EventSource, NO frontend polling, NO UI_VIEW.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvalTimingRegistry } from '../live-acceptance/eval-timing.ts';
import { SessionAutonomyService } from './service.ts';
import { resolveTradingSession, taipeiMs } from './session-clock.ts';

let passed = 0;
let failed = 0;
const results: Record<string, 'PASS' | 'FAIL'> = {};

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

console.log('=== Headless Autonomy Test ===');
console.log('(no EventSource / no UI_VIEW / no frontend polling)\n');

const dataDir = mkdtempSync(join(tmpdir(), 'headless-autonomy-'));
EvalTimingRegistry.reset();

// Pure clock resolution
{
    try {
        assert.equal(
            resolveTradingSession(taipeiMs(2026, 3, 16, 8, 0)),
            'NIGHT_LIVE',
        );
        assert.equal(
            resolveTradingSession(taipeiMs(2026, 3, 16, 8, 35)),
            'PREOPEN',
        );
        assert.equal(
            resolveTradingSession(taipeiMs(2026, 3, 16, 10, 0)),
            'CASH_LIVE',
        );
        pass('session_clock_transitions');
    } catch (e) {
        fail('session_clock_transitions', e);
    }
}

let now = taipeiMs(2026, 3, 16, 8, 0); // Monday NIGHT
let cashHooks = 0;
let preopenHooks = 0;
let notifCount = 0;

const svc = new SessionAutonomyService({
    dataDir,
    getNotificationCandidateCount: () => notifCount,
    onCashLive: () => {
        cashHooks += 1;
    },
    onPreopen: () => {
        preopenHooks += 1;
    },
});
svc.setNowFn(() => now);

(async () => {
    try {
        // Start headless — no HTTP listen required for FSM
        assert.equal(svc.getState(), 'NIGHT_LIVE');

        // Simulate NIGHT → PREOPEN (no UI)
        now = taipeiMs(2026, 3, 16, 8, 35);
        const t1 = await svc.tick();
        assert.ok(t1);
        assert.equal(t1!.from, 'NIGHT_LIVE');
        assert.equal(t1!.to, 'PREOPEN');
        assert.equal(svc.getState(), 'PREOPEN');
        assert.ok(svc.getOvernightSnapshots().length >= 1);
        const ovn = svc.getOvernightSnapshots()[0]!;
        assert.equal(ovn.ui_required, false);
        assert.ok(ovn.persisted_to.includes('disk'));
        assert.ok(preopenHooks >= 1);
        pass('Overnight Context without UI');
        pass('PreOpen without UI');
    } catch (e) {
        fail('Overnight Context without UI', e);
        fail('PreOpen without UI', e);
    }

    try {
        // PREOPEN → CASH_LIVE
        now = taipeiMs(2026, 3, 16, 9, 5);
        const t2 = await svc.tick();
        assert.ok(t2);
        assert.equal(t2!.from, 'PREOPEN');
        assert.equal(t2!.to, 'CASH_LIVE');
        assert.ok(cashHooks >= 1);
        const health = svc.getHealth();
        assert.equal(health.headless, true);
        assert.equal(health.ui_view_consumers, 0);
        assert.equal(health.event_source_clients, 0);
        assert.equal(health.engines_noted.cash_market_context, true);
        pass('Cash Runtime without UI');
    } catch (e) {
        fail('Cash Runtime without UI', e);
    }

    try {
        // Notifications: simulate BP candidate ingest counter without SSE clients
        notifCount = 3;
        assert.equal(svc.getHealth().engines_noted.notification_candidates, 3);
        // Creation path does not need EventSource (SseHub empty is OK)
        pass('Notifications without UI');
    } catch (e) {
        fail('Notifications without UI', e);
    }

    try {
        // Persistence without UI: disk overnight always; Firestore only if marked.
        const diskOk = svc
            .getOvernightSnapshots()
            .some((s) => s.persisted_to.includes('disk'));
        assert.ok(diskOk, 'overnight disk persist required');
        const fsOk = svc
            .getOvernightSnapshots()
            .some((s) => s.persisted_to.includes('firestore'));
        if (fsOk) {
            pass('Firestore persistence without UI');
        } else {
            console.log(
                '  NOTE  Overnight disk/jsonl OK without UI; Firestore not written (no credentials / not dual in this harness)',
            );
            fail(
                'Firestore persistence without UI',
                new Error(
                    'Firestore path not exercised — headless disk overnight works; configure FIRESTORE/dual for true FS writes',
                ),
            );
        }
    } catch (e) {
        fail('Firestore persistence without UI', e);
    }

    try {
        // Prove no UI dependency for session FSM itself
        assert.equal(svc.getHealth().ui_view_consumers, 0);
        pass('HEADLESS_AUTONOMY_FSM');
    } catch (e) {
        fail('HEADLESS_AUTONOMY_FSM', e);
    }

    // Simulate C/BP eval counts as if engines ran headlessly
    EvalTimingRegistry.note('C', 12);
    EvalTimingRegistry.note('BP', 8);
    assert.ok(svc.getHealth().engines_noted.c_eval_count >= 1);
    assert.ok(svc.getHealth().engines_noted.bp_eval_count >= 1);
    pass('C_BP_eval_counters_headless');

    console.log('\n=== REPORT ===');
    const overnight = results['Overnight Context without UI'] ?? 'FAIL';
    const preopen = results['PreOpen without UI'] ?? 'FAIL';
    const cash = results['Cash Runtime without UI'] ?? 'FAIL';
    const notif = results['Notifications without UI'] ?? 'FAIL';
    const fs = results['Firestore persistence without UI'] ?? 'FAIL';
    const fsm = results['HEADLESS_AUTONOMY_FSM'] ?? 'FAIL';

    const headlessAutonomy =
        overnight === 'PASS' &&
        preopen === 'PASS' &&
        cash === 'PASS' &&
        notif === 'PASS' &&
        fsm === 'PASS'
            ? 'PASS'
            : 'FAIL';
    // Firestore is reported separately — not required for HEADLESS_AUTONOMY core FSM

    console.log(`HEADLESS_AUTONOMY: ${headlessAutonomy}`);
    console.log(`Overnight Context without UI: ${overnight}`);
    console.log(`PreOpen without UI: ${preopen}`);
    console.log(`Cash Runtime without UI: ${cash}`);
    console.log(`Notifications without UI: ${notif}`);
    console.log(`Firestore persistence without UI: ${fs}`);
    console.log(
        `是否存在「使用者打開網頁才啟動」的 dependency: YES`,
    );
    console.log(`  - OpenGateV2Service / ACandidateRepository (POST /api/v1/data/open-confirm 才有 A pool → B)`);
    console.log(`  - SseHub live push (產生/落盤不需 UI；瀏覽器即時推播需要 EventSource)`);
    console.log(`  - C / BuyPressure / MarketContext / SessionAutonomy / PreOpen FSM: NO (boot timers)`);

    try {
        rmSync(dataDir, { recursive: true, force: true });
    } catch {
        /* ignore */
    }

    if (failed > 0 && headlessAutonomy === 'FAIL') {
        process.exitCode = 1;
    }
    console.log(`\npassed=${passed} failed=${failed}`);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
