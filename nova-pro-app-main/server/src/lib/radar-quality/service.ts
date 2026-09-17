// server/src/lib/radar-quality/service.ts
// Radar Quality Upgrade v1 orchestrator — Decision Support only.

import type { BuyPressureService } from '../buy-pressure/index.ts';
import type { BuyPressureItem } from '../buy-pressure/types.ts';
import type { DecisionSummaryService } from '../decision-summary/index.ts';
import type { IntradayRankService } from '../intraday-rank/service.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';
import type { MarketContextRuntime } from '../market-context/index.ts';
import type { SectorRotationRow } from '../market-context/types.ts';
import { SectorMapper } from '../market-intelligence/sector/sector-mapper.ts';
import {
    loadRadarQualityConfig,
    type RadarQualityConfig,
} from './config.ts';
import {
    computeFocusScore,
    selectFocusTop3,
    type FocusLeaderState,
} from './focus.ts';
import {
    attachContinuation,
    backgroundLabel,
    continuationLabel,
    loadInstitutionalMap,
} from './institutional.ts';
import {
    applyHysteresis,
    evaluateMomentum,
    evaluateRawMomentum,
    type HysteresisState,
} from './momentum.ts';
import {
    RQ_VERSION,
    type RadarQualityBatch,
    type RadarQualityInput,
    type RadarQualityItem,
} from './types.ts';

export class RadarQualityService {
    readonly cfg: RadarQualityConfig;
    private timer: ReturnType<typeof setInterval> | null = null;
    private last: RadarQualityBatch | null = null;
    private bySymbol = new Map<string, RadarQualityItem>();
    private hyst = new Map<string, HysteresisState>();
    private focusLeader: FocusLeaderState | null = null;
    private startedAt = Date.now();
    private mapper = new SectorMapper();

    constructor(
        private intradayRank: IntradayRankService,
        private buyPressure: BuyPressureService | null,
        private marketContext: MarketContextRuntime | null,
        private decisionSummary: DecisionSummaryService | null,
        cfg?: RadarQualityConfig,
    ) {
        this.cfg = cfg ?? loadRadarQualityConfig();
    }

    start(): void {
        if (!this.cfg.enabled) return;
        if (this.timer) return;
        void this.mapper.ensureLoaded().catch(() => undefined);
        void this.evaluate();
        this.timer = setInterval(() => {
            void this.evaluate();
        }, Math.max(2, this.cfg.evaluate_interval_sec) * 1000);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    getHealth() {
        return {
            enabled: this.cfg.enabled,
            status: this.cfg.enabled ? 'OK' : 'DISABLED',
            version: RQ_VERSION,
            count: this.bySymbol.size,
            focus_count: this.last?.focus_top3.length ?? 0,
            as_of: this.last?.as_of ?? null,
            uptime_ms: Date.now() - this.startedAt,
            mutates_strategy: false as const,
            intraday_foreign_identity: 'NOT_AVAILABLE' as const,
        };
    }

    getLastBatch(): RadarQualityBatch | null {
        return this.last;
    }

    getSymbol(symbol: string): RadarQualityItem | null {
        return this.bySymbol.get(symbol) ?? null;
    }

    getFocusTop3() {
        return this.last?.focus_top3 ?? [];
    }

    list(limit = 80): RadarQualityBatch {
        if (this.last) {
            return {
                ...this.last,
                items: this.last.items.slice(0, limit),
                count: Math.min(this.last.items.length, limit),
            };
        }
        return this.emptyBatch();
    }

    listByMomentum(
        states: string[],
        limit = 40,
    ): RadarQualityBatch {
        const batch = this.list(200);
        const set = new Set(states.map((s) => s.toUpperCase()));
        const items = batch.items
            .filter((i) => set.has(i.momentum_state))
            .slice(0, limit);
        return { ...batch, items, count: items.length };
    }

    async evaluate(): Promise<RadarQualityBatch> {
        const nowIso = new Date().toISOString();
        const nowMs = Date.now();
        await this.mapper.ensureLoaded().catch(() => undefined);

        const batch = this.intradayRank.getLastBatch();
        const overview = this.marketContext?.getOverview() ?? null;
        const regime = overview?.taiwan_regime?.state ?? null;
        const symbols = (batch?.items ?? []).map((i) => i.symbol);
        const instMap = await loadInstitutionalMap(symbols, this.cfg);

        const items: RadarQualityItem[] = [];
        const seen = new Set<string>();

        for (const c of batch?.items ?? []) {
            seen.add(c.symbol);
            const bp = this.buyPressure?.getSymbol(c.symbol) ?? null;
            const industry = this.mapper.industryOf(c.symbol)?.industry ?? null;
            const sectorRow: SectorRotationRow | null = industry
                ? this.marketContext?.getSector(industry) ?? null
                : null;
            const ds = this.decisionSummary?.getSymbol(c.symbol) ?? null;
            let inst = instMap.get(c.symbol)!;

            const input = this.buildInput(c, bp, {
                regime,
                sectorRow,
                decisionStatus: ds?.status ?? null,
                institutional: inst,
            });
            inst = attachContinuation(inst, input);
            input.institutional = inst;

            const prior = this.hyst.get(c.symbol);
            const mom = evaluateMomentum(input, this.cfg, prior);
            this.hyst.set(c.symbol, {
                displayed: mom.state,
                enter_hits: mom.enter_hits,
                exit_hits: mom.exit_hits,
            });

            const focusScore = computeFocusScore({
                momentum_state: mom.state,
                active_confirmations: mom.active_confirmations,
                bp_score: input.bp_score,
                c_score: input.c_score,
                rank_velocity: input.rank_velocity,
                volume_acceleration: input.volume_acceleration,
                vwap_pos_pct: input.vwap_pos_pct,
                institutional_continuation: inst.continuation,
                decision_status: input.decision_status,
                chase_risk: input.chase_risk,
                data_confidence:
                    (input.score_coverage_pct ?? 100) >= 75
                        ? 'HIGH'
                        : (input.score_coverage_pct ?? 100) >= 55
                          ? 'MEDIUM'
                          : 'LOW',
            });

            const focusReasons = buildFocusReasons(mom, input, inst);

            const item: RadarQualityItem = {
                symbol: c.symbol,
                name: c.name || c.symbol,
                eligibility: mom.eligibility,
                momentum_state: mom.state,
                momentum_reason: mom.reason,
                active_confirmations: mom.active_confirmations.slice(0, 6),
                missing_confirmations: mom.missing_confirmations.slice(0, 4),
                focus_score: focusScore,
                focus_rank: null,
                is_focus: false,
                focus_reasons: focusReasons,
                raw_rank: c.rank ?? null,
                raw_rank_change: c.rank_change ?? null,
                institutional: inst,
                decision_status: ds?.status ?? null,
                ai_score: null,
                data_confidence:
                    (input.score_coverage_pct ?? 100) >= 75
                        ? 'HIGH'
                        : (input.score_coverage_pct ?? 100) >= 55
                          ? 'MEDIUM'
                          : 'LOW',
                updated_at: nowIso,
                version: RQ_VERSION,
                mutates_strategy: false,
            };
            this.bySymbol.set(c.symbol, item);
            items.push(item);
        }

        for (const sym of [...this.bySymbol.keys()]) {
            if (!seen.has(sym)) {
                this.bySymbol.delete(sym);
                this.hyst.delete(sym);
            }
        }

        const { slots, leader } = selectFocusTop3(
            items,
            this.cfg,
            this.focusLeader,
            nowMs,
        );
        this.focusLeader = leader;
        const focusSet = new Map(slots.map((s) => [s.symbol, s.focus_rank]));
        for (const it of items) {
            const fr = focusSet.get(it.symbol) ?? null;
            it.focus_rank = fr;
            it.is_focus = fr != null;
        }

        const counts = {
            eligible: items.filter((i) => i.eligibility === 'ELIGIBLE').length,
            active: items.filter((i) => i.momentum_state === 'ACTIVE').length,
            pullback: items.filter((i) => i.momentum_state === 'PULLBACK')
                .length,
            watch: items.filter((i) => i.momentum_state === 'WATCH').length,
            inactive: items.filter((i) => i.momentum_state === 'INACTIVE')
                .length,
            invalid: items.filter((i) => i.momentum_state === 'INVALID').length,
        };

        const out: RadarQualityBatch = {
            as_of: nowIso,
            version: RQ_VERSION,
            count: items.length,
            items: items.sort((a, b) => b.focus_score - a.focus_score),
            focus_top3: slots,
            counts,
            evaluate_interval_sec: this.cfg.evaluate_interval_sec,
            mutates_strategy: false,
            note: 'Radar Quality Upgrade v1 — Decision Support; does not mutate C/BP/Raw Rank.',
            intraday_foreign_identity: 'NOT_AVAILABLE',
        };
        this.last = out;
        return out;
    }

    /** Pure evaluate for tests (no I/O). */
    evaluateInputForTest(
        input: RadarQualityInput,
        prior?: HysteresisState,
    ) {
        return evaluateMomentum(input, this.cfg, prior);
    }

    evaluateRawForTest(input: RadarQualityInput) {
        return evaluateRawMomentum(input, this.cfg);
    }

    applyHysteresisForTest(
        raw: Parameters<typeof applyHysteresis>[0],
        prior: HysteresisState | undefined,
    ) {
        return applyHysteresis(raw, prior, this.cfg);
    }

    private emptyBatch(): RadarQualityBatch {
        return {
            as_of: new Date().toISOString(),
            version: RQ_VERSION,
            count: 0,
            items: [],
            focus_top3: [],
            counts: {
                eligible: 0,
                active: 0,
                pullback: 0,
                watch: 0,
                inactive: 0,
                invalid: 0,
            },
            evaluate_interval_sec: this.cfg.evaluate_interval_sec,
            mutates_strategy: false,
            note: 'warming up',
            intraday_foreign_identity: 'NOT_AVAILABLE',
        };
    }

    private buildInput(
        c: IntradayRankItem,
        bp: BuyPressureItem | null,
        ctx: {
            regime: string | null;
            sectorRow: SectorRotationRow | null;
            decisionStatus: string | null;
            institutional: RadarQualityInput['institutional'];
        },
    ): RadarQualityInput {
        const events = (c.events ?? []).map((e) =>
            typeof e === 'string' ? e : String(e),
        );
        const bpStates = [
            ...(bp?.states ?? []),
            ...(bp?.primary_state ? [bp.primary_state] : []),
        ].map((s) => String(s).toUpperCase());
        const vwap =
            c.metrics?.vwap_pos_pct ?? bp?.distance_from_vwap_pct ?? null;
        const shortMom = c.metrics?.return_1m ?? c.metrics?.return_3m ?? null;
        return {
            symbol: c.symbol,
            name: c.name || c.symbol,
            last_price: c.last_price ?? null,
            change_pct: c.change_pct ?? c.adjusted_change_pct ?? null,
            short_momentum: shortMom,
            momentum_acceleration: c.metrics?.momentum_acceleration ?? null,
            c_score: c.intraday_score ?? null,
            c_state: c.state ?? null,
            bp_score: bp?.buy_pressure_score ?? null,
            bp_states: bpStates,
            bp_trend_up: Boolean(
                bp &&
                    (bpStates.includes('BUY_SURGE') ||
                        bpStates.includes('ASK_EATING') ||
                        (bp.buy_pressure_score ?? 0) >=
                            this.cfg.active_bp_strong_min),
            ),
            rank: c.rank ?? null,
            rank_prev: c.rank_prev ?? null,
            rank_change: c.rank_change ?? null,
            rank_velocity: c.rank_velocity ?? bp?.rank_velocity ?? null,
            vwap_pos_pct: vwap,
            vwap_reclaim:
                events.some((e) => e.toUpperCase().includes('RECLAIM')) ||
                (vwap != null &&
                    vwap >= 0 &&
                    (shortMom == null || shortMom < 0)),
            rvol:
                (c.metrics as { rvol_same_time?: number | null } | undefined)
                    ?.rvol_same_time ??
                bp?.rvol ??
                null,
            volume_acceleration:
                c.metrics?.volume_acceleration ?? bp?.volume_acceleration ?? null,
            trade_aggression: bp?.trade_aggression ?? null,
            breakout_type: c.metrics?.breakout_type ?? bp?.breakout_type ?? null,
            events,
            pullback_state: c.metrics?.pullback_state ?? null,
            sector_state: ctx.sectorRow?.state ?? null,
            taiwan_regime: ctx.regime,
            data_health: c.data_health ?? null,
            data_blocked: Boolean(c.data_blocked),
            data_stale:
                c.data_health === 'stale' || c.data_health === 'disconnected',
            score_coverage_pct: c.score_coverage_pct ?? null,
            chase_risk: c.risk?.chase_risk ?? bp?.chase_risk ?? null,
            decision_status: ctx.decisionStatus,
            ai_score: null,
            institutional: ctx.institutional,
        };
    }
}

function buildFocusReasons(
    mom: ReturnType<typeof evaluateMomentum>,
    input: RadarQualityInput,
    inst: RadarQualityInput['institutional'],
): string[] {
    const reasons: string[] = [];
    reasons.push(`✓ ${mom.state}`);
    if (input.bp_score != null) {
        const st = input.bp_states[0] ?? '';
        reasons.push(`✓ BP ${Math.round(input.bp_score)}${st ? ` ${st}` : ''}`);
    }
    if (input.rank != null && input.rank_prev != null) {
        reasons.push(`✓ Rank #${input.rank_prev} → #${input.rank}`);
    } else if (input.rank_velocity != null && input.rank_velocity > 0) {
        reasons.push(`✓ Rank Velocity +${input.rank_velocity}`);
    }
    if (input.sector_state) {
        reasons.push(`✓ Sector ${input.sector_state}`);
    }
    if (
        inst.continuation === 'CONFIRMED_CONTINUATION' ||
        inst.background === 'FOREIGN_STRONG_ACCUMULATION' ||
        inst.background === 'FOREIGN_ACCUMULATION'
    ) {
        reasons.push(`✓ ${backgroundLabel(inst.background)}`);
        if (inst.continuation === 'CONFIRMED_CONTINUATION') {
            reasons.push(`✓ ${continuationLabel(inst.continuation)}`);
        }
    }
    return reasons.slice(0, 4);
}
