// server/src/lib/market-intelligence/heat-engine.ts
// Shared Sector/Theme heat — NEVER mutates A/B/C or stock heat_score.

import type { MarketIntelligenceConfig, MiHeatWeights } from './config.ts';
import type {
    HeatGroupResult,
    HeatMemberSnapshot,
    MiConfidence,
} from './types.ts';

const POSITIVE_EVENTS = new Set([
    'SURGE',
    'BREAKOUT',
    'REBREAK',
    'PULLBACK_READY',
]);

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

function avg(nums: number[]): number | null {
    if (!nums.length) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function confidenceOf(
    covered: number,
    coveragePct: number,
    cfg: MarketIntelligenceConfig,
): MiConfidence {
    if (
        covered >= cfg.coverage.high_min_covered &&
        coveragePct >= cfg.coverage.high_min_pct
    ) {
        return 'HIGH';
    }
    if (
        covered >= cfg.coverage.medium_min_covered &&
        coveragePct >= cfg.coverage.medium_min_pct
    ) {
        return 'MEDIUM';
    }
    return 'LOW';
}

/** Weighted average using only available component scores (missing ≠ 0). */
export function weightedAvailable(
    parts: Array<{ w: number; v: number | null }>,
): number | null {
    const ok = parts.filter((p) => p.v != null && Number.isFinite(p.v!));
    if (!ok.length) return null;
    const wSum = ok.reduce((a, p) => a + p.w, 0);
    if (wSum <= 0) return null;
    return ok.reduce((a, p) => a + (p.w / wSum) * (p.v as number), 0);
}

export function computeGroupHeat(opts: {
    id: string;
    name: string;
    totalMembers: number;
    covered: HeatMemberSnapshot[];
    weights: MiHeatWeights;
    cfg: MarketIntelligenceConfig;
    history: Array<{ at: number; heat: number }>;
    nowMs?: number;
    source?: string;
}): HeatGroupResult {
    const now = opts.nowMs ?? Date.now();
    const covered = opts.covered;
    const n = covered.length;
    const total = Math.max(opts.totalMembers, n);
    const coveragePct = total > 0 ? (n / total) * 100 : 0;

    let breadth: number | null = null;
    if (n > 0) {
        const up = covered.filter((m) => (m.change_pct ?? 0) > 0).length / n;
        const withVwap = covered.filter((m) => m.vwap_pos_pct != null);
        const vwapAbove =
            withVwap.length > 0
                ? withVwap.filter((m) => (m.vwap_pos_pct ?? 0) > 0).length /
                  withVwap.length
                : null;
        breadth =
            vwapAbove != null
                ? clamp(((up + vwapAbove) / 2) * 100, 0, 100)
                : clamp(up * 100, 0, 100);
    }

    let participation: number | null = null;
    if (n > 0) {
        const strong = covered.filter((m) => m.state === 'STRONG').length / n;
        const heating = covered.filter((m) => m.state === 'HEATING').length / n;
        participation = clamp((strong * 1.0 + heating * 0.5) * 100, 0, 100);
    }

    let leader_strength: number | null = null;
    if (n > 0) {
        const sorted = [...covered]
            .filter((m) => m.c_score != null)
            .sort((a, b) => (b.c_score ?? 0) - (a.c_score ?? 0));
        const topN = Math.max(
            1,
            Math.min(
                opts.cfg.coverage.leader_top_max,
                Math.ceil(sorted.length * opts.cfg.coverage.leader_top_pct),
            ),
        );
        const top = sorted.slice(0, topN);
        leader_strength = avg(top.map((m) => m.c_score as number));
        if (leader_strength != null) {
            leader_strength = clamp(leader_strength, 0, 100);
        }
    }

    let volume_acceleration: number | null = null;
    {
        const vols = covered
            .map((m) => m.volume_acceleration)
            .filter((v): v is number => v != null && Number.isFinite(v));
        const rvols = covered
            .map((m) => m.rvol)
            .filter((v): v is number => v != null && Number.isFinite(v));
        if (vols.length) {
            volume_acceleration = clamp(avg(vols)! * 100, 0, 100);
        } else if (rvols.length) {
            volume_acceleration = clamp(
                avg(rvols.map((r) => clamp((r - 0.5) * 50, 0, 100)))!,
                0,
                100,
            );
        }
    }

    let rank_momentum: number | null = null;
    {
        const rvs = covered
            .map((m) => m.rank_velocity)
            .filter((v): v is number => v != null && Number.isFinite(v));
        if (rvs.length) {
            const pos = rvs.map((v) => clamp(v / 20, 0, 1));
            rank_momentum = clamp(avg(pos)! * 100, 0, 100);
        }
    }

    let event_density: number | null = null;
    if (n > 0) {
        const hits = covered.filter((m) =>
            (m.events ?? []).some((e) => POSITIVE_EVENTS.has(e)),
        ).length;
        event_density = clamp((hits / n) * 100, 0, 100);
    }

    const w = opts.weights;
    const heatNow = weightedAvailable([
        { w: w.breadth, v: breadth },
        { w: w.participation, v: participation },
        { w: w.leader_strength, v: leader_strength },
        { w: w.volume_acceleration, v: volume_acceleration },
        { w: w.rank_momentum, v: rank_momentum },
        { w: w.event_density, v: event_density },
    ]);

    const heat_score =
        heatNow != null ? Math.round(clamp(heatNow, 0, 100)) : null;

    const hist = opts.history;
    const findAgo = (ms: number): number | null => {
        const target = now - ms;
        let best: { at: number; heat: number } | null = null;
        for (const h of hist) {
            if (h.at <= target) {
                if (!best || h.at > best.at) best = h;
            }
        }
        return best?.heat ?? null;
    };
    const heat_5m_ago = findAgo(5 * 60_000);
    const heat_15m_ago = findAgo(15 * 60_000);

    const leaders = [...covered]
        .filter((m) => m.c_score != null)
        .sort((a, b) => (b.c_score ?? 0) - (a.c_score ?? 0))
        .slice(0, 5)
        .map((m) => ({
            symbol: m.symbol,
            name: m.name,
            c_score: m.c_score,
            stock_heat_score: m.stock_heat_score,
            state: m.state,
        }));

    return {
        id: opts.id,
        name: opts.name,
        heat_score,
        heat_now: heat_score,
        heat_5m_ago,
        heat_15m_ago,
        heat_delta_5m:
            heat_score != null && heat_5m_ago != null
                ? heat_score - heat_5m_ago
                : null,
        heat_delta_15m:
            heat_score != null && heat_15m_ago != null
                ? heat_score - heat_15m_ago
                : null,
        covered_members: n,
        total_members: total,
        coverage_pct: Math.round(coveragePct * 10) / 10,
        confidence: confidenceOf(n, coveragePct, opts.cfg),
        eligible_for_ranking: n >= opts.cfg.coverage.min_eligible_covered,
        strong_count: covered.filter((m) => m.state === 'STRONG').length,
        heating_count: covered.filter((m) => m.state === 'HEATING').length,
        breakout_count: covered.filter((m) =>
            (m.events ?? []).some(
                (e) => e === 'BREAKOUT' || e === 'REBREAK' || e === 'SURGE',
            ),
        ).length,
        leaders,
        components: {
            breadth,
            participation,
            leader_strength,
            volume_acceleration,
            rank_momentum,
            event_density,
        },
        updated_at: new Date(now).toISOString(),
        source: opts.source,
    };
}

export function trendArrow(delta: number | null): string {
    if (delta == null) return '→';
    if (delta >= 5) return '↑';
    if (delta <= -5) return '↓';
    return '→';
}
