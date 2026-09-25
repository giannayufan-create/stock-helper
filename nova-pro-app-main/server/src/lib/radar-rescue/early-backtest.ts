// EARLY-dedicated backtest — runs resolveAttackState on replay minutes.
// Does NOT mutate A/B/C/BP engines.

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
    reached_active: boolean;
    hit_plus_3pct: boolean;
    hit_plus_5pct: boolean;
    max_return_pct: number | null;
    time_to_plus_3pct_sec: number | null;
    time_to_plus_5pct_sec: number | null;
    time_to_active_sec: number | null;
    terminal_state: string;
    /** Incomplete when no future bars after trigger (e.g. near close). */
    complete: boolean;
}

export interface EarlyBacktestSummary {
    triggers: number;
    complete: number;
    incomplete: number;
    hit_plus_3pct: number;
    hit_plus_5pct: number;
    reached_active: number;
    /** hit_plus_3pct / complete (null if no complete). */
    hit_plus_3pct_rate: number | null;
    reached_active_rate: number | null;
    outcomes: EarlyBacktestOutcome[];
}

function newSignalId(symbol: string, atMs: number, seq: number): string {
    return `early_${symbol}_${atMs}_${seq}`;
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

        const freshTrigger =
            (state === 'EARLY' || state === 'PRE_ATTACK') &&
            attack.track &&
            (!prev ||
                attack.track.triggered_at_ms !== prev.triggered_at_ms);

        if (freshTrigger && attack.track) {
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
            // Path ended — keep terminal; leave open list for outcome look-ahead
            this.openBySymbol.set(symbol, []);
        }
    }

    finalize(dayBarsBySymbol: Map<string, PriceBar[]>): EarlyBacktestSummary {
        const outcomes: EarlyBacktestOutcome[] = [];
        for (const t of this.triggers) {
            const bars = (dayBarsBySymbol.get(t.symbol) ?? []).filter(
                (b) => b.t > t.triggered_at_ms,
            );
            const ref = t.trigger_price;
            let peak = ref;
            let hit3 = false;
            let hit5 = false;
            let t3: number | null = null;
            let t5: number | null = null;
            for (const b of bars) {
                peak = Math.max(peak, b.high);
                const ret =
                    ref > 0 ? ((b.high - ref) / ref) * 100 : null;
                if (ret != null && ret >= 3 && !hit3) {
                    hit3 = true;
                    t3 = Math.round((b.t - t.triggered_at_ms) / 1000);
                }
                if (ret != null && ret >= 5 && !hit5) {
                    hit5 = true;
                    t5 = Math.round((b.t - t.triggered_at_ms) / 1000);
                }
            }
            const activeMs = this.activeAt.get(t.signal_id);
            const complete = bars.length > 0;
            const maxRet =
                ref > 0 ? Math.round(((peak - ref) / ref) * 10000) / 100 : null;
            outcomes.push({
                ...t,
                reached_active: activeMs != null,
                hit_plus_3pct: hit3,
                hit_plus_5pct: hit5,
                max_return_pct: maxRet,
                time_to_plus_3pct_sec: t3,
                time_to_plus_5pct_sec: t5,
                time_to_active_sec:
                    activeMs != null
                        ? Math.round((activeMs - t.triggered_at_ms) / 1000)
                        : null,
                terminal_state: this.terminal.get(t.signal_id) ?? t.state_at_trigger,
                complete,
            });
        }

        const completeRows = outcomes.filter((o) => o.complete);
        const hit3 = completeRows.filter((o) => o.hit_plus_3pct).length;
        const hit5 = completeRows.filter((o) => o.hit_plus_5pct).length;
        const active = completeRows.filter((o) => o.reached_active).length;
        const n = completeRows.length;
        return {
            triggers: outcomes.length,
            complete: n,
            incomplete: outcomes.length - n,
            hit_plus_3pct: hit3,
            hit_plus_5pct: hit5,
            reached_active: active,
            hit_plus_3pct_rate: n > 0 ? Math.round((hit3 / n) * 1000) / 1000 : null,
            reached_active_rate:
                n > 0 ? Math.round((active / n) * 1000) / 1000 : null,
            outcomes,
        };
    }
}
