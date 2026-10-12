// EARLY record dedupe: a flickering attack state must not record a new signal
// every few seconds for the same symbol.

import assert from 'node:assert/strict';
import { EARLY_RECORD_MIN_GAP_MS, earlyRecordDue } from './service.ts';

const T0 = Date.parse('2026-10-08T01:00:45.000Z');

function replay(triggerOffsetsSec: number[]): number {
    let last: number | undefined;
    let recorded = 0;
    for (const s of triggerOffsetsSec) {
        const t = T0 + s * 1000;
        if (earlyRecordDue(last, t)) {
            last = t;
            recorded += 1;
        }
    }
    return recorded;
}

assert.equal(earlyRecordDue(undefined, T0), true);
assert.equal(earlyRecordDue(T0, T0 + 40_000), false);
assert.equal(earlyRecordDue(T0, T0 + EARLY_RECORD_MIN_GAP_MS - 1), false);
assert.equal(earlyRecordDue(T0, T0 + EARLY_RECORD_MIN_GAP_MS), true);

// Re-trigger every 40s for the whole session (the 10/08 median gap) → one per 30 min.
const flicker = Array.from({ length: (270 * 60) / 40 }, (_, i) => i * 40);
assert.equal(replay(flicker), 9);

// A genuine second attack two hours later is still recorded.
assert.equal(replay([0, 30, 70, 7200]), 2);

console.log('OK early record dedupe: flicker collapsed; later re-attack kept');
