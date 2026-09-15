// server/src/lib/open-gate-v2/liquidity-gate.ts
// Hard reject = structural only. Temporary spread/RVOL = soft.

import type { OpenGateConfig } from './config.ts';
import type { ACandidate, SymbolMarketState } from './types.ts';

export interface LiquidityGateResult {
    liquidity_score: number;
    liquidity_adjustment: number;
    hard_reject: boolean;
    soft_reject: boolean;
    spread_pct: number | null;
    reasons: string[];
    risks: string[];
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

export function runLiquidityGate(opts: {
    cfg: OpenGateConfig;
    candidate: ACandidate;
    state: SymbolMarketState | undefined;
    sessionMinutes: number;
    rvolSameTime: number | null;
}): LiquidityGateResult {
    const { cfg, candidate, state, sessionMinutes, rvolSameTime } = opts;
    const reasons: string[] = [];
    const risks: string[] = [];
    let hard = false;
    let soft = false;

    if (cfg.hard_reject.disposition && candidate.disposition_status) {
        hard = true;
        risks.push('處置／交易限制');
    }

    if (
        cfg.hard_reject.missing_essential_data &&
        (!state || state.last_price <= 0)
    ) {
        hard = true;
        risks.push('無法取得必要基礎行情');
        return {
            liquidity_score: 0,
            liquidity_adjustment: cfg.liquidity.score_to_adjustment.adj_min,
            hard_reject: true,
            soft_reject: false,
            spread_pct: null,
            reasons,
            risks,
        };
    }

    const mid =
        state!.best_bid > 0 && state!.best_ask > 0
            ? (state!.best_bid + state!.best_ask) / 2
            : state!.last_price;
    const spread_pct =
        state!.best_bid > 0 && state!.best_ask > 0 && mid > 0
            ? ((state!.best_ask - state!.best_bid) / mid) * 100
            : null;

    // temporary bid/ask missing → soft
    if (
        (state!.best_bid <= 0 || state!.best_ask <= 0) &&
        sessionMinutes >= 3
    ) {
        soft = true;
        risks.push('bid/ask 暫時缺失');
    }

    // temporary wide spread → soft; only extreme structural → hard
    if (
        cfg.hard_reject.structural_illiquidity &&
        spread_pct != null &&
        spread_pct >= cfg.liquidity.hard_max_spread_pct
    ) {
        hard = true;
        risks.push(`結構性價差過大 ${spread_pct.toFixed(2)}%`);
    } else if (
        spread_pct != null &&
        spread_pct >= cfg.liquidity.max_spread_pct
    ) {
        soft = true;
        risks.push(`暫時價差偏大 ${spread_pct.toFixed(2)}%`);
    }

    const turnover = state!.total_amount || state!.turnover;
    const minTurn =
        sessionMinutes >= 10
            ? cfg.liquidity.min_turnover_10m
            : cfg.liquidity.min_turnover_5m;

    if (
        cfg.hard_reject.structural_illiquidity &&
        turnover < cfg.liquidity.hard_min_turnover &&
        sessionMinutes >= 10
    ) {
        hard = true;
        risks.push('結構性流動性極差');
    } else if (turnover < minTurn && sessionMinutes >= 5) {
        soft = true;
        risks.push('成交額暫時偏低');
    } else if (turnover >= minTurn) {
        reasons.push('流動性充足');
    }

    if (
        state!.tick_count < cfg.liquidity.min_tick_count &&
        sessionMinutes >= 5
    ) {
        soft = true;
        risks.push(`tick 暫時過少 (${state!.tick_count})`);
    }

    // RVOL weak = soft only (Patch §2)
    if (
        rvolSameTime != null &&
        rvolSameTime < cfg.liquidity.min_rvol &&
        sessionMinutes >= 5
    ) {
        soft = true;
        risks.push(`RVOL 暫時不足 ${rvolSameTime.toFixed(2)}x`);
    }

    let score = 50;
    if (turnover >= minTurn * 2) score += 25;
    else if (turnover >= minTurn) score += 15;
    else if (turnover >= cfg.liquidity.hard_min_turnover) score += 0;
    else score -= 25;

    if (spread_pct != null) {
        if (spread_pct <= cfg.liquidity.max_spread_pct * 0.5) score += 15;
        else if (spread_pct <= cfg.liquidity.max_spread_pct) score += 5;
        else score -= 20;
    } else {
        score -= 10;
    }

    if (state!.tick_count >= cfg.liquidity.min_tick_count * 2) score += 10;
    else if (state!.tick_count >= cfg.liquidity.min_tick_count) score += 5;

    score = clamp(score, 0, 100);
    const { adj_min, adj_max } = cfg.liquidity.score_to_adjustment;
    const liquidity_adjustment = clamp(
        ((score - 50) / 50) * adj_max,
        adj_min,
        adj_max,
    );

    return {
        liquidity_score: Math.round(score),
        liquidity_adjustment: Math.round(liquidity_adjustment * 10) / 10,
        hard_reject: hard,
        soft_reject: soft,
        spread_pct,
        reasons,
        risks,
    };
}
