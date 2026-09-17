// server/src/lib/research-persistence/admin.ts
// Single Firebase Admin app — never initialize a second instance.

import { createRequire } from 'node:module';
import type { App } from 'firebase-admin/app';
import type { Firestore } from 'firebase-admin/firestore';
import { hasPrimaryFirebaseCredentials } from './config.ts';
import {
    RESEARCH_DIAGNOSTICS_COLLECTION,
    type FirebaseAdminStatus,
} from './types.ts';

export type { FirebaseAdminStatus } from './types.ts';

const require = createRequire(import.meta.url);

let app: App | null = null;
let db: Firestore | null = null;
let initError: string | null = null;
let tried = false;
let initializing = false;
let resolvedProjectId: string | null = null;
let initPath: 'cert_env' | 'adc' | 'existing_app' | null = null;
/** True only after a successful Firestore read/write — not after SDK import alone. */
let firestoreOpOk = false;

export function getAdminInitError(): string | null {
    return initError;
}

export function isFirebaseAdminReady(): boolean {
    return db != null;
}

/** Project id only — never secrets. */
export function getFirebaseProjectIdSafe(): string | null {
    return resolvedProjectId;
}

export function getFirebaseInitPath(): typeof initPath {
    return initPath;
}

/**
 * Distinguishes credential presence / init / live connectivity.
 * CONNECTED requires a successful Firestore op — never SDK import alone.
 */
export function getFirebaseStatus(): FirebaseAdminStatus {
    if (initializing) return 'FIREBASE_INITIALIZING';
    if (initError) return 'FIREBASE_ERROR';
    if (!tried) {
        if (
            !hasPrimaryFirebaseCredentials() &&
            !process.env.GOOGLE_APPLICATION_CREDENTIALS
        ) {
            return 'FIREBASE_NOT_CONFIGURED';
        }
        return 'FIREBASE_NOT_CONFIGURED';
    }
    if (!db) {
        return hasPrimaryFirebaseCredentials() ||
            process.env.GOOGLE_APPLICATION_CREDENTIALS
            ? 'FIREBASE_ERROR'
            : 'FIREBASE_NOT_CONFIGURED';
    }
    return firestoreOpOk ? 'FIREBASE_CONNECTED' : 'FIREBASE_INITIALIZING';
}

export function markFirestoreOpSuccess(): void {
    firestoreOpOk = true;
    initError = null;
}

export function markFirestoreOpFailure(message: string): void {
    firestoreOpOk = false;
    initError = message.slice(0, 200);
}

/**
 * Lazy-init Admin SDK once.
 * Primary: FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 * Fallback: GOOGLE_APPLICATION_CREDENTIALS / ADC
 * Never logs credential values.
 */
export function getResearchFirestore(): Firestore | null {
    if (db) return db;
    if (tried) return null;
    tried = true;
    initializing = true;
    try {
        const admin = require('firebase-admin') as typeof import('firebase-admin');
        if (admin.apps.length > 0) {
            app = admin.apps[0]!;
            db = admin.firestore();
            initPath = 'existing_app';
            resolvedProjectId =
                process.env.FIREBASE_PROJECT_ID ??
                process.env.GCLOUD_PROJECT ??
                null;
            initializing = false;
            return db;
        }

        const projectId =
            process.env.FIREBASE_PROJECT_ID ??
            process.env.GCLOUD_PROJECT ??
            process.env.GOOGLE_CLOUD_PROJECT;
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
        const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
        // Render stores PEMs with literal \n — normalize once at credential init only.
        const privateKey = privateKeyRaw
            ? privateKeyRaw.replace(/\\n/g, '\n')
            : undefined;

        // Prefer explicit Render env credentials
        if (clientEmail && privateKey && projectId) {
            app = admin.initializeApp({
                credential: admin.credential.cert({
                    projectId,
                    clientEmail,
                    privateKey,
                }),
                projectId,
            });
            initPath = 'cert_env';
            resolvedProjectId = projectId;
        } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            app = admin.initializeApp({
                credential: admin.credential.applicationDefault(),
                projectId: projectId || undefined,
            });
            initPath = 'adc';
            resolvedProjectId = projectId ?? null;
            console.warn(
                '[research-persistence] using GOOGLE_APPLICATION_CREDENTIALS fallback — prefer FIREBASE_* env for Render',
            );
        } else {
            initError =
                'Firebase Admin credentials unavailable — set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY';
            initializing = false;
            return null;
        }
        db = admin.firestore();
        initializing = false;
        return db;
    } catch (err) {
        initError = err instanceof Error ? err.message : String(err);
        initializing = false;
        console.warn(
            '[research-persistence] Firebase Admin init failed:',
            initError.slice(0, 120),
        );
        return null;
    }
}

/**
 * Live connectivity probe — writes/reads research_diagnostics only.
 * Never touches strategy_signals. Never logs secrets.
 */
export async function verifyFirestoreConnectivity(): Promise<boolean> {
    const firestore = getResearchFirestore();
    if (!firestore) {
        markFirestoreOpFailure(initError ?? 'Firestore unavailable');
        return false;
    }
    try {
        const id = `health_${Date.now().toString(36)}`;
        const ref = firestore
            .collection(RESEARCH_DIAGNOSTICS_COLLECTION)
            .doc(id);
        await ref.set({
            diagnostic: true,
            learning_eligible: false,
            purpose: 'startup_connectivity_probe',
            created_at: new Date().toISOString(),
        });
        const snap = await ref.get();
        if (!snap.exists) {
            markFirestoreOpFailure('connectivity probe read miss');
            return false;
        }
        markFirestoreOpSuccess();
        return true;
    } catch (err) {
        markFirestoreOpFailure(
            err instanceof Error ? err.message : String(err),
        );
        return false;
    }
}

/** Test-only reset. */
export function __resetAdminForTests(): void {
    app = null;
    db = null;
    initError = null;
    tried = false;
    initializing = false;
    resolvedProjectId = null;
    initPath = null;
    firestoreOpOk = false;
}
