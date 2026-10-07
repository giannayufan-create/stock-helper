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
