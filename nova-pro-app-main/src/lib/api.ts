// src/lib/api.ts

import { getApiBase, isHostedApi } from './runtime';

const base = getApiBase();

const HOSTED = isHostedApi();
const DEFAULT_GET_MS = HOSTED ? 20_000 : 12_000;
const DEFAULT_POST_MS = HOSTED ? 25_000 : 15_000;

function isAbort(e: unknown): boolean {
    return (
        (e instanceof DOMException && e.name === 'AbortError') ||
        (e instanceof Error && e.name === 'AbortError')
    );
}

// surface the server's {detail} error message when present
async function fail(res: Response): Promise<never> {
    let detail = '';
    try {
        const body = (await res.json()) as {
            detail?: string;
            error?: string;
            message?: string;
        };
        detail = body.detail || body.error || body.message || '';
    } catch {
        // non-JSON error body
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
}

async function withTimeout<T>(
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await run(ctrl.signal);
    } catch (e) {
        if (isAbort(e)) {
            throw new Error(
                HOSTED ? '請求逾時，伺服器可能還在喚醒' : '請求逾時',
            );
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

function isRetryableStatus(msg: string): boolean {
    return /502|503|Bad Gateway|Service Unavailable/i.test(msg);
}

export async function apiGet<T>(path: string, timeoutMs?: number): Promise<T> {
    const ms = timeoutMs ?? DEFAULT_GET_MS;
    const once = () =>
        withTimeout(ms, async (signal) => {
            const res = await fetch(base + path, { signal });
            if (!res.ok) {
                await fail(res);
            }
            return res.json() as Promise<T>;
        });
    try {
        return await once();
    } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        if (!HOSTED || !isRetryableStatus(msg)) throw e;
        await new Promise((r) => setTimeout(r, 800));
        return await once();
    }
}

export async function apiPost<T>(
    path: string,
    body: unknown,
    timeoutMs?: number,
): Promise<T> {
    const ms = timeoutMs ?? DEFAULT_POST_MS;
    return withTimeout(ms, async (signal) => {
        const res = await fetch(base + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
        });
        if (!res.ok) {
            await fail(res);
        }
        return res.json() as Promise<T>;
    });
}

export async function apiPut<T>(
    path: string,
    body: unknown,
    timeoutMs?: number,
): Promise<T> {
    const ms = timeoutMs ?? DEFAULT_POST_MS;
    return withTimeout(ms, async (signal) => {
        const res = await fetch(base + path, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
        });
        if (!res.ok) {
            await fail(res);
        }
        return res.json() as Promise<T>;
    });
}
