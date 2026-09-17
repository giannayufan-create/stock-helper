// server/src/scripts/cutover-preflight.ts
// Phase 3.6 — credential / env preflight. Never prints secret values.
// Run: npx tsx src/scripts/cutover-preflight.ts

import {
    hasPrimaryFirebaseCredentials,
    loadResearchPersistenceConfig,
    missingFirebaseCredentialNames,
} from '../lib/research-persistence/config.ts';
import {
    getAdminInitError,
    getFirebaseInitPath,
    getFirebaseProjectIdSafe,
    getFirebaseStatus,
    getResearchFirestore,
    isFirebaseAdminReady,
    verifyFirestoreConnectivity,
} from '../lib/research-persistence/admin.ts';

async function main(): Promise<void> {
    const cfg = loadResearchPersistenceConfig();
    const missing = missingFirebaseCredentialNames();
    const hasPrimary = hasPrimaryFirebaseCredentials();

    console.log(
        JSON.stringify(
            {
                configured_mode: cfg.configured_mode,
                effective_repository_mode: cfg.mode,
                used_legacy_alias: cfg.used_legacy_alias,
                env_conflict: cfg.env_conflict,
                env_conflict_message: cfg.env_conflict_message,
                has_primary_firebase_credentials: hasPrimary,
                missing_env_names: missing,
                google_application_credentials_set: Boolean(
                    process.env.GOOGLE_APPLICATION_CREDENTIALS,
                ),
                firebase_status: getFirebaseStatus(),
                cutover_gate:
                    hasPrimary && !cfg.env_conflict
                        ? 'READY_FOR_DUAL'
                        : 'STOP_BEFORE_DUAL',
            },
            null,
            2,
        ),
    );

    if (!hasPrimary) {
        console.log(
            '\nSTOP: Render Firebase credentials not set. Missing env names only:',
        );
        for (const n of missing) console.log(`  - ${n}`);
        console.log(
            'Set RESEARCH_REPOSITORY_MODE=dual|firestore only after credentials are configured.',
        );
        process.exitCode = 2;
        return;
    }

    // Attempt init (no secret logging)
    const db = getResearchFirestore();
    const connected = db ? await verifyFirestoreConnectivity() : false;
    console.log(
        JSON.stringify(
            {
                firestore_initialized: isFirebaseAdminReady(),
                firestore_reachable_attempt: db != null,
                firestore_connected: connected,
                firebase_status: getFirebaseStatus(),
                project_id: getFirebaseProjectIdSafe(),
                init_path: getFirebaseInitPath(),
                init_error: getAdminInitError(),
            },
            null,
            2,
        ),
    );
    if (!connected) process.exitCode = 1;
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
