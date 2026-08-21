// src/lib/cloud-sync.ts — sync prediction book + backtest journal to Firestore

import {
    doc,
    getDoc,
    setDoc,
    serverTimestamp,
} from 'firebase/firestore';
import { getDb, getUid } from './firebase';
import {
    loadPredictions,
    savePredictions,
    type PredictionRecord,
} from './prediction-book';
import { loadBacktestJournal } from './backtest-journal';

export type SyncStatus =
    | 'idle'
    | 'syncing'
    | 'ok'
    | 'offline'
    | 'need-setup'
    | 'error';

let lastStatus: SyncStatus = 'idle';
let lastError = '';

export function getSyncStatus() {
    return { status: lastStatus, error: lastError };
}

export async function pullCloudPredictions(): Promise<PredictionRecord[] | null> {
    const uid = await getUid();
    if (!uid) {
        lastStatus = 'need-setup';
        return null;
    }
    try {
        lastStatus = 'syncing';
        const snap = await getDoc(doc(getDb(), 'users', uid, 'data', 'predictions'));
        if (!snap.exists()) {
            lastStatus = 'ok';
            return null;
        }
        const rows = snap.data()?.rows;
        if (!Array.isArray(rows)) {
            lastStatus = 'ok';
            return null;
        }
        const cleaned = rows.filter(
            (row): row is PredictionRecord =>
                typeof row?.id === 'string' && typeof row?.code === 'string',
        );
        savePredictions(cleaned);
        lastStatus = 'ok';
        return cleaned;
    } catch (err) {
        lastStatus = 'error';
        lastError = err instanceof Error ? err.message : String(err);
        console.warn('[cloud-sync] pull predictions failed', err);
        return null;
    }
}

export async function pushCloudPredictions(
    rows: PredictionRecord[],
): Promise<boolean> {
    const uid = await getUid();
    if (!uid) {
        lastStatus = 'need-setup';
        return false;
    }
    try {
        lastStatus = 'syncing';
        await setDoc(
            doc(getDb(), 'users', uid, 'data', 'predictions'),
            { rows, updatedAt: serverTimestamp() },
            { merge: true },
        );
        lastStatus = 'ok';
        return true;
    } catch (err) {
        lastStatus = 'error';
        lastError = err instanceof Error ? err.message : String(err);
        console.warn('[cloud-sync] push predictions failed', err);
        return false;
    }
}

export async function pushCloudBacktest(): Promise<boolean> {
    const uid = await getUid();
    if (!uid) return false;
    try {
        const state = loadBacktestJournal();
        await setDoc(
            doc(getDb(), 'users', uid, 'data', 'backtest'),
            { ...state, updatedAt: serverTimestamp() },
            { merge: true },
        );
        return true;
    } catch (err) {
        console.warn('[cloud-sync] push backtest failed', err);
        return false;
    }
}

export async function pullCloudBacktest(): Promise<boolean> {
    const uid = await getUid();
    if (!uid) return false;
    try {
        const snap = await getDoc(doc(getDb(), 'users', uid, 'data', 'backtest'));
        if (!snap.exists()) return false;
        const data = snap.data();
        if (!data) return false;
        localStorage.setItem(
            'nova-backtest-journal-v1',
            JSON.stringify({
                entries: Array.isArray(data.entries) ? data.entries : [],
                positions:
                    data.positions && typeof data.positions === 'object'
                        ? data.positions
                        : {},
                realizedPnl:
                    data.realizedPnl && typeof data.realizedPnl === 'object'
                        ? data.realizedPnl
                        : {},
            }),
        );
        return true;
    } catch (err) {
        console.warn('[cloud-sync] pull backtest failed', err);
        return false;
    }
}

/** First load: pull cloud → merge into local if cloud has data. */
export async function bootstrapCloudSync(): Promise<PredictionRecord[] | null> {
    const local = loadPredictions();
    const cloud = await pullCloudPredictions();
    await pullCloudBacktest();
    if (cloud && cloud.length > 0) return cloud;
    if (local.length > 0) {
        await pushCloudPredictions(local);
        await pushCloudBacktest();
    }
    return null;
}
