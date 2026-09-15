// server/src/lib/open-gate-v2/risk-gate.ts
// Overheat / chase / VWAP extension = soft / penalty — NOT hard_reject.

import type { OpenGateConfig } from './config.ts';
import type { ChaseRisk, SymbolMarketState } from './types.ts';

export interface RiskGateResult {
    risk_score: number;
    risk_adjustment: number;
    invalid_price: number | null;
    invalid_reason: string | null;
    chase_risk: ChaseRisk;
    risk_pct: number | null;
    risk_distance_pct: number | null;
    force_watch: boolean;
    hard_reject: boolean;
    reasons: string[];
    risks: string[];
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

export function tickSize(price: number): number {
    if (price < 10) return 0.01;
    if (price < 50) return 0.05;
    if (price < 100) return 0.1;
    if (price < 500) return 0.5;
    if (price < 1000) return 1;
    return 5;
}

export function runRiskGate(opts: {
    cfg: OpenGateConfig;
    state: SymbolMarketState | undefined;
    vwap: number | null;
    gap_pct: number;
    day_chg_pct: number;
    vwap_pos_pct: number | null;
    open_pos_pct: number | null;
    high_pullback_pct: number | null;
}): RiskGateResult {
    const { cfg, state, vwap, gap_pct, day_chg_pct } = opts;
    const reasons: string[] = [];
    const risks: string[] = [];
    let force_watch = false;

    if (!state || state.last_price <= 0) {
        return {
            risk_score: 0,
            risk_adjustment: cfg.risk.adj_min,
            invalid_price: null,
            invalid_reason: '無行情',
            chase_risk: 'extreme',
            risk_pct: null,
            risk_distance_pct: null,
            force_watch: true,
            hard_reject: false, // missing price handled by liquidity/essential; not risk hard
            reasons,
            risks: ['風險閘：無有效價格'],
        };
    }

    const last = state.last_price;
    const open = state.open || last;
    const swingLow =
        state.recent_prices.length >= 5
            ? Math.min(...state.recent_prices.map((p) => p.p))
            : state.low || open;

    const candidates: Array<{ px: number; why: string }> = [
        { px: open, why: '開盤價結構' },
    ];
    if (vwap != null && vwap > 0) {
        candidates.push({ px: vwap, why: 'VWAP' });
    }
    if (swingLow > 0) {
        candidates.push({ px: swingLow, why: 'opening structure low' });
    }

    const below = candidates.filter((c) => c.px > 0 && c.px <= last);
    let invalid_price: number | null = null;
    let invalid_reason: string | null = null;
    if (below.length) {
        const best = below.sort((a, b) => b.px - a.px)[0]!;
        const buf = tickSize(best.px) * cfg.risk.tick_buffer_ticks;
        invalid_price = Math.round((best.px - buf) * 1000) / 1000;
        invalid_reason =
            best.why === 'opening structure low'
                ? '跌破 opening structure low'
                : `跌破${best.why}`;
        reasons.push(`失效參考：${invalid_reason} @ ${invalid_price}`);
    } else {
        const buf = tickSize(open) * cfg.risk.tick_buffer_ticks;
        invalid_price = Math.round((open - buf) * 1000) / 1000;
        invalid_reason = '跌破開盤價結構';
    }

    const risk_distance_pct =
        invalid_price != null && last > 0
            ? ((last - invalid_price) / last) * 100
            : null;
    const risk_pct = risk_distance_pct;

    const extension = Math.max(
        Math.abs(gap_pct),
        Math.abs(day_chg_pct),
        Math.abs(opts.vwap_pos_pct ?? 0),
        Math.abs(opts.open_pos_pct ?? 0),
    );
    const pullback = opts.high_pullback_pct ?? 0;
    let chase: ChaseRisk = 'low';
    const th = cfg.chase_risk_thresholds;
    if (extension >= th.high_max || day_chg_pct >= cfg.risk.max_day_chg_pct) {
        chase = 'extreme';
    } else if (extension >= th.medium_max) {
        chase = 'high';
    } else if (extension >= th.low_max) {
        chase = 'medium';
    }

    if (pullback < 0.3 && day_chg_pct >= th.medium_max) {
        chase = chase === 'low' ? 'medium' : chase;
        risks.push('漲幅延伸且回撤極小（追價風險）');
    }

    // Patch §2: overheat / chase = soft / force_watch, NOT hard_reject
    if (gap_pct >= cfg.risk.max_chase_gap_pct) {
        risks.push(`缺口偏熱 ${gap_pct.toFixed(1)}%`);
        if (chase === 'low' || chase === 'medium') chase = 'high';
        force_watch = true;
    }
    if (day_chg_pct >= cfg.risk.max_day_chg_pct) {
        risks.push(`日漲幅過熱 ${day_chg_pct.toFixed(1)}%`);
        force_watch = true;
        chase = 'extreme';
    }
    if (
        opts.vwap_pos_pct != null &&
        opts.vwap_pos_pct >= cfg.risk.max_vwap_extension_pct
    ) {
        risks.push(`距 VWAP 過遠 +${opts.vwap_pos_pct.toFixed(1)}%`);
        force_watch = cfg.risk.bad_rr_soft_to_watch;
    }

    if (risk_distance_pct != null && risk_distance_pct > 3.5) {
        risks.push(`風險幅度偏大 ${risk_distance_pct.toFixed(1)}%`);
        force_watch = cfg.risk.bad_rr_soft_to_watch;
    } else if (risk_distance_pct != null && risk_distance_pct <= 1.8) {
        reasons.push(`風險可控 ~${risk_distance_pct.toFixed(1)}%`);
    }

    let risk_score = 70;
    if (chase === 'extreme') risk_score -= 40;
    else if (chase === 'high') risk_score -= 25;
    else if (chase === 'medium') risk_score -= 10;
    else risk_score += 10;
    if (risk_distance_pct != null) {
        if (risk_distance_pct <= 1.5) risk_score += 10;
        else if (risk_distance_pct >= 3) risk_score -= 15;
    }
    risk_score = clamp(risk_score, 0, 100);

    const risk_adjustment = clamp(
        ((risk_score - 50) / 50) * cfg.risk.adj_max,
        cfg.risk.adj_min,
        cfg.risk.adj_max,
    );

    return {
        risk_score: Math.round(risk_score),
        risk_adjustment: Math.round(risk_adjustment * 10) / 10,
        invalid_price,
        invalid_reason,
        chase_risk: chase,
        risk_pct:
            risk_pct != null ? Math.round(risk_pct * 100) / 100 : null,
        risk_distance_pct:
            risk_distance_pct != null
                ? Math.round(risk_distance_pct * 100) / 100
                : null,
        force_watch,
        hard_reject: false,
        reasons,
        risks,
    };
}
