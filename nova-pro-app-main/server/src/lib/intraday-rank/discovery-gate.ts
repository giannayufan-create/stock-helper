// server/src/lib/intraday-rank/discovery-gate.ts
// B-lite eligibility — NOT full Open Gate (esp. after 09:30)

import type { DataHealthService } from '../open-gate-v2/data-health.ts';
import type { MarketDataEngine } from '../open-gate-v2/market-data-engine.ts';
import type { IntradayRankConfig } from './config.ts';
import type { DiscoveryItem, EligibilityStatus } from './types.ts';

export interface EligibilityResult {
    status: EligibilityStatus;
    reasons: string[];
    risks: string[];
}

export function runDiscoveryGate(opts: {
    cfg: IntradayRankConfig;
    item: DiscoveryItem;
    engine: MarketDataEngine;
    health: DataHealthService;
    dispositionCodes: Set<string>;
    /** Strategy clock ms — required for DataHealth age. */
    nowMs: number;
}): EligibilityResult {
    const { cfg, item, engine, health, dispositionCodes, nowMs } = opts;
    const reasons: string[] = [];
    const risks: string[] = [];
    const report = health.report(item.symbol, nowMs);

    if (report.data_blocked || report.health === 'disconnected') {
        return {
            status: 'blocked',
            reasons,
            risks: [`DATA ${report.health}`],
        };
    }

    if (dispositionCodes.has(item.symbol)) {
        return {
            status: 'blocked',
            reasons,
            risks: ['處置／交易限制'],
        };
    }

    const st = engine.getState(item.symbol);
    if (st && st.last_price <= 0 && st.tick_count === 0) {
        // not subscribed yet — watch until stream fills
        return {
            status: 'watch',
            reasons: ['待訂閱行情'],
            risks,
        };
    }

    if (st) {
        const mid =
            st.best_bid > 0 && st.best_ask > 0
                ? (st.best_bid + st.best_ask) / 2
                : st.last_price;
        const spread =
            st.best_bid > 0 && st.best_ask > 0 && mid > 0
                ? ((st.best_ask - st.best_bid) / mid) * 100
                : null;
        if (spread != null && spread > cfg.eligibility.max_spread_pct * 2) {
            return {
                status: 'blocked',
                reasons,
                risks: [`價差過大 ${spread.toFixed(2)}%`],
            };
        }
        if (spread != null && spread > cfg.eligibility.max_spread_pct) {
            risks.push(`價差偏大 ${spread.toFixed(2)}%`);
        }
        const turn = st.total_amount || st.turnover;
        if (turn > 0 && turn < cfg.eligibility.min_turnover) {
            risks.push('成交額偏低');
            return { status: 'watch', reasons, risks };
        }
        if (
            st.tick_count > 0 &&
            st.tick_count < cfg.eligibility.min_tick_count
        ) {
            risks.push('tick 偏少');
        }
        if (st.last_price > 0) reasons.push('行情有效');
    } else if ((item.total_amount ?? 0) < cfg.eligibility.min_turnover) {
        // pre-stream filter using scanner totals when available
        if (item.total_amount != null && item.total_amount > 0) {
            return {
                status: 'watch',
                reasons,
                risks: ['scanner 成交額偏低'],
            };
        }
    }

    if (report.health === 'degraded' || report.health === 'stale') {
        risks.push(`DATA ${report.health}`);
        return { status: 'watch', reasons, risks };
    }

    reasons.push('通過 Discovery Gate');
    return { status: 'eligible', reasons, risks };
}
