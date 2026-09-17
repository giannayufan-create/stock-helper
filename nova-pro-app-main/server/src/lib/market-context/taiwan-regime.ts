// server/src/lib/market-context/taiwan-regime.ts

import type { TwDayQuote } from '../tw-market-day.ts';
import type { MarketContextConfig } from './config.ts';
import { buildMeta, dayQuoteRealtimeLevel } from './freshness.ts';
import type {
    MarketBreadth,
    TaiwanRegime,
    TaiwanRegimeState,
    TurnoverAccelLabel,
} from './types.ts';

function dir(chg: number | null): 'UP' | 'DOWN' | 'FLAT' | 'UNKNOWN' {
    if (chg == null || !Number.isFinite(chg)) return 'UNKNOWN';
    if (chg > 0.05) return 'UP';
    if (chg < -0.05) return 'DOWN';
    return 'FLAT';
}

function industryMatch(name: string, keys: string[]): boolean {
    return keys.some((k) => name.includes(k));
}

export function avgChangePct(
    quotes: TwDayQuote[],
    pred: (q: TwDayQuote) => boolean,
): number | null {
    const xs = quotes.filter(pred);
    if (!xs.length) return null;
    const sum = xs.reduce((a, q) => {
        // Prefer change relative to prior close
        const prior = q.close - q.change;
        const p = prior > 0 ? (q.change / prior) * 100 : 0;
        return a + p;
    }, 0);
    return sum / xs.length;
}

export function computeLargeSmallRs(quotes: TwDayQuote[]): number | null {
    const withAmt = [...quotes].filter((q) => q.amount > 0).sort((a, b) => b.amount - a.amount);
    if (withAmt.length < 40) return null;
    const largeN = Math.max(20, Math.floor(withAmt.length * 0.15));
    const large = withAmt.slice(0, largeN);
    const small = withAmt.slice(Math.floor(withAmt.length * 0.5));
    const avg = (xs: TwDayQuote[]) => {
        const s = xs.reduce((a, q) => {
            const prior = q.close - q.change;
            return a + (prior > 0 ? (q.change / prior) * 100 : 0);
        }, 0);
        return s / xs.length;
    };
    return avg(large) - avg(small);
}

export function computeTaiwanRegime(input: {
    quotes: TwDayQuote[];
    industryOf: (symbol: string) => string | null;
    breadth: MarketBreadth;
    taiexChangePct: number | null;
    tpexChangePct: number | null;
    marketTurnoverHistory: number[];
    sectorBreadthPct: number | null;
    cfg: MarketContextConfig;
    fetchedAt?: string;
}): TaiwanRegime {
    const {
        quotes,
        industryOf,
        breadth,
        taiexChangePct,
        tpexChangePct,
        marketTurnoverHistory,
        sectorBreadthPct,
        cfg,
    } = input;
    const fetchedAt = input.fetchedAt ?? new Date().toISOString();

    const electronics_strength = avgChangePct(quotes, (q) => {
        const ind = industryOf(q.code) ?? '';
        return industryMatch(ind, cfg.electronics_keywords);
    });
    const financial_strength = avgChangePct(quotes, (q) => {
        const ind = industryOf(q.code) ?? '';
        return industryMatch(ind, cfg.financial_keywords);
    });
    const large_vs_small_rs = computeLargeSmallRs(quotes);

    let turnover_acceleration: TurnoverAccelLabel = 'UNKNOWN';
    if (marketTurnoverHistory.length >= 2) {
        const a = marketTurnoverHistory[marketTurnoverHistory.length - 2]!;
        const b = marketTurnoverHistory[marketTurnoverHistory.length - 1]!;
        if (a > 0) {
            const d = (b - a) / a;
            if (d > 0.03) turnover_acceleration = 'ACCELERATING';
            else if (d < -0.03) turnover_acceleration = 'DECELERATING';
            else turnover_acceleration = 'FLAT';
        }
    }

    // Score 0..100
    let score = 50;
    const reasons: string[] = [];
    const push = (delta: number, why: string) => {
        score += delta;
        reasons.push(why);
    };
    if (taiexChangePct != null) {
        push(Math.max(-12, Math.min(12, taiexChangePct * 4)), `TAIEX ${taiexChangePct.toFixed(2)}%`);
    }
    if (tpexChangePct != null) {
        push(Math.max(-8, Math.min(8, tpexChangePct * 3)), `TPEx ${tpexChangePct.toFixed(2)}%`);
    }
    if (breadth.advance_pct != null) {
        push((breadth.advance_pct - 50) * 0.35, `上漲家數 ${breadth.advance_pct.toFixed(0)}%`);
    }
    if (large_vs_small_rs != null) {
        push(Math.max(-6, Math.min(6, large_vs_small_rs)), `大小盤 RS ${large_vs_small_rs.toFixed(2)}`);
    }
    if (electronics_strength != null) {
        push(Math.max(-6, Math.min(6, electronics_strength * 1.2)), `電子 ${electronics_strength.toFixed(2)}%`);
    }
    if (financial_strength != null) {
        push(Math.max(-5, Math.min(5, financial_strength)), `金融 ${financial_strength.toFixed(2)}%`);
    }
    if (turnover_acceleration === 'ACCELERATING') push(4, '成交動能加速');
    if (turnover_acceleration === 'DECELERATING') push(-4, '成交動能減速');
    if (sectorBreadthPct != null) {
        push((sectorBreadthPct - 50) * 0.15, `產業廣度 ${sectorBreadthPct.toFixed(0)}%`);
    }
    score = Math.max(0, Math.min(100, score));

    const adv = breadth.advance_pct;
    let state: TaiwanRegimeState = 'NEUTRAL';
    if (score >= cfg.taiwan_regime.risk_on_score) {
        state =
            adv != null && adv >= cfg.taiwan_regime.broad_min_advance_pct
                ? 'RISK_ON_BROAD'
                : adv != null && adv <= cfg.taiwan_regime.narrow_max_advance_pct
                  ? 'RISK_ON_NARROW'
                  : 'RISK_ON_BROAD';
    } else if (score <= cfg.taiwan_regime.risk_off_score) {
        state =
            adv != null && adv <= 100 - cfg.taiwan_regime.broad_min_advance_pct
                ? 'RISK_OFF_BROAD'
                : adv != null && adv >= 100 - cfg.taiwan_regime.narrow_max_advance_pct
                  ? 'RISK_OFF_NARROW'
                  : 'RISK_OFF_BROAD';
    }

    if (!quotes.length && taiexChangePct == null) state = 'UNKNOWN';

    const sessionDate = quotes[0]?.date ?? null;
    return {
        state,
        taiex_change_pct: taiexChangePct,
        tpex_change_pct: tpexChangePct,
        taiex_direction: dir(taiexChangePct),
        tpex_direction: dir(tpexChangePct),
        market_breadth_advance_pct: breadth.advance_pct,
        advance_decline_ratio: breadth.advance_decline_ratio,
        turnover_acceleration,
        large_vs_small_rs,
        electronics_strength,
        financial_strength,
        sector_breadth_pct: sectorBreadthPct,
        score: Math.round(score * 10) / 10,
        reasons: reasons.slice(0, 6),
        meta: buildMeta({
            source: 'TW_DAY_QUOTES+YAHOO_INDEX',
            source_type: 'taiwan_regime',
            observed_at: sessionDate ? `${sessionDate}T05:00:00.000Z` : null,
            published_at: sessionDate,
            fetched_at: fetchedAt,
            available: state !== 'UNKNOWN',
            coverage_pct: breadth.coverage_pct,
            confidence: breadth.confidence,
            realtime_level: dayQuoteRealtimeLevel(sessionDate),
        }),
    };
}
