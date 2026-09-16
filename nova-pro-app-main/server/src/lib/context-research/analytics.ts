// server/src/lib/context-research/analytics.ts
// Cohort attribution — statistics only; no winner / no strategy mutation.

import type { StrategySignal } from '../strategy-signal/types.ts';
import type { SignalOutcome } from '../signal-outcome/types.ts';
import type { ContextResearchConfig } from './config.ts';
import { DEFAULT_CR_CONFIG } from './config.ts';
import { passesContextQuality, sampleGuardLabel } from './sample-guard.ts';
import type {
    CohortStatRow,
    ContextAlignment,
    ContextSnapshot,
    ContextTag,
    DailyContextResearchSummary,
    ShadowCohortId,
} from './types.ts';

export interface SignalWithContext {
    s: StrategySignal;
    o: SignalOutcome | null;
    snap: ContextSnapshot | null;
    tags: ContextTag[];
    alignment: ContextAlignment | null;
}

function avg(nums: number[]): number | null {
    if (!nums.length) return null;
    return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

function median(nums: number[]): number | null {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    const v = s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
    return Math.round(v * 100) / 100;
}

function rate(ok: number, n: number): number | null {
    if (!n) return null;
    return Math.round((ok / n) * 1000) / 10;
}

export function readContextFromSignal(s: StrategySignal): {
    snap: ContextSnapshot | null;
    tags: ContextTag[];
    alignment: ContextAlignment | null;
} {
    const snap =
        (s.context_snapshot as ContextSnapshot | undefined) ??
        ((s.feature_snapshot?.context_snapshot as ContextSnapshot | undefined) ??
            null);
    const tags =
        (s.context_tags as ContextTag[] | undefined) ??
        ((s.feature_snapshot?.context_tags as ContextTag[] | undefined) ?? []);
    const alignment =
        (s.context_alignment as ContextAlignment | undefined) ??
        ((s.feature_snapshot?.context_alignment as
            | ContextAlignment
            | undefined) ?? null);
    return { snap, tags, alignment };
}

export function joinWithContext(
    signals: StrategySignal[],
    outcomes: SignalOutcome[],
): SignalWithContext[] {
    const om = new Map(outcomes.map((o) => [o.signal_id, o]));
    return signals.map((s) => {
        const { snap, tags, alignment } = readContextFromSignal(s);
        return { s, o: om.get(s.signal_id) ?? null, snap, tags, alignment };
    });
}

export function filterResearchRows(
    rows: SignalWithContext[],
    opts: {
        signal_type?: string;
        from?: string;
        to?: string;
        market_regime?: string;
        sector_state?: string;
        event_state?: string;
        min_confidence?: 'LOW' | 'MEDIUM' | 'HIGH';
        learning_eligible_only?: boolean;
        require_context_quality?: boolean;
        cfg?: ContextResearchConfig;
    } = {},
): SignalWithContext[] {
    const cfg = opts.cfg ?? DEFAULT_CR_CONFIG;
    return rows.filter((r) => {
        if (opts.signal_type && r.s.signal_type !== opts.signal_type) return false;
        if (opts.from && r.s.signal_time.slice(0, 10) < opts.from) return false;
        if (opts.to && r.s.signal_time.slice(0, 10) > opts.to) return false;
        if (
            opts.learning_eligible_only !== false &&
            !r.s.learning_eligible
        ) {
            return false;
        }
        if (opts.market_regime && r.snap?.taiwan_regime !== opts.market_regime) {
            return false;
        }
        if (
            opts.sector_state &&
            r.snap?.sector_rotation_state !== opts.sector_state
        ) {
            return false;
        }
        if (
            opts.event_state &&
            r.snap?.event_confirmation_state !== opts.event_state
        ) {
            return false;
        }
        if (opts.require_context_quality !== false && r.snap) {
            if (
                !passesContextQuality(
                    r.snap.context_coverage_pct,
                    r.snap.context_confidence,
                    cfg,
                )
            ) {
                return false;
            }
        }
        if (opts.min_confidence && r.snap) {
            const rank = { LOW: 1, MEDIUM: 2, HIGH: 3 };
            if (
                rank[r.snap.context_confidence] <
                rank[opts.min_confidence]
            ) {
                return false;
            }
        }
        return true;
    });
}

export function cohortStats(
    rows: SignalWithContext[],
    cohort_id: string,
    label: string,
    cfg: ContextResearchConfig = DEFAULT_CR_CONFIG,
): CohortStatRow {
    const withOutcome = rows.filter((r) => r.o != null);
    const fr5 = withOutcome
        .map((r) => r.o!.forward_return_5m)
        .filter((x): x is number => x != null);
    const fr15 = withOutcome
        .map((r) => r.o!.forward_return_15m)
        .filter((x): x is number => x != null);
    const mfe = withOutcome
        .map((r) => r.o!.mfe_15m)
        .filter((x): x is number => x != null);
    const mae = withOutcome
        .map((r) => r.o!.mae_15m)
        .filter((x): x is number => x != null);
    const invN = withOutcome.filter((r) => r.o!.invalid_hit != null).length;
    const n = withOutcome.length;
    const guard = sampleGuardLabel(n, cfg);
    return {
        cohort_id,
        label,
        n,
        sample_guard: guard,
        positive_5m_rate: rate(fr5.filter((x) => x > 0).length, fr5.length),
        positive_15m_rate: rate(fr15.filter((x) => x > 0).length, fr15.length),
        median_forward_return_15m: median(fr15),
        median_mfe_15m: median(mfe),
        median_mae_15m: median(mae),
        invalid_hit_rate: rate(
            withOutcome.filter((r) => r.o!.invalid_hit).length,
            invN,
        ),
        coverage_note:
            guard === 'INSUFFICIENT_DATA'
                ? 'n 過低，不得下高可信結論'
                : guard === 'EXPLORATORY'
                  ? '探索性樣本'
                  : null,
    };
}

export function marketAttribution(
    rows: SignalWithContext[],
    cfg?: ContextResearchConfig,
): CohortStatRow[] {
    const regimes = [
        'RISK_ON_BROAD',
        'RISK_ON_NARROW',
        'NEUTRAL',
        'RISK_OFF_NARROW',
        'RISK_OFF_BROAD',
    ];
    return regimes.map((reg) =>
        cohortStats(
            rows.filter((r) => r.snap?.taiwan_regime === reg),
            `MARKET_${reg}`,
            reg,
            cfg,
        ),
    );
}

export function sectorAttribution(
    rows: SignalWithContext[],
    cfg?: ContextResearchConfig,
): CohortStatRow[] {
    const states = [
        'ROTATING_IN',
        'HOT',
        'STABLE',
        'ROTATING_OUT',
        'COLD',
    ];
    const out = states.map((st) =>
        cohortStats(
            rows.filter((r) => r.snap?.sector_rotation_state === st),
            `SECTOR_${st}`,
            st,
            cfg,
        ),
    );
    out.push(
        cohortStats(
            rows.filter((r) => r.tags.includes('SECTOR_BROAD_STRENGTH')),
            'SECTOR_BROAD_STRENGTH',
            'Broad Strength',
            cfg,
        ),
        cohortStats(
            rows.filter((r) => r.tags.includes('SECTOR_HIGH_CONCENTRATION')),
            'SECTOR_HIGH_CONCENTRATION',
            'High Concentration',
            cfg,
        ),
    );
    return out;
}

export function eventAttribution(
    rows: SignalWithContext[],
    cfg?: ContextResearchConfig,
): CohortStatRow[] {
    return [
        cohortStats(
            rows.filter(
                (r) =>
                    !r.snap?.event_confirmation_state ||
                    r.snap.active_events.length === 0,
            ),
            'NO_EVENT',
            'NO_EVENT',
            cfg,
        ),
        cohortStats(
            rows.filter(
                (r) =>
                    r.tags.includes('EVENT_RELEVANT') &&
                    r.tags.includes('EVENT_UNCONFIRMED'),
            ),
            'EVENT_RELEVANT_UNCONFIRMED',
            'EVENT_RELEVANT_UNCONFIRMED',
            cfg,
        ),
        cohortStats(
            rows.filter((r) => r.tags.includes('EVENT_CONFIRMED')),
            'EVENT_MARKET_CONFIRMED',
            'EVENT_MARKET_CONFIRMED',
            cfg,
        ),
        cohortStats(
            rows.filter(
                (r) => r.snap?.event_confirmation_state === 'EVENT_REJECTED',
            ),
            'EVENT_REJECTED',
            'EVENT_REJECTED',
            cfg,
        ),
    ];
}

export function eventTypeAttribution(
    rows: SignalWithContext[],
    cfg?: ContextResearchConfig,
): CohortStatRow[] {
    const types = new Map<string, SignalWithContext[]>();
    for (const r of rows) {
        for (const e of r.snap?.active_events ?? []) {
            const k = e.event_type || 'OTHER';
            if (!types.has(k)) types.set(k, []);
            types.get(k)!.push(r);
        }
    }
    return [...types.entries()].map(([t, list]) =>
        cohortStats(list, `EVENT_TYPE_${t}`, t, cfg),
    );
}

export function shadowCohorts(
    rows: SignalWithContext[],
    cfg?: ContextResearchConfig,
): CohortStatRow[] {
    const defs: Array<{
        id: ShadowCohortId;
        label: string;
        pred: (r: SignalWithContext) => boolean;
    }> = [
        { id: 'BASELINE', label: 'Baseline (Production Signal)', pred: () => true },
        {
            id: 'SHADOW_CONTEXT_MARKET',
            label: 'Market Aligned',
            pred: (r) =>
                r.alignment === 'ALIGNED' ||
                r.tags.includes('MARKET_RISK_ON'),
        },
        {
            id: 'SHADOW_CONTEXT_SECTOR',
            label: 'Sector ROTATING_IN',
            pred: (r) => r.tags.includes('SECTOR_ROTATING_IN'),
        },
        {
            id: 'SHADOW_CONTEXT_EVENT',
            label: 'Event Confirmed',
            pred: (r) => r.tags.includes('EVENT_CONFIRMED'),
        },
        {
            id: 'SHADOW_CONTEXT_FULL',
            label: 'Market + Sector + Event',
            pred: (r) =>
                (r.alignment === 'ALIGNED' ||
                    r.tags.includes('MARKET_RISK_ON')) &&
                r.tags.includes('SECTOR_ROTATING_IN') &&
                r.tags.includes('EVENT_CONFIRMED'),
        },
    ];
    return defs.map((d) =>
        cohortStats(rows.filter(d.pred), d.id, d.label, cfg),
    );
}

export function combinationAnalytics(
    rows: SignalWithContext[],
    cfg?: ContextResearchConfig,
): CohortStatRow[] {
    return [
        cohortStats(rows, 'GROUP_A', 'Signal only', cfg),
        cohortStats(
            rows.filter((r) => r.alignment === 'ALIGNED'),
            'GROUP_B',
            'Signal + Market Aligned',
            cfg,
        ),
        cohortStats(
            rows.filter((r) => r.tags.includes('SECTOR_ROTATING_IN')),
            'GROUP_C',
            'Signal + Sector ROTATING_IN',
            cfg,
        ),
        cohortStats(
            rows.filter(
                (r) =>
                    r.alignment === 'ALIGNED' &&
                    r.tags.includes('SECTOR_ROTATING_IN'),
            ),
            'GROUP_D',
            'Signal + Sector + Market aligned',
            cfg,
        ),
        cohortStats(
            rows.filter((r) => r.tags.includes('EVENT_CONFIRMED')),
            'GROUP_E',
            'Signal + Event Confirmed',
            cfg,
        ),
        cohortStats(
            rows.filter(
                (r) =>
                    r.tags.includes('SECTOR_ROTATING_IN') &&
                    r.tags.includes('EVENT_CONFIRMED'),
            ),
            'GROUP_F',
            'Signal + Sector + Event Confirmed',
            cfg,
        ),
        cohortStats(
            rows.filter((r) => r.alignment === 'CONTRARY'),
            'GROUP_G',
            'Signal strong but Context Contrary',
            cfg,
        ),
    ];
}

export function dailyContextSummary(
    rows: SignalWithContext[],
    date: string,
    cfg?: ContextResearchConfig,
): DailyContextResearchSummary {
    const day = rows.filter((r) => r.s.signal_time.startsWith(date));
    const withSnap = day.filter((r) => r.snap != null);
    const cov =
        withSnap.length > 0
            ? avg(withSnap.map((r) => r.snap!.context_coverage_pct))
            : null;
    return {
        date,
        signals: day.length,
        context_coverage_pct: cov,
        market_aligned: day.filter((r) => r.alignment === 'ALIGNED').length,
        sector_rotating_in: day.filter((r) =>
            r.tags.includes('SECTOR_ROTATING_IN'),
        ).length,
        event_confirmed: day.filter((r) =>
            r.tags.includes('EVENT_CONFIRMED'),
        ).length,
        contrary: day.filter((r) => r.alignment === 'CONTRARY').length,
        insufficient_context: day.filter(
            (r) => r.alignment === 'INSUFFICIENT_DATA' || !r.snap,
        ).length,
        completed_outcome_stats: combinationAnalytics(
            day.filter((r) => r.o && r.o.status === 'complete'),
            cfg,
        ),
        note: 'Research summary only — 不產生明日買什麼；不改正式策略。',
        mutates_strategy: false,
    };
}
