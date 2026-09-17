// src/lib/api.ts

import { getApiBase } from './runtime';

const base = getApiBase();

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

export async function apiGet<T>(path: string, timeoutMs?: number): Promise<T> {
    const ctrl = timeoutMs ? new AbortController() : null;
    const timer =
        ctrl && timeoutMs
            ? setTimeout(() => ctrl.abort(), timeoutMs)
            : null;
    try {
        const res = await fetch(base + path, {
            signal: ctrl?.signal,
        });
        if (!res.ok) {
            await fail(res);
        }
        return res.json() as Promise<T>;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        await fail(res);
    }
    return res.json() as Promise<T>;
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(base + path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        await fail(res);
    }
    return res.json() as Promise<T>;
}
