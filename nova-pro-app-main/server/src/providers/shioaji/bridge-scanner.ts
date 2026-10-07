// Market-wide rankings straight from the Shioaji bridge, usable while another
// provider (Fugle) serves realtime quotes. The bridge runs in the same container
// whenever SHIOAJI keys are set, independent of which provider is active.

import type { ScannerItem, ScannerType } from '../../types/dto.ts';

const BRIDGE =
    process.env.SHIOAJI_BRIDGE_URL?.replace(/\/$/, '') ||
    'http://127.0.0.1:18080';

/** Empty array on any failure — callers fall back to their own source. */
export async function fetchShioajiScanner(
    type: ScannerType,
    count: number,
    ascending: boolean,
    timeoutMs = 8_000,
): Promise<ScannerItem[]> {
    try {
        const res = await fetch(`${BRIDGE}/scanner`, {
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
