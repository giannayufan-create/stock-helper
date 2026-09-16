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
    getResearchFirestore,
    isFirebaseAdminReady,
} from '../lib/research-persistence/admin.ts';

function main(): void {
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
            'Set RESEARCH_REPOSITORY=dual only after credentials are configured.',
        );
        process.exitCode = 2;
        return;
    }

    // Attempt init (no secret logging)
    const db = getResearchFirestore();
    console.log(
        JSON.stringify(
            {
                firestore_initialized: isFirebaseAdminReady(),
                firestore_reachable_attempt: db != null,
                project_id: getFirebaseProjectIdSafe(),
                init_path: getFirebaseInitPath(),
                init_error: getAdminInitError(),
            },
            null,
            2,
        ),
    );
}

main();
