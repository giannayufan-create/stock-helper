// src/lib/firebase.ts — Firebase app + anonymous auth for cloud sync

import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
    getAuth,
    onAuthStateChanged,
    signInAnonymously,
    type Auth,
    type User,
} from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

const firebaseConfig = {
    apiKey: 'AIzaSyDSUG70ql_4sVabQ2Ts4pgSQAhndiAu6k0',
    authDomain: 'stock-helper-11279.firebaseapp.com',
    projectId: 'stock-helper-11279',
    storageBucket: 'stock-helper-11279.firebasestorage.app',
    messagingSenderId: '762338957446',
    appId: '1:762338957446:web:98223b6988b558577f1907',
    measurementId: 'G-J055TJC3WT',
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;
let ready: Promise<User | null> | null = null;

export function getFirebaseApp(): FirebaseApp {
    if (!app) app = initializeApp(firebaseConfig);
    return app;
}

export function getFirebaseAuth(): Auth {
    if (!auth) auth = getAuth(getFirebaseApp());
    return auth;
}

export function getDb(): Firestore {
    if (!db) db = getFirestore(getFirebaseApp());
    return db;
}

/** Ensure anonymous session; returns uid or null if Auth not enabled yet. */
export function ensureFirebaseUser(): Promise<User | null> {
    if (!ready) {
        ready = new Promise((resolve) => {
            const a = getFirebaseAuth();
            const unsub = onAuthStateChanged(a, async (user) => {
                unsub();
                if (user) {
                    resolve(user);
                    return;
                }
                try {
                    const cred = await signInAnonymously(a);
                    resolve(cred.user);
                } catch (err) {
                    console.warn('[firebase] anonymous sign-in failed', err);
                    resolve(null);
                }
            });
        });
    }
    return ready;
}

export async function getUid(): Promise<string | null> {
    const user = await ensureFirebaseUser();
    return user?.uid ?? null;
}
