// server/src/lib/broker-intelligence/alignment.ts

import type { BrokerIntelligenceConfig } from './config.ts';
import type {
    BrokerMarketAlignment,
    MainForceEstimate,
} from './types.ts';

export function computeAlignment(opts: {
    mainForce: MainForceEstimate;
    cScore: number | null;
    state: string | null;
    events: string[];
    stockHeat: number | null;
    cfg: BrokerIntelligenceConfig;
    branchAvailable: boolean;
}): { alignment: BrokerMarketAlignment; note: string } {
    if (!opts.branchAvailable || opts.mainForce.score == null) {
        return {
            alignment: 'UNKNOWN',
            note: '分點資料不可用，無法判斷籌碼與動能對齊',
        };
    }

    const mf = opts.mainForce.score;
    const c = opts.cScore;
    const strongState =
        opts.state === 'STRONG' || opts.state === 'HEATING';
    const hotEvent = (opts.events ?? []).some((e) =>
        ['SURGE', 'BREAKOUT', 'REBREAK'].includes(e),
    );
    const heatUp = (opts.stockHeat ?? 0) >= 70;

    const bullishMf = mf >= opts.cfg.alignment.min_main_force_score;
    const bullishC =
        c != null && c >= opts.cfg.alignment.min_c_score && (strongState || hotEvent || heatUp);

    if (bullishMf && bullishC) {
        return {
            alignment: 'BULLISH_ALIGNMENT',
            note: '籌碼背景與盤中動能同向（推估＋盤中狀態，非進場訊號）',
        };
    }
    if (bullishMf && c != null && c < 55) {
        return {
            alignment: 'DIVERGENCE',
            note: '分點集中偏多但盤中動能偏弱（分歧，僅供觀察）',
        };
    }
    if (!bullishMf && bullishC) {
        return {
            alignment: 'DIVERGENCE',
            note: '盤中動能偏強但分點背景未顯示集中買超（分歧）',
        };
    }
    return {
        alignment: 'NEUTRAL',
        note: '籌碼與動能未形成明顯同向／分歧',
    };
}
