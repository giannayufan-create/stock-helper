// server/src/scripts/firestore-diagnostic-ping.ts
// Writes ONLY to research_diagnostics — never strategy_signals.
// learning_eligible semantics: diagnostic docs are excluded from Context Analytics.
// Run: npx tsx src/scripts/firestore-diagnostic-ping.ts

import {
    getAdminInitError,
    getFirebaseProjectIdSafe,
    getResearchFirestore,
} from '../lib/research-persistence/admin.ts';
import { hasPrimaryFirebaseCredentials } from '../lib/research-persistence/config.ts';
import { RESEARCH_DIAGNOSTICS_COLLECTION } from '../lib/research-persistence/types.ts';

async function main(): Promise<void> {
    if (!hasPrimaryFirebaseCredentials()) {
        console.error('STOP: missing FIREBASE_* credentials');
        process.exit(2);
    }
    const db = getResearchFirestore();
    if (!db) {
        console.error('init failed:', getAdminInitError());
        process.exit(1);
    }
    const id = `diag_${Date.now().toString(36)}`;
    const ref = db.collection(RESEARCH_DIAGNOSTICS_COLLECTION).doc(id);
    await ref.set({
        diagnostic: true,
        learning_eligible: false,
        purpose: 'firestore_connectivity_ping',
        project_id: getFirebaseProjectIdSafe(),
        created_at: new Date().toISOString(),
        note: 'NOT a StrategySignal — excluded from Context Analytics',
    });
    const snap = await ref.get();
    console.log(
        JSON.stringify(
            {
                ok: snap.exists,
                diagnostic_id: id,
                collection: RESEARCH_DIAGNOSTICS_COLLECTION,
                project_id: getFirebaseProjectIdSafe(),
                wrote_to_strategy_signals: false,
            },
            null,
            2,
        ),
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
