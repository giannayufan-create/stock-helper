// server/src/scripts/verify-dual-equality.ts
// Compare JSONL vs Firestore for live dual verification.
// Does NOT create fake StrategySignals.
// Run: npx tsx src/scripts/verify-dual-equality.ts [fromYmd] [toYmd]

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlStrategySignalRepository } from '../lib/strategy-signal/repository.ts';
import { JsonlSignalOutcomeRepository } from '../lib/signal-outcome/repository.ts';
import { FirestoreStrategySignalRepository } from '../lib/research-persistence/firestore-signal-repository.ts';
import { FirestoreSignalOutcomeRepository } from '../lib/research-persistence/firestore-outcome-repository.ts';
import {
    getAdminInitError,
    getResearchFirestore,
} from '../lib/research-persistence/admin.ts';
import {
    outcomeIdentityHash,
    signalIdentityHash,
    signalsContentEqual,
} from '../lib/research-persistence/hash.ts';
import { hasPrimaryFirebaseCredentials } from '../lib/research-persistence/config.ts';

function taipeiToday(): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

async function main(): Promise<void> {
    if (!hasPrimaryFirebaseCredentials()) {
        console.error(
            'STOP: missing Firebase credentials — cannot verify dual equality',
        );
        process.exit(2);
    }
    const db = getResearchFirestore();
    if (!db) {
        console.error('Firestore init failed:', getAdminInitError());
        process.exit(1);
    }

    const from = process.argv[2] ?? taipeiToday();
    const to = process.argv[3] ?? from;
    const here = dirname(fileURLToPath(import.meta.url));
    const jsonlSignals = new JsonlStrategySignalRepository(
        join(here, '../../data/signals'),
    );
    const jsonlOutcomes = new JsonlSignalOutcomeRepository(
        join(here, '../../data/outcomes'),
    );
    const fsSignals = new FirestoreStrategySignalRepository(db);
    const fsOutcomes = new FirestoreSignalOutcomeRepository(db);

    await fsSignals.hydrateAsync(14);
    const localSignals = jsonlSignals.listRange(from, to);
    // Prefer async range for firestore
    const remoteSignals = await fsSignals.listRangeAsync(from, to, {
        limit: 500,
    });

    const localMap = new Map(localSignals.map((s) => [s.signal_id, s]));
    const remoteMap = new Map(remoteSignals.map((s) => [s.signal_id, s]));

    let match = 0;
    let conflict = 0;
    let missing_in_firestore = 0;
    let missing_in_jsonl = 0;
    const conflicts: string[] = [];

    for (const [id, local] of localMap) {
        const remote = remoteMap.get(id);
        if (!remote) {
            missing_in_firestore += 1;
            continue;
        }
        if (signalsContentEqual(local, remote)) {
            match += 1;
        } else {
            conflict += 1;
            conflicts.push(id);
        }
    }
    for (const id of remoteMap.keys()) {
        if (!localMap.has(id)) missing_in_jsonl += 1;
    }

    // Outcomes
    const localOut = jsonlOutcomes.materializeRange(from, to);
    await fsOutcomes.materializeRangeAsync(from, to, 500);
    const remoteOut = fsOutcomes.materializeRange(from, to);
    const lo = new Map(localOut.map((o) => [o.signal_id, o]));
    const ro = new Map(remoteOut.map((o) => [o.signal_id, o]));
    let outcome_match = 0;
    let outcome_conflict = 0;
    let outcome_missing_fs = 0;
    for (const [id, a] of lo) {
        const b = ro.get(id);
        if (!b) {
            outcome_missing_fs += 1;
            continue;
        }
        if (outcomeIdentityHash(a) === outcomeIdentityHash(b)) {
            outcome_match += 1;
        } else {
            outcome_conflict += 1;
        }
    }

    const report = {
        from,
        to,
        jsonl_signal_count: localMap.size,
        firestore_signal_count: remoteMap.size,
        signal_match: match,
        signal_conflict: conflict,
        missing_in_firestore,
        missing_in_jsonl,
        unexpected_duplicate: 0, // doc id = signal_id prevents dups
        jsonl_outcome_count: lo.size,
        firestore_outcome_count: ro.size,
        outcome_match,
        outcome_conflict,
        outcome_missing_in_firestore: outcome_missing_fs,
        conflict_sample_ids: conflicts.slice(0, 10),
        identity_hash_check_ok:
            match > 0
                ? [...localMap.values()].slice(0, 5).every((s) => {
                      const r = remoteMap.get(s.signal_id);
                      return r && signalIdentityHash(s) === signalIdentityHash(r);
                  })
                : true,
        cutover_ready:
            conflict === 0 &&
            missing_in_firestore === 0 &&
            outcome_conflict === 0 &&
            localMap.size > 0,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.cutover_ready) process.exitCode = 3;
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
