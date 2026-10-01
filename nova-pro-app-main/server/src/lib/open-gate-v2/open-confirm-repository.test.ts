// Run: npx tsx src/lib/open-gate-v2/open-confirm-repository.test.ts

import assert from 'node:assert/strict';
import { DEFAULT_OPEN_GATE_CONFIG } from './config.ts';
import { OpenConfirmRepository } from './open-confirm-repository.ts';
import type { OpenConfirmResult } from './types.ts';

function result(partial: Partial<OpenConfirmResult>): OpenConfirmResult {
    return {
        symbol: '2330',
        open_confirm: 'watch',
        tradeable_candidate: false,
        hard_reject: false,
        soft_reject: false,
        data_health: 'ok',
        data_blocked: false,
        final_open_score: 50,
        risk: { chase_risk: 'low', invalid_price: null },
        ...partial,
    } as unknown as OpenConfirmResult;
}

const repo = new OpenConfirmRepository();
const cfg = DEFAULT_OPEN_GATE_CONFIG;

const watch = result({});
assert.equal(repo.shouldLog(watch, result({}), cfg).yes, false);
console.log('PASS unchanged_watch_symbol_gets_no_heartbeat');

const pass = result({ open_confirm: 'pass' });
assert.deepEqual(repo.shouldLog(pass, result({ open_confirm: 'pass' }), cfg), {
    yes: true,
    reason: 'heartbeat',
});
console.log('PASS pass_symbol_still_heartbeats');

const tradeable = result({ tradeable_candidate: true });
assert.equal(
    repo.shouldLog(tradeable, result({ tradeable_candidate: true }), cfg).reason,
    'heartbeat',
);
console.log('PASS tradeable_symbol_still_heartbeats');

assert.equal(
    repo.shouldLog(watch, result({ final_open_score: 60 }), cfg).reason,
    'score_delta',
);
console.log('PASS changes_still_logged_for_whole_pool');

console.log('\nOK 4 tests');
