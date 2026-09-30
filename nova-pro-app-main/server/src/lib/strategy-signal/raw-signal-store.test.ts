// server/src/lib/strategy-signal/raw-signal-store.test.ts
// Run: npx tsx src/lib/strategy-signal/raw-signal-store.test.ts

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    RAW_SIGNAL_EVENT_SCHEMA,
    type RawSignalEvent,
} from './raw-signal-event.ts';
import { RawSignalStore } from './raw-signal-store.ts';

let passed = 0;
function pass(name: string) {
    passed++;
    console.log(`PASS ${name}`);
}

function makeEvent(
    partial: Partial<RawSignalEvent> & { signal_id: string },
): RawSignalEvent {
    return {
        signal_id: partial.signal_id,
        symbol: partial.symbol ?? '2330',
        strategy_name: partial.strategy_name ?? 'OPEN_PASS',
        strategy_version: partial.strategy_version ?? 'bc-strategy-v1',
        config_hash: partial.config_hash ?? 'cfg_test',
        signal_time: partial.signal_time ?? '2026-09-25T01:30:00.000Z',
        observation_time:
            partial.observation_time ?? '2026-09-25T01:30:00.000Z',
        data_source: partial.data_source ?? 'test',
        source_mode: partial.source_mode ?? 'synthetic',
        price_at_signal: partial.price_at_signal ?? 100,
        scores: partial.scores ?? { score: 80, final_open_score: 82 },
        trigger_conditions: partial.trigger_conditions ?? {
            signal_type: 'OPEN_PASS',
            tradeable_candidate: true,
        },
        key_inputs: partial.key_inputs ?? { gap_pct: 1.2 },
        data_completeness: partial.data_completeness ?? {
            learning_eligible: true,
            data_resolution: '1m',
        },
        exit_rules_snapshot: partial.exit_rules_snapshot ?? {
            invalid_price: 98.5,
            // take_profit / stop intentionally absent
        },
        schema_version: RAW_SIGNAL_EVENT_SCHEMA,
    };
}

const dir = mkdtempSync(join(tmpdir(), 'raw-sig-'));
try {
    const store = new RawSignalStore(dir);

    // ---- append ----
    const ev1 = makeEvent({ signal_id: 'raw_001' });
    const r1 = store.append(ev1);
    assert.equal(r1.status, 'APPENDED');
    assert.equal(store.findById('raw_001')?.symbol, '2330');
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    const lines = readFileSync(join(dir, files[0]!), 'utf8')
        .split('\n')
        .filter(Boolean);
    assert.equal(lines.length, 1);
    pass('append');

    // ---- dedupe SKIP_IDEMPOTENT ----
    const r2 = store.append({
        ...ev1,
        price_at_signal: 999, // would-be overwrite
        exit_rules_snapshot: {
            invalid_price: 98.5,
            take_profit_pct: 5, // attempt to backfill
        },
    });
    assert.equal(r2.status, 'SKIP_IDEMPOTENT');
    const again = store.findById('raw_001')!;
    assert.equal(again.price_at_signal, 100);
    assert.equal(again.exit_rules_snapshot.take_profit_pct, undefined);
    const lines2 = readFileSync(join(dir, files[0]!), 'utf8')
        .split('\n')
        .filter(Boolean);
    assert.equal(lines2.length, 1, 'no second line on dedupe');
    pass('dedupe_no_overwrite');

    // ---- missing exit fields stay missing ----
    const ev2 = makeEvent({
        signal_id: 'raw_002',
        exit_rules_snapshot: {
            invalid_price: 50,
            // no take_profit_pct / stop_loss_pct / max_hold_minutes
        },
    });
    store.append(ev2);
    const loaded = store.findById('raw_002')!;
    assert.equal(loaded.exit_rules_snapshot.take_profit_pct, undefined);
    assert.equal(loaded.exit_rules_snapshot.stop_loss_pct, undefined);
    assert.equal(loaded.exit_rules_snapshot.max_hold_minutes, undefined);
    assert.equal(loaded.exit_rules_snapshot.invalid_price, 50);
    // JSON must not have invented null take_profit if omitted
    const diskLine = readFileSync(join(dir, files[0]!), 'utf8')
        .split('\n')
        .filter(Boolean)
        .find((l) => l.includes('raw_002'))!;
    const parsed = JSON.parse(diskLine) as RawSignalEvent;
    assert.ok(
        !('take_profit_pct' in parsed.exit_rules_snapshot) ||
            parsed.exit_rules_snapshot.take_profit_pct == null,
    );
    pass('missing_exit_fields_stay_missing');

    // ---- hydrate on restart ----
    const store2 = new RawSignalStore(dir);
    assert.ok(store2.knownIds().has('raw_001'));
    assert.ok(store2.knownIds().has('raw_002'));
    const r3 = store2.append(makeEvent({ signal_id: 'raw_001' }));
    assert.equal(r3.status, 'SKIP_IDEMPOTENT');
    pass('hydrate_known_ids');

    // ---- no update/delete API ----
    assert.equal(
        typeof (store as unknown as { update?: unknown }).update,
        'undefined',
    );
    assert.equal(
        typeof (store as unknown as { delete?: unknown }).delete,
        'undefined',
    );
    pass('no_update_delete_api');

    console.log(`\nOK ${passed} tests`);
} finally {
    rmSync(dir, { recursive: true, force: true });
}
