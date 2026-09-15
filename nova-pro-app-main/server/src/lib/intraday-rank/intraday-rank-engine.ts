// server/src/lib/intraday-rank/intraday-rank-engine.ts
// C2 score + hysteresis state + rank velocity (timestamped history)

import type { DataHealthReport } from '../open-gate-v2/data-health.ts';
import type { SymbolMarketState } from '../open-gate-v2/types.ts';
import type { IntradayRankConfig } from './config.ts';
import {
    computeBreakout,
    computeChaseRisk,
    computeHeat,
    computeLiquidityScore,
    computeMomentum,
    computePullback,
    computeRelativeStrength,
    computeTradeAggression,
    computeVolumeAcceleration,
    computeVwapStructure,
    rankAtLookback,
} from './metric-engines.ts';
import type {
    DiscoveryItem,
    IntradayRankItem,
    IntradayState,
} from './types.ts';

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

function newId(prefix: string, symbol: string, now: Date): string {
    const t = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    return `${prefix}_${t}_${symbol}`;
}

function applyStateHysteresis(opts: {
    cfg: IntradayRankConfig;
    score: number;
    previous: IntradayRankItem | null;
    dataBlocked: boolean;
    invalidHit: boolean;
}): { state: IntradayState; confirmation_count: number } {
    const { cfg, score, previous, dataBlocked, invalidHit } = opts;
    const prev = previous?.state ?? 'DORMANT';
    let conf = previous?.confirmation_count ?? 0;

    if (invalidHit) {
        return { state: 'INVALID', confirmation_count: 0 };
    }
    if (dataBlocked && (prev === 'STRONG' || prev === 'HEATING')) {
        return { state: 'COOLING', confirmation_count: 0 };
    }

    const wantStrong = score >= cfg.strong_enter && !dataBlocked;
    const stayStrong =
        prev === 'STRONG' && score > cfg.strong_exit && !dataBlocked;
    const wantHeating = score >= cfg.heating_enter && !dataBlocked;
    const stayHeating =
        (prev === 'HEATING' || prev === 'STRONG') &&
        score > cfg.heating_exit;
    const wantEmerging = score >= cfg.emerging_enter;

    if (prev === 'STRONG') {
        if (stayStrong) {
            return { state: 'STRONG', confirmation_count: conf };
        }
        if (score <= cfg.strong_exit) {
            conf += 1;
            if (conf >= cfg.min_confirm_evaluations) {
                return {
                    state: score >= cfg.heating_exit ? 'COOLING' : 'COOLING',
                    confirmation_count: 0,
                };
            }
            return { state: 'STRONG', confirmation_count: conf };
        }
    }

    if (wantStrong) {
        conf =
            previous && previous.intraday_score >= cfg.strong_enter
                ? conf + 1
                : 1;
        if (conf >= cfg.min_confirm_evaluations) {
            return { state: 'STRONG', confirmation_count: conf };
        }
        return {
            state: prev === 'HEATING' ? 'HEATING' : 'HEATING',
            confirmation_count: conf,
        };
    }

    if (prev === 'HEATING' && stayHeating) {
        return { state: 'HEATING', confirmation_count: 0 };
    }

    if (wantHeating) {
        conf =
            previous && previous.intraday_score >= cfg.heating_enter
                ? conf + 1
                : 1;
        if (conf >= cfg.min_confirm_evaluations) {
            return { state: 'HEATING', confirmation_count: conf };
        }
        return { state: 'EMERGING', confirmation_count: conf };
    }

    if (wantEmerging) {
        return { state: 'EMERGING', confirmation_count: 0 };
    }

    if (prev === 'HEATING' || prev === 'STRONG' || prev === 'EMERGING') {
        return { state: 'COOLING', confirmation_count: 0 };
    }
    return { state: 'DORMANT', confirmation_count: 0 };
}

export function scoreIntradaySymbol(opts: {
    cfg: IntradayRankConfig;
    discovery: DiscoveryItem;
    state: SymbolMarketState | undefined;
    vwap: {
        vwap: number | null;
        valid: boolean;
        available?: boolean;
        confidence?: 'high' | 'degraded' | 'none';
    };
    rvolSameTime: number | null;
    health: DataHealthReport;
    marketRetHint: number | null;
    previous: IntradayRankItem | null;
    /** Replay/live clock — must be ReplayClock time in replay. */
    now?: Date;
    /** When set, force unavailable features out of weight sum (no fill-0). */
    featureFlags?: {
        trade_aggression?: boolean;
        bid_ask?: boolean;
    };
}): IntradayRankItem {
    const {
        cfg,
        discovery,
        state,
        rvolSameTime,
        health,
        marketRetHint,
        previous,
    } = opts;
    const now = opts.now ?? new Date();
    const nowMs = now.getTime();

    const mom = computeMomentum(state, nowMs);
    const vol = computeVolumeAcceleration(state, rvolSameTime, nowMs);
    const vwapAvailable =
        opts.vwap.available ?? opts.vwap.valid ?? opts.vwap.vwap != null;
    const vwapConfidence =
        opts.vwap.confidence ??
        (opts.vwap.valid ? 'high' : vwapAvailable ? 'degraded' : 'none');
    const vw = computeVwapStructure(
        state,
        vwapAvailable ? opts.vwap.vwap : null,
        vwapAvailable,
    );
    const rs = computeRelativeStrength(mom.return_3m, marketRetHint);
    const br = computeBreakout(state);
    const pb = computePullback(
        state,
        vwapAvailable ? opts.vwap.vwap : null,
    );
    let agg = computeTradeAggression(state);
    if (opts.featureFlags?.trade_aggression === false) {
        agg = { score: null, available: false };
    }
    const liq = computeLiquidityScore(state);

    const dayChg =
        state && state.prev_close > 0 && state.last_price > 0
            ? ((state.last_price - state.prev_close) / state.prev_close) * 100
            : discovery.change_pct ?? 0;
    const pullPct =
        state && state.high > 0
            ? ((state.high - state.last_price) / state.high) * 100
            : 0;
    const chase = computeChaseRisk(
        dayChg,
        vw.vwap_pos_pct,
        mom.return_1m,
        pullPct,
    );

    const w = cfg.weights;
    const vwapWeightFactor = vwapConfidence === 'degraded' ? 0.7 : 1;
    const parts: Array<{
        key: string;
        w: number;
        s: number;
        ok: boolean;
    }> = [
        {
            key: 'momentum',
            w: w.momentum,
            s: mom.score ?? 0,
            ok: mom.available && mom.score != null,
        },
        {
            key: 'volume_acceleration',
            w: w.volume_acceleration,
            s: vol.score ?? 0,
            ok: vol.available && vol.score != null,
        },
        {
            key: 'relative_strength',
            w: w.relative_strength,
            s: rs.score ?? 0,
            ok: rs.available && rs.score != null,
        },
        {
            key: 'vwap_structure',
            w: w.vwap_structure * vwapWeightFactor,
            s: vw.score ?? 0,
            ok: vw.available && vw.score != null,
        },
        {
            key: 'breakout',
            w: w.breakout,
            s: br.score ?? 0,
            ok: br.available && br.score != null,
        },
        {
            key: 'trade_aggression',
            w: w.trade_aggression,
            s: agg.score ?? 0,
            ok: agg.available && agg.score != null,
        },
        {
            key: 'pullback_quality',
            w: w.pullback_quality,
            s: pb.score ?? 0,
            ok: pb.available && pb.score != null,
        },
        {
            key: 'liquidity',
            w: w.liquidity,
            s: liq.score ?? 0,
            ok: liq.available && liq.score != null,
        },
    ];
    const avail = parts.filter((p) => p.ok);
    const wSum = avail.reduce((a, p) => a + p.w, 0) || 1;
    const raw = avail.reduce((a, p) => a + (p.w / wSum) * p.s, 0);
    const totalW = parts.reduce((a, p) => a + p.w, 0) || 1;
    const score_coverage_pct = Math.round(
        (avail.reduce((a, p) => a + p.w, 0) / totalW) * 100,
    );
    const feature_availability: Record<string, boolean> = {
        momentum: mom.available && mom.score != null,
        volume_acceleration: vol.available && vol.score != null,
        relative_strength: rs.available && rs.score != null,
        vwap_structure: vw.available && vw.score != null,
        vwap_confidence_high: vwapConfidence === 'high',
        breakout: br.available && br.score != null,
        pullback: pb.available && pb.score != null,
        liquidity: liq.available && liq.score != null,
        trade_aggression: agg.available && agg.score != null,
        bid_ask:
            opts.featureFlags?.bid_ask !== false &&
            (state?.best_bid ?? 0) > 0 &&
            (state?.best_ask ?? 0) > 0,
        orderbook: false,
        tick_velocity: false,
        amount: (state?.total_amount ?? 0) > 0,
        index: marketRetHint != null,
    };
    const score_confidence: 'high' | 'medium' | 'low' =
        score_coverage_pct >= 90
            ? 'high'
            : score_coverage_pct >= 70
              ? 'medium'
              : 'low';

    let bBonus = 0;
    if (discovery.open_gate_status === 'pass') {
        bBonus = cfg.b_pass_confidence_bonus;
    } else if (discovery.open_gate_status === 'watch') {
        bBonus = cfg.b_watch_confidence_bonus;
    }

    const chasePenalty = cfg.chase_penalties[chase] ?? 0;
    const intraday_score = Math.round(
        clamp(raw + bBonus - chasePenalty, 0, 100),
    );

    const invalid_price =
        state && state.open > 0
            ? Math.round(state.open * 0.995 * 1000) / 1000
            : opts.vwap.vwap != null
              ? Math.round(opts.vwap.vwap * 0.99 * 1000) / 1000
              : null;
    const invalidHit =
        invalid_price != null &&
        state != null &&
        state.last_price > 0 &&
        state.last_price < invalid_price;

    const { state: st, confirmation_count } = applyStateHysteresis({
        cfg,
        score: intraday_score,
        previous,
        dataBlocked: health.data_blocked,
        invalidHit,
    });

    // data_blocked: no new STRONG
    let stateFinal = st;
    if (
        health.data_blocked &&
        (stateFinal === 'STRONG' || stateFinal === 'HEATING')
    ) {
        stateFinal = previous?.state === 'STRONG' ? 'COOLING' : 'EMERGING';
    }

    const reasons: string[] = [];
    const risks: string[] = [];
    if (vol.volume_acceleration != null && vol.volume_acceleration >= 1.5) {
        reasons.push(`近1分鐘量能加速 ${vol.volume_acceleration.toFixed(2)}x`);
    }
    if (vw.vwap_pos_pct != null && vw.vwap_pos_pct >= 0) {
        reasons.push('股價站上VWAP');
    }
    if (rs.score != null && rs.score >= 70) reasons.push('相對大盤／族群偏強');
    if (br.type === 'breakout' || br.type === 'rebreak') {
        reasons.push(
            br.type === 'rebreak' ? '整理後重新突破' : '突破近期高點',
        );
    }
    if (pb.state === 'holding' || pb.state === 'reclaiming') {
        reasons.push('回踩品質佳');
    }
    if (chase === 'high' || chase === 'extreme') {
        risks.push(`追價風險 ${chase}`);
    }
    if (vw.vwap_pos_pct != null && vw.vwap_pos_pct > 2) {
        risks.push(`距VWAP ${vw.vwap_pos_pct.toFixed(1)}%`);
    }
    if (health.data_blocked) risks.push(`DATA ${health.health}`);
    if (marketRetHint == null) {
        risks.push('相對強度不可用（無大盤報酬）');
    }

    const heat = computeHeat({
        volAccelScore: vol.score ?? 50,
        momAccel: mom.momentum_acceleration,
        rankVelocity: null, // filled after rank
        ret1m: mom.return_1m,
    });

    let signal_id = previous?.signal_id ?? null;
    if (
        (stateFinal === 'STRONG' || stateFinal === 'HEATING') &&
        previous?.state !== 'STRONG' &&
        previous?.state !== 'HEATING'
    ) {
        signal_id = newId('csig', discovery.symbol, now);
    }

    return {
        symbol: discovery.symbol,
        name: discovery.name,
        candidate_origin: discovery.candidate_origin,
        candidate_sources: discovery.candidate_sources,
        a_score: discovery.a_score,
        open_score: discovery.open_score,
        open_gate_status: discovery.open_gate_status,
        rank: 0,
        rank_prev: previous?.rank ?? null,
        rank_change: null,
        rank_1m_ago: null,
        rank_5m_ago: null,
        rank_velocity: null,
        intraday_score,
        raw_intraday_score: Math.round(raw),
        heat_score: heat,
        state: stateFinal,
        metrics: {
            return_30s: mom.return_30s,
            return_1m: mom.return_1m,
            return_3m: mom.return_3m,
            return_5m: mom.return_5m,
            momentum_acceleration: mom.momentum_acceleration,
            volume_acceleration: vol.volume_acceleration,
            volume_1m: vol.volume_1m,
            volume_3m: vol.volume_3m,
            vwap: vwapAvailable ? opts.vwap.vwap : opts.vwap.vwap,
            vwap_pos_pct: vw.vwap_pos_pct,
            vwap_structure_score: vw.score,
            relative_strength_score: rs.score,
            breakout_score: br.score,
            breakout_type: br.type,
            trade_aggression_score: agg.score,
            trade_aggression_available: agg.available,
            pullback_quality_score: pb.score,
            pullback_state: pb.state,
            spread_pct: liq.spread_pct,
            liquidity_score: liq.score,
        },
        risk: {
            chase_risk: chase,
            invalid_price,
            invalid_reason: invalid_price != null ? '跌破開盤／結構參考' : null,
        },
        events: [],
        reasons: [...new Set(reasons)].slice(0, 8),
        risks: [...new Set(risks)].slice(0, 8),
        data_health: health.health,
        data_blocked: health.data_blocked,
        notification_candidate: false,
        confirmation_count,
        signal_id,
        evaluation_id: newId('cev', discovery.symbol, now),
        updated_at: now.toISOString(),
        score_coverage_pct,
        score_confidence,
        feature_availability,
    };
}

export function attachRanks(
    items: IntradayRankItem[],
    prevRanks: Map<string, number>,
    history: Map<string, Array<{ t: number; rank: number }>>,
    cfg: IntradayRankConfig,
    nowMs: number,
): IntradayRankItem[] {
    const sorted = [...items].sort(
        (a, b) => b.intraday_score - a.intraday_score || b.heat_score - a.heat_score,
    );
    return sorted.map((it, idx) => {
        const rank = idx + 1;
        const prev = prevRanks.get(it.symbol) ?? it.rank_prev;
        const hist = history.get(it.symbol) ?? [];
        hist.push({ t: nowMs, rank });
        // keep ~10 min of samples
        const cutoff = nowMs - 10 * 60_000;
        while (hist.length > 0 && hist[0]!.t < cutoff) hist.shift();
        while (hist.length > 200) hist.shift();
        history.set(it.symbol, hist);

        const rank_1m_ago = rankAtLookback(hist, nowMs, 60_000);
        const rank_5m_ago = rankAtLookback(hist, nowMs, 300_000);
        const rank_change = prev != null ? prev - rank : null; // positive = improved
        const rank_velocity =
            rank_5m_ago != null ? rank_5m_ago - rank : rank_change;
        const heat = computeHeat({
            volAccelScore:
                it.metrics.volume_acceleration != null
                    ? clamp(40 + it.metrics.volume_acceleration * 15, 0, 100)
                    : 50,
            momAccel: it.metrics.momentum_acceleration,
            rankVelocity: rank_velocity,
            ret1m: it.metrics.return_1m,
        });
        const reasons = [...it.reasons];
        if (
            rank_velocity != null &&
            rank_velocity >= cfg.rank_jump_threshold
        ) {
            reasons.unshift(
                `5分鐘排名由${rank_5m_ago ?? '?'}升至${rank}`,
            );
        }
        return {
            ...it,
            rank,
            rank_prev: prev ?? null,
            rank_change,
            rank_1m_ago,
            rank_5m_ago,
            rank_velocity,
            heat_score: heat,
            reasons: [...new Set(reasons)].slice(0, 8),
        };
    });
}
