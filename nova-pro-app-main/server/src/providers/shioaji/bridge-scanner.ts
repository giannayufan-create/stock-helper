// Market-wide rankings straight from the Shioaji bridge, usable while another
// provider (Fugle) serves realtime quotes. The bridge runs in the same container
// whenever SHIOAJI keys are set, independent of which provider is active.

import type { ScannerItem, ScannerType } from '../../types/dto.ts';

const bridgeUrl = () =>
    process.env.SHIOAJI_BRIDGE_URL?.replace(/\/$/, '') || 'http://127.0.0.1:18080';

/** Empty array on any failure — callers fall back to their own source. */
export async function fetchShioajiScanner(
    type: ScannerType,
    count: number,
    ascending: boolean,
    timeoutMs = 8_000,
): Promise<ScannerItem[]> {
    try {
        const res = await fetch(`${bridgeUrl()}/scanner`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scanner_type: type, count, ascending }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return [];
        const rows = (await res.json()) as unknown;
        return Array.isArray(rows) ? (rows as ScannerItem[]) : [];
    } catch {
        return [];
    }
}

export interface ShioajiUsage {
    available: boolean;
    connections?: number;
    bytes?: number;
    limit_bytes?: number;
    remaining_bytes?: number;
    error?: string;
}

/** Daily data-traffic quota (resets 08:00 on trading days); null when the bridge is unreachable. */
export async function fetchShioajiUsage(timeoutMs = 5_000): Promise<ShioajiUsage | null> {
    try {
        const res = await fetch(`${bridgeUrl()}/usage`, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return null;
        return (await res.json()) as ShioajiUsage;
    } catch {
        return null;
    }
}

const OPTIONAL_MIN_REMAINING = 0.2;
const USAGE_TTL_MS = 5 * 60_000;
let usageCache: { at: number; ok: boolean } | null = null;

/**
 * Optional Shioaji calls (comparison rows, tick-count ranking) only while at least
 * 20% of the daily traffic quota remains; unknown usage counts as allowed.
 */
export async function shioajiOptionalAllowed(now = Date.now()): Promise<boolean> {
    if (usageCache && now - usageCache.at < USAGE_TTL_MS && now >= usageCache.at) return usageCache.ok;
    const u = await fetchShioajiUsage();
    const limit = Number(u?.limit_bytes) || 0;
    const ok = !u?.available || !limit || Number(u.remaining_bytes) / limit >= OPTIONAL_MIN_REMAINING;
    usageCache = { at: now, ok };
    return ok;
}

export function resetShioajiUsageCache(): void {
    usageCache = null;
}

/** Subset of the bridge /snapshots row; volumes are in lots (張). */
export interface BridgeSnapshot {
    code: string;
    close: number;
    high: number;
    buy_price: number;
    buy_volume: number;
    sell_price: number;
    sell_volume: number;
    total_volume: number;
    change_rate: number;
}

/** Best bid/ask snapshot for up to 500 stocks in one call; empty array on any failure. */
export async function fetchShioajiSnapshots(
    codes: readonly string[],
    timeoutMs = 8_000,
): Promise<BridgeSnapshot[]> {
    if (!codes.length) return [];
    try {
        const res = await fetch(`${bridgeUrl()}/snapshots`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contracts: codes.slice(0, 500).map((code) => ({ security_type: 'STK', exchange: null, code })),
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return [];
        const rows = (await res.json()) as unknown;
        return Array.isArray(rows) ? (rows as BridgeSnapshot[]) : [];
    } catch {
        return [];
    }
}
