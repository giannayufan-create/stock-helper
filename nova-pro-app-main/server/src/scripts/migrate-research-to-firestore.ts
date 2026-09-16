// server/src/scripts/migrate-research-to-firestore.ts
// One-shot migration: JSONL → Firestore. Does NOT delete JSONL.
// Run: npx tsx src/scripts/migrate-research-to-firestore.ts
//
// Env (names only): FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
// FIREBASE_PRIVATE_KEY, GOOGLE_APPLICATION_CREDENTIALS

import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlStrategySignalRepository } from '../lib/strategy-signal/repository.ts';
import { JsonlSignalOutcomeRepository } from '../lib/signal-outcome/repository.ts';
import { FirestoreStrategySignalRepository } from '../lib/research-persistence/firestore-signal-repository.ts';
import { FirestoreSignalOutcomeRepository } from '../lib/research-persistence/firestore-outcome-repository.ts';
import { getResearchFirestore, getAdminInitError } from '../lib/research-persistence/admin.ts';
import { signalsContentEqual } from '../lib/research-persistence/hash.ts';

async function main(): Promise<void> {
    const db = getResearchFirestore();
    if (!db) {
        console.error('Firestore unavailable:', getAdminInitError());
        process.exit(1);
    }

    const here = dirname(fileURLToPath(import.meta.url));
    const signalsRoot = join(here, '../../data/signals');
    const outcomesRoot = join(here, '../../data/outcomes');

    const jsonlSignals = new JsonlStrategySignalRepository(signalsRoot);
    const jsonlOutcomes = new JsonlSignalOutcomeRepository(outcomesRoot);
    const fsSignals = new FirestoreStrategySignalRepository(db);
    const fsOutcomes = new FirestoreSignalOutcomeRepository(db);

    const stats = {
        signals_total: 0,
        signals_migrated: 0,
        signals_skipped: 0,
        signals_conflict: 0,
        signals_failed: 0,
        outcomes_total: 0,
        outcomes_migrated: 0,
        outcomes_skipped: 0,
        outcomes_failed: 0,
    };

    const ymds = existsSync(signalsRoot)
        ? readdirSync(signalsRoot)
              .filter((f) => f.endsWith('.jsonl'))
              .map((f) => f.replace(/\.jsonl$/, ''))
              .sort()
        : [];

    for (const ymd of ymds) {
        for (const signal of jsonlSignals.listByDate(ymd)) {
            stats.signals_total += 1;
            try {
                const remote = await fsSignals.findByIdAsync(signal.signal_id);
                if (remote) {
                    if (signalsContentEqual(remote, signal)) {
                        stats.signals_skipped += 1;
                        continue;
                    }
                    stats.signals_conflict += 1;
                    console.error('CONFLICT', signal.signal_id);
                    continue;
                }
                // Direct create path via save + flush
                fsSignals.save(signal);
                await fsSignals.flush();
                if (fsSignals.lastPersistResult === 'CREATED') {
                    stats.signals_migrated += 1;
                } else if (fsSignals.lastPersistResult === 'SKIP_IDEMPOTENT') {
                    stats.signals_skipped += 1;
                } else if (fsSignals.lastPersistResult === 'CONFLICT') {
                    stats.signals_conflict += 1;
                } else {
                    stats.signals_migrated += 1;
                }
            } catch (err) {
                stats.signals_failed += 1;
                console.error(
                    'signal fail',
                    signal.signal_id,
                    err instanceof Error ? err.message : err,
                );
            }
        }
    }

    const outYmds = existsSync(outcomesRoot)
        ? readdirSync(outcomesRoot)
              .filter((f) => f.endsWith('.jsonl'))
              .map((f) => f.replace(/\.jsonl$/, ''))
              .sort()
        : [];
    for (const ymd of outYmds) {
        const materialized = jsonlOutcomes.materializeRange(ymd, ymd);
        for (const outcome of materialized) {
            stats.outcomes_total += 1;
            try {
                const existing = fsOutcomes.findBySignalId(outcome.signal_id);
                if (existing) {
                    stats.outcomes_skipped += 1;
                    continue;
                }
                fsOutcomes.appendUpdate(outcome);
                await fsOutcomes.flush();
                stats.outcomes_migrated += 1;
            } catch (err) {
                stats.outcomes_failed += 1;
                console.error(
                    'outcome fail',
                    outcome.signal_id,
                    err instanceof Error ? err.message : err,
                );
            }
        }
    }

    console.log(JSON.stringify(stats, null, 2));
    console.log('JSONL files were NOT deleted (backup retained).');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
