// server/src/lib/context-research/capture.ts
// Point-in-time Context Snapshot — captured_at <= signal_time only.
// NEVER backfill future news / confirmation / sector ranks.

import { createHash } from 'node:crypto';
import type { MarketContextRuntime } from '../market-context/market-context-runtime.ts';
import { MC_VERSION } from '../market-context/types.ts';
import type { EventIntelligenceService } from '../event-intelligence/event-intelligence-service.ts';
import { EI_VERSION } from '../event-intelligence/types.ts';
import { SectorMapper } from '../market-intelligence/sector/sector-mapper.ts';
import { deriveContextAlignment } from './alignment.ts';
import type { ContextResearchConfig } from './config.ts';
import { DEFAULT_CR_CONFIG } from './config.ts';
import { computeContextStrength } from './strength.ts';
import { deriveContextTags } from './tags.ts';
import type {
    ActiveEventSnap,
    ContextBundle,
    ContextSnapshot,
} from './types.ts';
import {
    CONFIRMATION_VERSION,
    CONTEXT_SNAPSHOT_VERSION,
    EXPOSURE_MAP_VERSION,
    SECTOR_ROTATION_VERSION,
} from './types.ts';

export interface CaptureInput {
    symbol: string;
    signalTime: string;
    sourceMode: 'live' | 'replay';
    marketContext: MarketContextRuntime | null;
    eventIntelligence: EventIntelligenceService | null;
    industryOf?: (symbol: string) => string | null;
    cfg?: ContextResearchConfig;
    /** Test / replay inject — if set, used instead of live services. */
    overrideSnapshot?: Partial<ContextSnapshot>;
}

function configHash(cfg: ContextResearchConfig): string {
    return createHash('sha256')
        .update(JSON.stringify(cfg))
        .digest('hex')
        .slice(0, 12);
}

function tMs(iso: string | null | undefined): number | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : null;
}

/** Keep only events whose published/observed time is <= signal_time. */
export function filterEventsPointInTime(
    events: ActiveEventSnap[],
    signalTime: string,
): ActiveEventSnap[] {
    const cut = tMs(signalTime);
    if (cut == null) return [];
    return events.filter((e) => {
        const pub = tMs(e.published_at);
        // If no published_at, treat as unavailable for PIT (don't invent)
        if (pub == null) return false;
        return pub <= cut;
    });
}

/** Freeze confirmation state as provided — caller must not pass future status. */
export function buildContextBundle(input: CaptureInput): ContextBundle {
    const cfg = input.cfg ?? DEFAULT_CR_CONFIG;
    const signalTime = input.signalTime;
    const captured_at = signalTime; // PIT: snapshot time = signal time

    const emptyInst = {
        available: false as const,
        realtime_level: 'PREVIOUS_DAY' as const,
        note: '三大法人為 PREVIOUS_DAY／EOD；非即時外資動態',
    };
    const proxy = {
        available: false as const,
        proxy: true as const,
        not_actual_foreign_identity: true as const,
        note: 'INSTITUTIONAL_RISK_PROXY — NOT ACTUAL FOREIGN IDENTITY',
    };

    const feature_availability: Record<string, boolean> = {
        global_regime: false,
        taiwan_regime: false,
        market_breadth: false,
        sector_rotation: false,
        capital_rotation: false,
        sector_breadth: false,
        sector_rs: false,
        event_confirmation: false,
        company_exposure: false,
        institutional_eod: false,
    };

    let snap: ContextSnapshot = {
        global_regime: null,
        taiwan_regime: null,
        market_breadth: null,
        market_turnover_acceleration: null,
        sector: null,
        sector_rank: null,
        sector_rank_change: null,
        sector_rank_velocity: null,
        sector_rotation_state: null,
        sector_turnover_share: null,
        sector_turnover_share_delta: null,
        sector_breadth: null,
        sector_relative_strength: null,
        capital_rotation_score: null,
        sector_c_strong_count: null,
        sector_bp_strong_count: null,
        leader_concentration: null,
        institutional_eod_context: emptyInst,
        institutional_risk_proxy: proxy,
        active_events: [],
        event_relevance_score: null,
        event_market_confirmation_score: null,
        event_confirmation_state: null,
        company_exposure_confidence: null,
        feature_availability,
        context_coverage_pct: 0,
        context_confidence: 'LOW',
        context_source_mode: input.sourceMode === 'replay' ? 'REPLAY' : 'LIVE',
        captured_at,
        market_context_version: MC_VERSION,
        sector_rotation_version: SECTOR_ROTATION_VERSION,
        event_engine_version: EI_VERSION,
        exposure_map_version: EXPOSURE_MAP_VERSION,
        confirmation_version: CONFIRMATION_VERSION,
        config_hash: configHash(cfg),
        schema_version: CONTEXT_SNAPSHOT_VERSION,
    };

    // Replay without reconstructable context → available=false (no future leak)
    if (input.sourceMode === 'replay' && !input.overrideSnapshot) {
        // Keep empty availabilities
    } else if (input.overrideSnapshot) {
        snap = {
            ...snap,
            ...input.overrideSnapshot,
            captured_at,
            feature_availability: {
                ...feature_availability,
                ...(input.overrideSnapshot.feature_availability ?? {}),
            },
        };
    } else {
        const mc = input.marketContext;
        const ov = mc?.getOverview() ?? null;
        if (ov) {
            snap.global_regime = ov.global_regime?.state ?? null;
            snap.taiwan_regime = ov.taiwan_regime?.state ?? null;
            snap.market_breadth = ov.breadth?.advance_pct ?? null;
            snap.market_turnover_acceleration =
                ov.taiwan_regime?.turnover_acceleration ?? null;
            feature_availability.global_regime = !!snap.global_regime;
            feature_availability.taiwan_regime = !!snap.taiwan_regime;
            feature_availability.market_breadth = snap.market_breadth != null;

            snap.institutional_eod_context = {
                available: ov.institutional_eod?.available ?? false,
                realtime_level: 'PREVIOUS_DAY',
                note:
                    ov.institutional_eod?.note ??
                    emptyInst.note,
            };
            feature_availability.institutional_eod =
                snap.institutional_eod_context.available;

            const industry =
                input.industryOf?.(input.symbol) ??
                null;
            const sectors = mc?.getSectors() ?? [];
            let row =
                industry != null
                    ? sectors.find(
                          (s) =>
                              s.sector === industry ||
                              s.sector.includes(industry) ||
                              industry.includes(s.sector),
                      )
                    : null;
            if (!row && sectors.length) {
                // no industry match — leave sector unavailable (don't guess HOT)
                row = null;
            }
            if (row) {
                snap.sector = row.sector;
                snap.sector_rank = row.sector_rank;
                snap.sector_rank_change = row.sector_rank_change;
                snap.sector_rank_velocity = row.sector_rank_velocity;
                snap.sector_rotation_state = row.state;
                snap.sector_turnover_share = row.turnover_share;
                snap.sector_turnover_share_delta = row.turnover_share_delta;
                snap.sector_breadth = row.breadth;
                snap.sector_relative_strength = row.sector_relative_strength;
                snap.capital_rotation_score = row.capital_rotation_score;
                snap.sector_c_strong_count = row.c_strong_count;
                snap.sector_bp_strong_count = row.bp_strong_count;
                snap.leader_concentration = row.high_concentration;
                feature_availability.sector_rotation = true;
                feature_availability.capital_rotation =
                    row.capital_rotation_score != null;
                feature_availability.sector_breadth = row.breadth != null;
                feature_availability.sector_rs =
                    row.sector_relative_strength != null;
            }
        }

        const ei = input.eventIntelligence;
        if (ei) {
            const active = ei.getActive();
            const rawSnaps: ActiveEventSnap[] = active.map((e) => {
                const conf = ei.getConfirmation(e.event_id);
                return {
                    event_id: e.event_id,
                    event_type: e.event_type,
                    title: e.title,
                    confirmation_state: conf?.status ?? null,
                    event_relevance: e.event_relevance,
                    market_confirmation_score:
                        conf?.market_confirmation_score ?? null,
                    published_at: e.published_at,
                    available: true,
                };
            });
            // PIT filter — drop news published after signal_time
            snap.active_events = filterEventsPointInTime(rawSnaps, signalTime);

            let best: ActiveEventSnap | null = null;
            for (const a of snap.active_events) {
                if (
                    !best ||
                    (a.event_relevance ?? 0) > (best.event_relevance ?? 0)
                ) {
                    best = a;
                }
            }
            if (best) {
                snap.event_relevance_score = best.event_relevance;
                snap.event_market_confirmation_score =
                    best.market_confirmation_score;
                snap.event_confirmation_state = best.confirmation_state;
                feature_availability.event_confirmation = true;

                try {
                    const exp = ei.getExposure(
                        input.symbol,
                        best.event_type as never,
                    );
                    snap.company_exposure_confidence = exp.overall_confidence;
                    feature_availability.company_exposure =
                        exp.exposures.length > 0;
                } catch {
                    snap.company_exposure_confidence = null;
                }
            } else {
                // Event engine on but no PIT-eligible events
                feature_availability.event_confirmation = false;
            }
        } else {
            // Event unavailable — signal still ok
            feature_availability.event_confirmation = false;
        }

        snap.feature_availability = { ...feature_availability };
    }

    const keys = Object.keys(snap.feature_availability);
    const availCount = keys.filter((k) => snap.feature_availability[k]).length;
    snap.context_coverage_pct =
        keys.length > 0
            ? Math.round((availCount / keys.length) * 1000) / 10
            : 0;
    snap.context_confidence =
        snap.context_coverage_pct >= 70
            ? 'HIGH'
            : snap.context_coverage_pct >= 40
              ? 'MEDIUM'
              : 'LOW';

    const tags = deriveContextTags(snap);
    const alignment = deriveContextAlignment(snap, tags);
    const strength = computeContextStrength(snap, cfg);

    return {
        context_snapshot: Object.freeze({ ...snap }) as ContextSnapshot,
        context_tags: tags,
        context_alignment: alignment,
        context_strength_score: strength,
    };
}

/** Helper used by bridge to resolve industry via SectorMapper. */
export async function resolveIndustryMapper(): Promise<
    (symbol: string) => string | null
> {
    const mapper = new SectorMapper();
    await mapper.ensureLoaded().catch(() => undefined);
    return (s) => mapper.industryOf(s)?.industry ?? null;
}
