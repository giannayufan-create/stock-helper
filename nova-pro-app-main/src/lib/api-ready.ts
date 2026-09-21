// src/lib/api-ready.ts — connection phase for UI / AI buttons.

export type ApiPhase = 'idle' | 'waking' | 'ready' | 'down';

let phase: ApiPhase = 'idle';
let startedAt = 0;
const listeners = new Set<() => void>();

function setPhase(next: ApiPhase) {
    if (phase === next) return;
    phase = next;
    listeners.forEach((fn) => fn());
}

export function getApiPhase(): ApiPhase {
    return phase;
}

export function getWakeElapsedMs(): number {
    return startedAt ? Date.now() - startedAt : 0;
}

export function subscribeApiPhase(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function markApiReady(): void {
    setPhase('ready');
}

export function markApiDown(): void {
    setPhase('down');
}

export function beginApiLoad(): void {
    if (phase === 'ready') return;
    if (!startedAt) startedAt = Date.now();
    setPhase('waking');
}

export function retryApiReady(): Promise<boolean> {
    if (phase === 'ready') return Promise.resolve(true);
    phase = 'idle';
    startedAt = Date.now();
    return Promise.resolve(false);
}

export function startApiWarmup(): void {
    if (!startedAt) startedAt = Date.now();
}
