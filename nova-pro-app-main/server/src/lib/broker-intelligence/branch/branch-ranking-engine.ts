// server/src/lib/broker-intelligence/branch/branch-ranking-engine.ts

import type { BranchDayBundle, BranchTradeRow } from '../types.ts';

export function rankBuyBranches(
    bundle: BranchDayBundle,
    limit = 10,
): BranchTradeRow[] {
    if (!bundle.available) return [];
    return [...bundle.rows]
        .filter((r) => r.net_volume > 0)
        .sort((a, b) => b.net_volume - a.net_volume)
        .slice(0, limit);
}

export function rankSellBranches(
    bundle: BranchDayBundle,
    limit = 10,
): BranchTradeRow[] {
    if (!bundle.available) return [];
    return [...bundle.rows]
        .filter((r) => r.net_volume < 0)
        .sort((a, b) => a.net_volume - b.net_volume)
        .slice(0, limit);
}
