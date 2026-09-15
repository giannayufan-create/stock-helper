// server/src/lib/broker-intelligence/branch/branch-history-engine.ts

import type { BrokerIntelligenceConfig } from '../config.ts';
import type {
    BranchDayBundle,
    BranchHistoryReport,
    BranchHistoryRow,
    BranchTradeRow,
} from '../types.ts';

function keyOf(r: Pick<BranchTradeRow, 'broker_id' | 'branch_id'>): string {
    return `${r.broker_id}::${r.branch_id}`;
}

function consecutiveFromNewest(
    nets: Array<{ date: string; net: number }>,
    side: 'buy' | 'sell',
): number {
    const sorted = [...nets].sort((a, b) => (a.date < b.date ? 1 : -1));
    let n = 0;
    for (const d of sorted) {
        const ok = side === 'buy' ? d.net > 0 : d.net < 0;
        if (!ok) break;
        n++;
    }
    return n;
}

export function buildBranchHistory(
    symbol: string,
    days: BranchDayBundle[],
    requestedDays: number,
    cfg: BrokerIntelligenceConfig,
): BranchHistoryReport {
    const available = days
        .filter((d) => d.available && d.trade_date)
        .sort((a, b) => (a.trade_date < b.trade_date ? 1 : -1));

    const sample = available.slice(0, requestedDays);
    const sample_days = sample.map((d) => d.trade_date);
    const available_days = sample_days.length;

    let insufficient = false;
    if (requestedDays >= 20) {
        insufficient =
            available_days < cfg.ranking_guards.min_coverage_days_for_20d;
    } else if (requestedDays >= 10) {
        insufficient =
            available_days < cfg.ranking_guards.min_coverage_days_for_10d;
    } else if (requestedDays >= 5) {
        insufficient = available_days < 3;
    } else if (requestedDays >= 3) {
        insufficient = available_days < 2;
    }

    if (!sample.length) {
        return {
            symbol,
            requested_days: requestedDays,
            available_days: 0,
            sample_days: [],
            data_coverage: 0,
            insufficient: true,
            rows: [],
            freshness: 'UNKNOWN',
            source: 'none',
        };
    }

    const byBranch = new Map<
        string,
        {
            meta: BranchTradeRow;
            nets: Array<{ date: string; net: number; buy: number; sell: number }>;
        }
    >();

    for (const day of sample) {
        for (const r of day.rows) {
            const k = keyOf(r);
            const hit = byBranch.get(k);
            if (!hit) {
                byBranch.set(k, {
                    meta: r,
                    nets: [
                        {
                            date: day.trade_date,
                            net: r.net_volume,
                            buy: r.buy_volume,
                            sell: r.sell_volume,
                        },
                    ],
                });
            } else {
                hit.nets.push({
                    date: day.trade_date,
                    net: r.net_volume,
                    buy: r.buy_volume,
                    sell: r.sell_volume,
                });
            }
        }
    }

    const rows: BranchHistoryRow[] = [];
    for (const [, v] of byBranch) {
        const buy_volume = v.nets.reduce((a, x) => a + x.buy, 0);
        const sell_volume = v.nets.reduce((a, x) => a + x.sell, 0);
        const net_volume = v.nets.reduce((a, x) => a + x.net, 0);
        const days_buying = v.nets.filter((x) => x.net > 0).length;
        const days_selling = v.nets.filter((x) => x.net < 0).length;
        const dates = v.nets.map((x) => x.date).sort();
        rows.push({
            broker_id: v.meta.broker_id,
            broker_name: v.meta.broker_name,
            branch_id: v.meta.branch_id,
            branch_name: v.meta.branch_name,
            buy_volume,
            sell_volume,
            net_volume,
            days_buying,
            days_selling,
            consecutive_buy_days: consecutiveFromNewest(v.nets, 'buy'),
            consecutive_sell_days: consecutiveFromNewest(v.nets, 'sell'),
            active_days: v.nets.length,
            first_seen: dates[0] ?? null,
            last_seen: dates[dates.length - 1] ?? null,
        });
    }

    rows.sort((a, b) => b.net_volume - a.net_volume);

    return {
        symbol,
        requested_days: requestedDays,
        available_days,
        sample_days,
        data_coverage:
            requestedDays > 0
                ? Math.round((available_days / requestedDays) * 1000) / 10
                : 0,
        insufficient,
        rows,
        freshness: sample[0]?.freshness ?? 'UNKNOWN',
        source: sample[0]?.source ?? 'unknown',
    };
}
