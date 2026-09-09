// src/lib/screener-store.ts — survive remounts (memory + sessionStorage)

import type { StrategyMode } from './prediction-book';

const KEY = 'nova-screener-cache-v2';

export interface ScreenerStorePayload {
    mode: StrategyMode;
    scannedMode: StrategyMode;
    includeWatchlist: boolean;
    rows: unknown[];
    status: string;
    at: number;
}

/** In-memory copy — survives React remount even if sessionStorage fails */
let memory: ScreenerStorePayload | null = null;

function readDisk(): ScreenerStorePayload | null {
    try {
        const raw = sessionStorage.getItem(KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as ScreenerStorePayload;
        if (!parsed || !Array.isArray(parsed.rows)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function writeDisk(payload: ScreenerStorePayload) {
    try {
        sessionStorage.setItem(KEY, JSON.stringify(payload));
    } catch {
        // private mode / quota
    }
}

export function loadScreenerStore(): ScreenerStorePayload | null {
    if (memory && Array.isArray(memory.rows) && memory.rows.length > 0) {
        return memory;
    }
    const disk = readDisk();
    if (disk) memory = disk;
    return memory ?? disk;
}

/**
 * Persist results. Never overwrite a non-empty store with an empty one
 * unless `allowEmpty` is true (explicit clear / failed scan).
 */
export function saveScreenerStore(
    payload: ScreenerStorePayload,
    opts?: { allowEmpty?: boolean },
) {
    const allowEmpty = opts?.allowEmpty === true;
    if (
        !allowEmpty &&
        payload.rows.length === 0 &&
        memory &&
        memory.rows.length > 0
    ) {
        // Keep previous results; only update mode flags if needed
        memory = {
            ...memory,
            mode: payload.mode,
            includeWatchlist: payload.includeWatchlist,
            at: Date.now(),
        };
        writeDisk(memory);
        return;
    }
    memory = payload;
    writeDisk(payload);
}

/** @deprecated use loadScreenerStore */
export function loadScreenerCache() {
    return loadScreenerStore();
}

/** @deprecated use saveScreenerStore */
export function saveScreenerCache(payload: ScreenerStorePayload) {
    saveScreenerStore(payload);
}
