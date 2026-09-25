// EARLY-dedicated backtest — resolveAttackState on replay minutes.
// Day +3%/+5% uses day_reference_price; post-trigger +3%/+5% uses trigger_price.
// NEVER mutates A/B/C/BP engines.

import type { BuyPressureItem } from '../buy-pressure/types.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';
import type { PriceBar } from '../signal-outcome/types.ts';
import {
    buildAttackFeatures,
    resolveAttackState,
    type EarlyTrack,
} from './attack-state.ts';
import { loadRadarRescueConfig, type RadarRescueConfig } from './config.ts';
import type { RecentPricePoint } from './print-samples.ts';
import { computeTriggerScore } from './trigger-score.ts';

/** SUCCESS / FAIL enter rate denominator; INCOMPLETE / UNKNOWN do not. */
export type MetricVerdict = 'SUCCESS' | 'FAIL' | 'INCOMPLETE' | 'UNKNOWN';

export interface TargetMetric {
    verdict: MetricVerdict;
    /** 1m bar known_at when high first touched threshold (minute precision). */
    first_hit_bar_known_at_ms: number | null;
    /** Minutes after trigger (floor). Never invent exact seconds from 1m bars. */
    first_hit_after_min: number | null;
    time_precision: '1m_bar' | 'none';
}

export interface EarlyBacktestTrigger {
    signal_id: string;
    symbol: string;
    triggered_at_ms: number;
    trigger_price: number;
    change_pct_at_trigger: number | null;
    state_at_trigger: string;
    trigger_score: number;
}

export interface EarlyBacktestOutcome extends EarlyBacktestTrigger {
    /** Prior-session close (or other valid day ref). Null → day metrics UNKNOWN. */
    day_reference_price: number | null;
    /** 當日 +3%：high ≥ day_ref × 1.03 after trigger. */
    day_plus_3pct: TargetMetric;
    /** 當日 +5%：high ≥ day_ref × 1.05 after trigger. */
    day_plus_5pct: TargetMetric;
    /** 觸發後再漲 3%：high ≥ trigger_price × 1.03. */
    post_trigger_plus_3pct: TargetMetric;
    /** 觸發後再漲 5%：high ≥ trigger_price × 1.05. */
    post_trigger_plus_5pct: TargetMetric;
    /**
     * EARLY→ACTIVE state-upgrade (not trading win-rate).
     * Only first ACTIVE per signal_id.
     */
    active_upgrade: TargetMetric & { reached: boolean };
    max_price: number | null;
    max_return_vs_trigger_pct: number | null;
    max_return_vs_day_ref_pct: number | null;
    tracking_to_close: boolean;
    terminal_state: string;
}

export interface MetricBucket {
    success: number;
    fail: number;
    incomplete: number;
    unknown: number;
    /** SUCCESS / (SUCCESS + FAIL); null if denominator 0. */
    rate: number | null;
}

export interface EarlyBacktestSummary {
    signal_count: number;
    unique_symbol_count: number;
    day_plus_3pct: MetricBucket;
    day_plus_5pct: MetricBucket;
    post_trigger_plus_3pct: MetricBucket;
    post_trigger_plus_5pct: MetricBucket;
    /** State-upgrade rate — not labeled as trading win-rate. */
    active_upgrade: MetricBucket;
    /** (SUCCESS+FAIL) / (SUCCESS+FAIL+INCOMPLETE) across day_plus_3pct. */
    data_completeness_rate: number | null;
    outcomes: EarlyBacktestOutcome[];
}

/** Max gap between consecutive 1m bars before tracking is incomplete. */
const MAX_BAR_GAP_MS = 3 * 60_000;

function newSignalId(symbol: string, atMs: number, seq: number): string {
    return `early_${symbol}_${atMs}_${seq}`;
}

function rate(success: number, fail: number): number | null {
    const d = success + fail;
    return d > 0 ? Math.round((success / d) * 1000) / 1000 : null;
}

function bucket(outcomes: TargetMetric[]): MetricBucket {
    let success = 0;
    let fail = 0;
    let incomplete = 0;
    let unknown = 0;
    for (const o of outcomes) {
        if (o.verdict === 'SUCCESS') success += 1;
        else if (o.verdict === 'FAIL') fail += 1;
        else if (o.verdict === 'INCOMPLETE') incomplete += 1;
        else unknown += 1;
    }
    return { success, fail, incomplete, unknown, rate: rate(success, fail) };
}

function emptyTarget(verdict: MetricVerdict): TargetMetric {
    return {
        verdict,
        first_hit_bar_known_at_ms: null,
        first_hit_after_min: null,
        time_precision: 'none',
    };
}

/**
 * Evaluate absolute price threshold against future 1m highs.
 * Hit time is minute-precision (bar known_at), never fake seconds.
 */
export function evaluatePriceTarget(opts: {
    threshold: number | null;
    triggerMs: number;
    futureBars: PriceBar[];
    trackingToClose: boolean;
    /** When false, return UNKNOWN (day ref missing). */
    referenceAvailable: boolean;
}): TargetMetric {
    if (!opts.referenceAvailable || opts.threshold == null || !(opts.threshold > 0)) {
        return emptyTarget('UNKNOWN');
    }
    const thr = opts.threshold;
    for (const b of opts.futureBars) {
        if (b.high >= thr) {
            const afterMin = Math.floor((b.t - opts.triggerMs) / 60_000);
            return {
                verdict: 'SUCCESS',
                first_hit_bar_known_at_ms: b.t,
                first_hit_after_min: Math.max(0, afterMin),
                time_precision: '1m_bar',
            };
        }
    }
    if (opts.trackingToClose) return emptyTarget('FAIL');
    return emptyTarget('INCOMPLETE');
}

/** Reliable 1m path continues from trigger through session end without large gaps. */
export function isTrackingCompleteToClose(
    triggerMs: number,
    futureBars: PriceBar[],
    sessionEndKnownAt: number,
): boolean {
    if (!futureBars.length) return false;
    const last = futureBars[futureBars.length - 1]!;
    // Must reach (or pass) the last session minute's known_at.
    if (last.t < sessionEndKnownAt - 60_000) return false;
    if (futureBars[0]!.t - triggerMs > MAX_BAR_GAP_MS) return false;
    for (let i = 1; i < futureBars.length; i++) {
        if (futureBars[i]!.t - futureBars[i - 1]!.t > MAX_BAR_GAP_MS) {
            return false;
        }
    }
    return true;
}

export class EarlyBacktestSession {
    private cfg: RadarRescueConfig;
    private tracks = new Map<string, EarlyTrack>();
    private triggers: EarlyBacktestTrigger[] = [];
    private activeAt = new Map<string, number>();
    private terminal = new Map<string, string>();
    private seq = 0;
    /** Open signal_ids still in EARLY path per symbol (for ACTIVE attribution). */
    private openBySymbol = new Map<string, string[]>();

    constructor(cfg?: RadarRescueConfig) {
        this.cfg = cfg ?? loadRadarRescueConfig();
    }

    /** Test helper: record a signal without driving the full state machine. */
    injectSignal(t: EarlyBacktestTrigger): void {
        this.triggers.push(t);
        this.terminal.set(t.signal_id, t.state_at_trigger);
    }

    /** Test helper: first ACTIVE only (subsequent calls ignored). */
    injectActive(signalId: string, atMs: number): void {
        if (!this.activeAt.has(signalId)) this.activeAt.set(signalId, atMs);
    }

    step(opts: {
        symbol: string;
        nowMs: number;
        cashSession: boolean;
        c: IntradayRankItem | null;
        bp?: BuyPressureItem | null;
        recentPrices?: RecentPricePoint[] | null;
        stale?: boolean;
        dataBlocked?: boolean;
    }): void {
        const { symbol, nowMs } = opts;
        const c = opts.c;
        const bp = opts.bp ?? null;
        const trigger = computeTriggerScore(this.cfg, { c, bp });
        const features = buildAttackFeatures({
            c,
            bp,
            trigger,
            changePct: c?.change_pct ?? bp?.change_pct ?? null,
            prevVwapPos: null,
            bpRising: false,
            nowMs,
            recentPrices: opts.recentPrices ?? undefined,
        });
        const prev = this.tracks.get(symbol) ?? null;
        const attack = resolveAttackState(this.cfg, features, {
            symbol,
            cashSession: opts.cashSession,
            stale: !!opts.stale,
            dataBlocked: !!opts.dataBlocked || !!c?.data_blocked,
            prev,
            nowMs,
        });
        if (attack.track) this.tracks.set(symbol, attack.track);

        const state = attack.state;
        const isEarlyPath =
            state === 'EARLY' ||
            state === 'PRE_ATTACK' ||
            state === 'ACTIVE' ||
            state === 'STALLING';

        // New attack only when triggered_at_ms changes (EARLY→PRE_ATTACK keeps same id).
        const freshAttack =
            (state === 'EARLY' || state === 'PRE_ATTACK') &&
            attack.track &&
            (!prev ||
                attack.track.triggered_at_ms !== prev.triggered_at_ms);

        if (freshAttack && attack.track) {
            this.seq += 1;
            const signal_id = newSignalId(
                symbol,
                attack.track.triggered_at_ms,
                this.seq,
            );
            const row: EarlyBacktestTrigger = {
                signal_id,
                symbol,
                triggered_at_ms: attack.track.triggered_at_ms,
                trigger_price: attack.track.trigger_price,
                change_pct_at_trigger:
                    features.change_pct ?? c?.change_pct ?? null,
                state_at_trigger: state,
                trigger_score: trigger,
            };
            this.triggers.push(row);
            const list = this.openBySymbol.get(symbol) ?? [];
            list.push(signal_id);
            this.openBySymbol.set(symbol, list);
            this.terminal.set(signal_id, state);
        }

        const open = this.openBySymbol.get(symbol) ?? [];
        for (const sid of open) {
            this.terminal.set(sid, state);
            // First ACTIVE only once per signal.
            if (
                (state === 'ACTIVE' ||
                    state === 'NEAR_LIMIT' ||
                    state === 'LIMIT_UP') &&
                !this.activeAt.has(sid)
            ) {
                this.activeAt.set(sid, nowMs);
            }
        }

        if (!isEarlyPath && open.length) {
            this.openBySymbol.set(symbol, []);
        }
    }

    finalize(
        dayBarsBySymbol: Map<string, PriceBar[]>,
        opts?: {
            /** Valid day reference (typically prior close). Missing → day metrics UNKNOWN. */
            dayReferenceBySymbol?: Map<string, number | null>;
            /** Last bar known_at of the cash session (e.g. 13:30 bar end). */
            sessionEndKnownAtBySymbol?: Map<string, number>;
            /** Fallback session end when per-symbol map omitted. */
            defaultSessionEndKnownAt?: number;
        },
    ): EarlyBacktestSummary {
        const outcomes: EarlyBacktestOutcome[] = [];
        for (const t of this.triggers) {
            const allBars = dayBarsBySymbol.get(t.symbol) ?? [];
            const futureBars = allBars.filter((b) => b.t > t.triggered_at_ms);
            const dayRef =
                opts?.dayReferenceBySymbol?.get(t.symbol) ?? null;
            const sessionEnd =
                opts?.sessionEndKnownAtBySymbol?.get(t.symbol) ??
                opts?.defaultSessionEndKnownAt ??
                (allBars.length
                    ? allBars[allBars.length - 1]!.t
                    : t.triggered_at_ms);

            const trackingToClose = isTrackingCompleteToClose(
                t.triggered_at_ms,
                futureBars,
                sessionEnd,
            );

            const dayOk = dayRef != null && dayRef > 0;
            const day_plus_3pct = evaluatePriceTarget({
                threshold: dayOk ? dayRef! * 1.03 : null,
                triggerMs: t.triggered_at_ms,
                futureBars,
                trackingToClose,
                referenceAvailable: dayOk,
            });
            const day_plus_5pct = evaluatePriceTarget({
                threshold: dayOk ? dayRef! * 1.05 : null,
                triggerMs: t.triggered_at_ms,
                futureBars,
                trackingToClose,
                referenceAvailable: dayOk,
            });
            const post_trigger_plus_3pct = evaluatePriceTarget({
                threshold: t.trigger_price > 0 ? t.trigger_price * 1.03 : null,
                triggerMs: t.triggered_at_ms,
                futureBars,
                trackingToClose,
                referenceAvailable: t.trigger_price > 0,
            });
            const post_trigger_plus_5pct = evaluatePriceTarget({
                threshold: t.trigger_price > 0 ? t.trigger_price * 1.05 : null,
                triggerMs: t.triggered_at_ms,
                futureBars,
                trackingToClose,
                referenceAvailable: t.trigger_price > 0,
            });

            const activeMs = this.activeAt.get(t.signal_id);
            let active_upgrade: TargetMetric & { reached: boolean };
            if (activeMs != null) {
                const afterMin = Math.floor(
                    (activeMs - t.triggered_at_ms) / 60_000,
                );
                active_upgrade = {
                    verdict: 'SUCCESS',
                    reached: true,
                    first_hit_bar_known_at_ms: activeMs,
                    first_hit_after_min: Math.max(0, afterMin),
                    // ACTIVE comes from evaluate ticks; still report minute floor.
                    time_precision: '1m_bar',
                };
            } else if (trackingToClose) {
                active_upgrade = {
                    ...emptyTarget('FAIL'),
                    reached: false,
                };
            } else {
                active_upgrade = {
                    ...emptyTarget('INCOMPLETE'),
                    reached: false,
                };
            }

            let peak = t.trigger_price;
            for (const b of futureBars) peak = Math.max(peak, b.high);
            const max_return_vs_trigger_pct =
                t.trigger_price > 0
                    ? Math.round(
                          ((peak - t.trigger_price) / t.trigger_price) * 10000,
                      ) / 100
                    : null;
            const max_return_vs_day_ref_pct =
                dayOk
                    ? Math.round(((peak - dayRef!) / dayRef!) * 10000) / 100
                    : null;

            outcomes.push({
                ...t,
                day_reference_price: dayOk ? dayRef! : null,
                day_plus_3pct,
                day_plus_5pct,
                post_trigger_plus_3pct,
                post_trigger_plus_5pct,
                active_upgrade,
                max_price: futureBars.length ? peak : null,
                max_return_vs_trigger_pct,
                max_return_vs_day_ref_pct,
                tracking_to_close: trackingToClose,
                terminal_state:
                    this.terminal.get(t.signal_id) ?? t.state_at_trigger,
            });
        }

        const day3 = bucket(outcomes.map((o) => o.day_plus_3pct));
        const scored = day3.success + day3.fail + day3.incomplete;
        const data_completeness_rate =
            scored > 0
                ? Math.round(
                      ((day3.success + day3.fail) / scored) * 1000,
                  ) / 1000
                : null;

        const symbols = new Set(outcomes.map((o) => o.symbol));
        return {
            signal_count: outcomes.length,
            unique_symbol_count: symbols.size,
            day_plus_3pct: day3,
            day_plus_5pct: bucket(outcomes.map((o) => o.day_plus_5pct)),
            post_trigger_plus_3pct: bucket(
                outcomes.map((o) => o.post_trigger_plus_3pct),
            ),
            post_trigger_plus_5pct: bucket(
                outcomes.map((o) => o.post_trigger_plus_5pct),
            ),
            active_upgrade: bucket(outcomes.map((o) => o.active_upgrade)),
            data_completeness_rate,
            outcomes,
        };
    }
}
