// server/src/lib/research-persistence/admin.ts
// Single Firebase Admin app — never initialize a second instance.

import type { App } from 'firebase-admin/app';
import type { Firestore } from 'firebase-admin/firestore';

let app: App | null = null;
let db: Firestore | null = null;
let initError: string | null = null;
let tried = false;

export function getAdminInitError(): string | null {
    return initError;
}

export function isFirebaseAdminReady(): boolean {
    return db != null;
}

/**
 * Lazy-init Admin SDK once.
 * Credentials from env only — never from committed files.
 * Env names (values never logged):
 *   FIREBASE_PROJECT_ID
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY
 *   GOOGLE_APPLICATION_CREDENTIALS (path via platform secret mount)
 */
export function getResearchFirestore(): Firestore | null {
    if (db) return db;
    if (tried) return null;
    tried = true;
    try {
        // Dynamic import keeps jsonl-only boots light if package missing
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const admin = require('firebase-admin') as typeof import('firebase-admin');
        if (admin.apps.length > 0) {
            app = admin.apps[0]!;
            db = admin.firestore();
            return db;
        }

        const projectId =
            process.env.FIREBASE_PROJECT_ID ??
            process.env.GCLOUD_PROJECT ??
            process.env.GOOGLE_CLOUD_PROJECT;
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
        const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
        const privateKey = privateKeyRaw
            ? privateKeyRaw.replace(/\\n/g, '\n')
            : undefined;

        if (clientEmail && privateKey && projectId) {
            app = admin.initializeApp({
                credential: admin.credential.cert({
                    projectId,
                    clientEmail,
                    privateKey,
                }),
                projectId,
            });
        } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS || projectId) {
            // ADC / Render secret file
            app = admin.initializeApp({
                credential: admin.credential.applicationDefault(),
                projectId: projectId || undefined,
            });
        } else {
            initError =
                'Firebase Admin credentials unavailable (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY or GOOGLE_APPLICATION_CREDENTIALS)';
            return null;
        }
        db = admin.firestore();
        return db;
    } catch (err) {
        initError = err instanceof Error ? err.message : String(err);
        // Never log secret material
        console.warn(
            '[research-persistence] Firebase Admin init failed:',
            initError.slice(0, 120),
        );
        return null;
    }
}

/** Test-only reset. */
export function __resetAdminForTests(): void {
    app = null;
    db = null;
    initError = null;
    tried = false;
}
