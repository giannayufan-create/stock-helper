// server/src/lib/radar-rescue/news-judge.ts
// Reuses EventIntelligence — does NOT create a second news crawler.
// AI / news NEVER alone creates ACTIVE or Focus.

import type { EventIntelligenceService } from '../event-intelligence/index.ts';
import type { BuyPressureItem } from '../buy-pressure/types.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';
import type { RadarRescueConfig } from './config.ts';
import type { NewsMarketState, RescueNewsJudgement } from './types.ts';

export function judgeNewsForSymbol(
    cfg: RadarRescueConfig,
    eventIntel: EventIntelligenceService | null,
    symbol: string,
    opts: {
        c?: IntradayRankItem | null;
        bp?: BuyPressureItem | null;
        sectorRising?: boolean;
    },
): {
    state: NewsMarketState;
    confidence: number;
    judgements: RescueNewsJudgement[];
    opportunityAdj: number;
} {
    if (!eventIntel) {
        return {
            state: 'NO_RELEVANT_NEWS',
            confidence: 0,
            judgements: [],
            opportunityAdj: 0,
        };
    }

    const health = eventIntel.getHealth?.() ?? null;
    void health;
    // Pull active events / exposures if available
    let events: Array<Record<string, unknown>> = [];
    try {
        const list = eventIntel.getActive?.() ?? [];
        events = Array.isArray(list)
            ? (list as unknown as Array<Record<string, unknown>>)
            : [];
    } catch {
        events = [];
    }

    const related = events.filter((ev) => {
        const companies = (ev.companies as string[] | undefined) ?? [];
        const entities = (ev.entities as string[] | undefined) ?? [];
        return (
            companies.includes(symbol) ||
            entities.includes(symbol) ||
            String(ev.title ?? '').includes(symbol)
        );
    });

    if (!related.length) {
        // Try exposure map
        try {
            const exp = (
                eventIntel as unknown as {
                    getExposure?: (s: string) => { themes?: string[] } | null;
                }
            ).getExposure?.(symbol);
            if (!exp?.themes?.length) {
                return {
                    state: 'NO_RELEVANT_NEWS',
                    confidence: 0,
                    judgements: [],
                    opportunityAdj: 0,
                };
            }
        } catch {
            return {
                state: 'NO_RELEVANT_NEWS',
                confidence: 0,
                judgements: [],
                opportunityAdj: 0,
            };
        }
    }

    const judgements: RescueNewsJudgement[] = related.slice(0, 5).map((ev, i) => {
        const sev = String(ev.severity ?? ev.impact ?? 'medium').toLowerCase();
        const impact_strength =
            sev.includes('high') ? 'HIGH' : sev.includes('low') ? 'LOW' : 'MEDIUM';
        const dirRaw = String(ev.direction ?? ev.sentiment ?? 'unknown').toUpperCase();
        const impact_direction = (
            ['POSITIVE', 'NEGATIVE', 'MIXED', 'NEUTRAL'].includes(dirRaw)
                ? dirRaw
                : 'UNKNOWN'
        ) as RescueNewsJudgement['impact_direction'];
        return {
            news_id: String(ev.id ?? ev.event_id ?? `news_${symbol}_${i}`),
            published_at: (ev.published_at as string) ?? null,
            observed_at: new Date().toISOString(),
            source: String(ev.source ?? 'event_intelligence'),
            headline: String(ev.title ?? ev.headline ?? ''),
            event_type: String(ev.event_type ?? 'UNKNOWN'),
            symbols: [symbol],
            sectors: (ev.industries as string[]) ?? [],
            relevance_score: Number(ev.relevance ?? 60) || 60,
            impact_direction,
            impact_strength,
            impact_horizon: 'INTRADAY',
            confidence: Number(ev.confidence ?? 55) || 55,
            reason: String(ev.reason ?? 'event_match'),
            evidence: [],
            freshness: String(ev.freshness ?? 'unknown'),
        };
    });

    const top = judgements[0];
    if (!top) {
        return {
            state: 'UNKNOWN',
            confidence: 20,
            judgements: [],
            opportunityAdj: 0,
        };
    }

    const bpFalling =
        (opts.bp?.volume_acceleration_slope ?? 0) < 0 ||
        opts.bp?.primary_state === 'COOLING';
    const rankNeg = (opts.c?.rank_velocity ?? opts.bp?.rank_velocity ?? 0) < 0;
    const vwapBelow =
        (opts.c?.metrics?.vwap_pos_pct ?? opts.bp?.distance_from_vwap_pct ?? 0) < 0;
    const marketConfirm =
        !!opts.sectorRising &&
        !bpFalling &&
        !rankNeg &&
        !vwapBelow &&
        ((opts.bp?.buy_pressure_score ?? 0) > 0
            ? (opts.bp?.rvol_accel === 'ACCELERATING' ||
                  (opts.bp?.volume_acceleration_slope ?? 0) > 0)
            : (opts.c?.rank_velocity ?? 0) > 0);

    let state: NewsMarketState = 'UNKNOWN';
    if (top.impact_direction === 'POSITIVE') {
        state = marketConfirm ? 'POSITIVE_CONFIRMED' : 'POSITIVE_UNCONFIRMED';
    } else if (top.impact_direction === 'NEGATIVE') {
        state = marketConfirm ? 'NEGATIVE_CONFIRMED' : 'NEGATIVE_UNCONFIRMED';
    } else if (top.impact_direction === 'MIXED') {
        state = 'MIXED';
    } else {
        state = 'NO_RELEVANT_NEWS';
    }

    let adj = 0;
    if (state === 'POSITIVE_CONFIRMED') adj = Math.min(cfg.news_adjustment_max, 4);
    else if (state === 'POSITIVE_UNCONFIRMED') adj = Math.min(cfg.news_adjustment_max, 2);
    else if (state === 'NEGATIVE_CONFIRMED') adj = -Math.min(cfg.news_adjustment_max, 4);
    else if (state === 'NEGATIVE_UNCONFIRMED') adj = -Math.min(cfg.news_adjustment_max, 2);

    return {
        state,
        confidence: top.confidence,
        judgements,
        opportunityAdj: adj,
    };
}

/** News alone must never force ACTIVE. */
export function newsCannotCreateActive(state: NewsMarketState): boolean {
    return (
        state === 'POSITIVE_UNCONFIRMED' ||
        state === 'NO_RELEVANT_NEWS' ||
        state === 'UNKNOWN' ||
        state === 'STALE'
    );
}
