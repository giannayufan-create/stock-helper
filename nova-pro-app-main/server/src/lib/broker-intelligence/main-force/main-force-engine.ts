// server/src/lib/broker-intelligence/main-force/main-force-engine.ts

import type { BrokerIntelligenceConfig } from '../config.ts';
import type {
    BiConfidence,
    BranchHistoryReport,
    ConcentrationReport,
    MainForceEstimate,
} from '../types.ts';

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

export function estimateMainForce(opts: {
    concentration: ConcentrationReport | null;
    history: BranchHistoryReport | null;
    cfg: BrokerIntelligenceConfig;
}): MainForceEstimate {
    const base: MainForceEstimate = {
        score: null,
        label: 'UNKNOWN',
        method: 'branch_concentration_estimate',
        inferred: true,
        confidence: 'LOW',
        reasons: [],
    };

    const c = opts.concentration;
    if (!c || c.concentration_top3 == null) {
        base.reasons.push('無分點集中度資料');
        return base;
    }

    const w = opts.cfg.main_force;
    const top3 = clamp(c.concentration_top3, 0, 100);
    const top5 = clamp(c.concentration_top5 ?? top3, 0, 100);

    let persistence = 50;
    let consistency = 50;
    const h = opts.history;
    if (h && !h.insufficient && h.rows.length) {
        const leader = h.rows[0]!;
        persistence = clamp(leader.consecutive_buy_days * 20, 0, 100);
        consistency = clamp(
            (leader.days_buying / Math.max(1, h.available_days)) * 100,
            0,
            100,
        );
        base.reasons.push(
            `領先分點連買 ${leader.consecutive_buy_days} 日（推估）`,
        );
    } else if (h?.insufficient) {
        base.reasons.push('歷史天數不足，持久度權重可信度下降');
    }

    const score = Math.round(
        top3 * w.top3_weight +
            top5 * w.top5_weight +
            persistence * w.persistence_weight +
            consistency * w.consistency_weight,
    );

    let confidence: BiConfidence = 'LOW';
    if (
        c.eligible_for_ranking &&
        (h?.available_days ?? 0) >= 5 &&
        c.total_positive_net_buy >= opts.cfg.ranking_guards.min_positive_volume
    ) {
        confidence = 'HIGH';
    } else if (c.eligible_for_ranking) {
        confidence = 'MEDIUM';
    } else {
        confidence = 'LOW';
        base.reasons.push('成交量／活躍分點不足，集中度可能失真');
    }

    // Single branch >90% with tiny volume → force LOW
    if (
        (c.concentration_top1 ?? 0) >= 90 &&
        c.total_positive_net_buy < opts.cfg.ranking_guards.min_positive_volume
    ) {
        confidence = 'LOW';
        base.reasons.push('單一超高占比但量能偏小');
    }

    let label: MainForceEstimate['label'] = 'UNKNOWN';
    if (score >= 75 && confidence !== 'LOW') label = 'HIGH';
    else if (score >= 55) label = 'MEDIUM';
    else if (score != null) label = 'LOW';

    base.score = clamp(score, 0, 100);
    base.label = label;
    base.confidence = confidence;
    base.reasons.unshift(`Top3 集中度 ${top3}%（推估）`);
    return base;
}
