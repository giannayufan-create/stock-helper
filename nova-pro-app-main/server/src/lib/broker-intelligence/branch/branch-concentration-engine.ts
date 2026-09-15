// server/src/lib/broker-intelligence/branch/branch-concentration-engine.ts

import type { BrokerIntelligenceConfig } from '../config.ts';
import type { BranchDayBundle, ConcentrationReport } from '../types.ts';

export function computeConcentration(
    bundle: BranchDayBundle,
    cfg: BrokerIntelligenceConfig,
): ConcentrationReport {
    const empty: ConcentrationReport = {
        symbol: bundle.symbol,
        trade_date: bundle.trade_date || null,
        total_positive_net_buy: 0,
        top1_positive_net_buy: 0,
        top3_positive_net_buy: 0,
        top5_positive_net_buy: 0,
        concentration_top1: null,
        concentration_top3: null,
        concentration_top5: null,
        branch_count: 0,
        positive_branch_count: 0,
        negative_branch_count: 0,
        eligible_for_ranking: false,
    };
    if (!bundle.available || !bundle.rows.length) return empty;

    const positive = [...bundle.rows]
        .filter((r) => r.net_volume > 0)
        .sort((a, b) => b.net_volume - a.net_volume);
    const negative = bundle.rows.filter((r) => r.net_volume < 0);
    const totalPos = positive.reduce((a, r) => a + r.net_volume, 0);
    const top1 = positive.slice(0, 1).reduce((a, r) => a + r.net_volume, 0);
    const top3 = positive.slice(0, 3).reduce((a, r) => a + r.net_volume, 0);
    const top5 = positive.slice(0, 5).reduce((a, r) => a + r.net_volume, 0);
    const totalVol = bundle.rows.reduce(
        (a, r) => a + Math.abs(r.buy_volume) + Math.abs(r.sell_volume),
        0,
    );

    const g = cfg.ranking_guards;
    const eligible =
        totalVol >= g.min_total_branch_volume &&
        totalPos >= g.min_positive_volume &&
        positive.length >= g.min_active_branches;

    const pct = (n: number) =>
        totalPos > 0 ? Math.round((n / totalPos) * 1000) / 10 : null;

    return {
        symbol: bundle.symbol,
        trade_date: bundle.trade_date || null,
        total_positive_net_buy: totalPos,
        top1_positive_net_buy: top1,
        top3_positive_net_buy: top3,
        top5_positive_net_buy: top5,
        concentration_top1: pct(top1),
        concentration_top3: pct(top3),
        concentration_top5: pct(top5),
        branch_count: bundle.rows.length,
        positive_branch_count: positive.length,
        negative_branch_count: negative.length,
        eligible_for_ranking: eligible,
    };
}
