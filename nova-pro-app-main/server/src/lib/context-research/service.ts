// server/src/lib/context-research/service.ts
// Context Research service — read-only analytics over immutable snapshots.

import type { MarketContextRuntime } from '../market-context/market-context-runtime.ts';
import type { EventIntelligenceService } from '../event-intelligence/event-intelligence-service.ts';
import {
    JsonlStrategySignalRepository,
    type StrategySignalRepository,
} from '../strategy-signal/repository.ts';
import {
    JsonlSignalOutcomeRepository,
    type SignalOutcomeRepository,
} from '../signal-outcome/repository.ts';
import { SectorMapper } from '../market-intelligence/sector/sector-mapper.ts';
import {
    combinationAnalytics,
    dailyContextSummary,
    eventAttribution,
    eventTypeAttribution,
    filterResearchRows,
    joinWithContext,
    marketAttribution,
    readContextFromSignal,
    sectorAttribution,
    shadowCohorts,
} from './analytics.ts';
import { buildContextBundle, type CaptureInput } from './capture.ts';
import type { ContextResearchConfig } from './config.ts';
import { DEFAULT_CR_CONFIG } from './config.ts';
import type { ContextBundle } from './types.ts';
import { CR_VERSION } from './types.ts';

export class ContextResearchService {
    readonly cfg: ContextResearchConfig;
    private signalRepo: StrategySignalRepository;
    private outcomeRepo: SignalOutcomeRepository;
    private mapper = new SectorMapper();
    private industryReady = false;

    constructor(
        private marketContext: MarketContextRuntime | null,
        private eventIntelligence: EventIntelligenceService | null,
        signalRepo?: StrategySignalRepository,
        outcomeRepo?: SignalOutcomeRepository,
        cfg?: ContextResearchConfig,
    ) {
        this.cfg = cfg ?? { ...DEFAULT_CR_CONFIG };
        this.signalRepo = signalRepo ?? new JsonlStrategySignalRepository();
        this.outcomeRepo = outcomeRepo ?? new JsonlSignalOutcomeRepository();
        void this.mapper.ensureLoaded().then(() => {
            this.industryReady = true;
        });
    }

    getHealth() {
        return {
            enabled: this.cfg.enabled,
            version: CR_VERSION,
            mutates_strategy: false as const,
            creates_upstream_subscription: false as const,
            note: 'Context research / shadow cohorts only — never mutates A/B/C/BP.',
        };
    }

    /** Point-in-time capture for a new signal — used by StrategySignalBridge. */
    captureForSignal(input: {
        symbol: string;
        signalTime: string;
        sourceMode: 'live' | 'replay';
        override?: CaptureInput['overrideSnapshot'];
    }): ContextBundle | null {
        if (!this.cfg.enabled) return null;
        return buildContextBundle({
            symbol: input.symbol,
            signalTime: input.signalTime,
            sourceMode: input.sourceMode,
            marketContext: this.marketContext,
            eventIntelligence: this.eventIntelligence,
            industryOf: (s) =>
                this.industryReady
                    ? this.mapper.industryOf(s)?.industry ?? null
                    : null,
            cfg: this.cfg,
            overrideSnapshot: input.override,
        });
    }

    private loadRows(from?: string, to?: string) {
        const today = new Date().toISOString().slice(0, 10);
        const fromY = from ?? today;
        const toY = to ?? today;
        const signals = this.signalRepo.listRange(fromY, toY);
        const outcomes = this.outcomeRepo.materializeRange(fromY, toY);
        return joinWithContext(signals, outcomes);
    }

    overview(query: Record<string, string | undefined> = {}) {
        const rows = filterResearchRows(this.loadRows(query.from, query.to), {
            signal_type: query.signal_type,
            from: query.from,
            to: query.to,
            market_regime: query.market_regime,
            sector_state: query.sector_state,
            event_state: query.event_state,
            min_confidence: query.min_confidence as never,
            cfg: this.cfg,
        });
        return {
            version: CR_VERSION,
            mutates_strategy: false as const,
            signal_count: rows.length,
            shadow_cohorts: shadowCohorts(rows, this.cfg),
            combinations: combinationAnalytics(rows, this.cfg),
            daily: dailyContextSummary(
                rows,
                (query.to ?? query.from ?? new Date().toISOString().slice(0, 10)),
                this.cfg,
            ),
        };
    }

    market(query: Record<string, string | undefined> = {}) {
        const rows = filterResearchRows(this.loadRows(query.from, query.to), {
            signal_type: query.signal_type,
            from: query.from,
            to: query.to,
            cfg: this.cfg,
        });
        return {
            items: marketAttribution(rows, this.cfg),
            mutates_strategy: false as const,
        };
    }

    sectors(query: Record<string, string | undefined> = {}) {
        const rows = filterResearchRows(this.loadRows(query.from, query.to), {
            signal_type: query.signal_type,
            from: query.from,
            to: query.to,
            cfg: this.cfg,
        });
        return {
            items: sectorAttribution(rows, this.cfg),
            mutates_strategy: false as const,
        };
    }

    events(query: Record<string, string | undefined> = {}) {
        const rows = filterResearchRows(this.loadRows(query.from, query.to), {
            signal_type: query.signal_type,
            from: query.from,
            to: query.to,
            cfg: this.cfg,
        });
        return {
            confirmation: eventAttribution(rows, this.cfg),
            by_type: eventTypeAttribution(rows, this.cfg),
            mutates_strategy: false as const,
        };
    }

    combinations(query: Record<string, string | undefined> = {}) {
        const rows = filterResearchRows(this.loadRows(query.from, query.to), {
            signal_type: query.signal_type,
            from: query.from,
            to: query.to,
            cfg: this.cfg,
        });
        return {
            items: combinationAnalytics(rows, this.cfg),
            shadow: shadowCohorts(rows, this.cfg),
            mutates_strategy: false as const,
        };
    }

    signalDetail(signalId: string) {
        const sig = this.signalRepo.findById(signalId);
        if (!sig) return null;
        const { snap, tags, alignment } = readContextFromSignal(sig);
        return {
            signal_id: sig.signal_id,
            symbol: sig.symbol,
            signal_type: sig.signal_type,
            signal_time: sig.signal_time,
            context_snapshot: snap,
            context_tags: tags,
            context_alignment: alignment,
            context_strength_score:
                (sig.context_strength_score as number | undefined) ??
                (sig.feature_snapshot?.context_strength_score as
                    | number
                    | undefined) ??
                null,
            note: '當時背景（Point-In-Time）— 不可事後改寫',
            mutates_strategy: false as const,
        };
    }
}
