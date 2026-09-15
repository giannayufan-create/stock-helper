// server/src/lib/strategy-signal/factory.ts
// Creates StrategySignal from B/C results — research decision only.

import { createHash, randomUUID } from 'node:crypto';
import type { OpenConfirmResult } from '../open-gate-v2/types.ts';
import type { IntradayEventType, IntradayRankItem } from '../intraday-rank/types.ts';
import { SignalLifecycleManager } from './lifecycle.ts';
import type { StrategySignalRepository } from './repository.ts';
import {
    INTRADAY_RANK_VERSION,
    OPEN_GATE_VERSION,
    RUNTIME_VERSION,
    STRATEGY_VERSION,
    type SignalType,
    type StrategySignal,
} from './types.ts';

export interface SignalContext {
    source_mode: 'live' | 'replay';
    data_resolution: 'tick' | '1m';
    universe_source?: string;
    learning_eligible: boolean;
    config_hash: string;
    now?: Date;
}

function newId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function sessionMinuteTaipei(iso: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Taipei',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(new Date(iso));
    const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return Math.max(0, hh * 60 + mm - 9 * 60);
}

function hashObj(obj: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify(obj))
        .digest('hex')
        .slice(0, 12);
}

export function configHashOf(obj: unknown): string {
    return hashObj(obj);
}

const C_EVENT_TO_SIGNAL: Partial<Record<IntradayEventType, SignalType>> = {
    SURGE: 'SURGE',
    BREAKOUT: 'BREAKOUT',
    REBREAK: 'REBREAK',
    RANK_JUMP: 'RANK_JUMP',
    PULLBACK_READY: 'PULLBACK_READY',
};

export class StrategySignalFactory {
    constructor(
        private repo: StrategySignalRepository,
        private life: SignalLifecycleManager,
    ) {}

    /**
     * B: first tradeable_candidate=true → OPEN_PASS.
     * Continuation while still tradeable → touch only.
     * After invalid/expired → may create new id.
     */
    maybeCreateFromB(
        prev: OpenConfirmResult | null,
        next: OpenConfirmResult,
        ctx: SignalContext,
        referencePrice: number,
    ): StrategySignal | null {
        const nowIso = next.generated_at ?? next.timestamp;
        const wasTradeable = Boolean(prev?.tradeable_candidate);
        const isTradeable = Boolean(next.tradeable_candidate);

        if (!isTradeable) {
            if (wasTradeable) {
                this.life.setStatus(
                    next.symbol,
                    'OPEN_PASS',
                    next.signal_expired ? 'expired' : 'invalid',
                    nowIso,
                    60,
                );
            }
            return null;
        }

        // Already active continuation
        const gate = this.life.canCreate(next.symbol, 'OPEN_PASS', nowIso);
        if (!gate.ok && gate.reason === 'already_active') {
            this.life.touch(next.symbol, 'OPEN_PASS', nowIso);
            return null;
        }
        if (!gate.ok) return null;

        // First pass or re-formation after close
        if (wasTradeable && gate.reason === 'already_active') return null;

        const refSource =
            ctx.source_mode === 'replay'
                ? 'replay_bar_close'
                : 'live_last';
        if (!(referencePrice > 0)) return null;

        const learning =
            ctx.learning_eligible && next.data_health !== 'disconnected';

        const signal: StrategySignal = {
            signal_id: next.signal_id ?? newId('bsig'),
            evaluation_id: next.evaluation_id,
            symbol: next.symbol,
            name: next.name,
            signal_type: 'OPEN_PASS',
            signal_time: nowIso,
            session_minute: sessionMinuteTaipei(nowIso),
            reference_price: referencePrice,
            reference_price_source: refSource,
            source: 'B',
            state: next.open_confirm,
            score: next.final_open_score,
            invalid_price: next.risk.invalid_price ?? undefined,
            invalid_reason: next.risk.invalid_reason ?? undefined,
            market_regime: next.market_regime,
            strategy_version: STRATEGY_VERSION,
            config_hash: ctx.config_hash,
            open_gate_version: OPEN_GATE_VERSION,
            runtime_version: RUNTIME_VERSION,
            source_mode: ctx.source_mode,
            data_resolution: ctx.data_resolution,
            score_coverage_pct: undefined,
            score_confidence: 'high',
            learning_eligible: learning,
            universe_source: ctx.universe_source,
            feature_snapshot: {
                a_score: next.a_score,
                raw_open_score: next.raw_open_score,
                final_open_score: next.final_open_score,
                gap_pct: next.metrics.gap_pct,
                rvol_same_time: next.metrics.rvol_same_time,
                vwap_pos: next.metrics.vwap_pos_pct,
                open_pos: next.metrics.open_pos_pct,
                high_pullback: next.metrics.high_pullback_pct,
                momentum: next.metrics.momentum_score,
                market_adjustment: next.market_adjustment,
                liquidity_adjustment: next.liquidity_adjustment,
                risk_adjustment: next.risk_adjustment,
                chase_risk: next.risk.chase_risk,
                phase: next.phase,
                liquidity_score: next.liquidity_score,
            },
            metadata: {
                open_confirm: next.open_confirm,
                tradeable_candidate: next.tradeable_candidate,
            },
        };

        // Freeze snapshot
        signal.feature_snapshot = Object.freeze({
            ...signal.feature_snapshot,
        }) as Record<string, unknown>;

        this.repo.save(signal);
        this.life.activate({
            symbol: next.symbol,
            signal_type: 'OPEN_PASS',
            signal_id: signal.signal_id,
            nowIso,
        });
        return signal;
    }

    /**
     * C: HEATING→STRONG → STRONG_ENTER; formal events → typed signals.
     */
    maybeCreateFromC(
        prev: IntradayRankItem | null,
        next: IntradayRankItem,
        ctx: SignalContext,
        referencePrice: number,
        eventCooldownsSec: Record<string, number>,
    ): StrategySignal[] {
        const out: StrategySignal[] = [];
        const nowIso = next.updated_at;
        const refSource =
            ctx.source_mode === 'replay'
                ? 'replay_bar_close'
                : 'live_last';
        if (!(referencePrice > 0)) return out;

        const baseLearning =
            ctx.learning_eligible &&
            (next.score_confidence !== 'low') &&
            (next.score_coverage_pct == null ||
                next.score_coverage_pct >= 70) &&
            next.data_health !== 'disconnected';

        const emit = (
            type: SignalType,
            cooldownSec: number,
            extraSnap: Record<string, unknown> = {},
        ) => {
            const gate = this.life.canCreate(next.symbol, type, nowIso);
            if (!gate.ok) {
                if (gate.reason === 'already_active') {
                    this.life.touch(next.symbol, type, nowIso);
                }
                return;
            }
            const signal: StrategySignal = {
                signal_id:
                    type === 'STRONG_ENTER' && next.signal_id
                        ? next.signal_id
                        : newId('csig'),
                evaluation_id: next.evaluation_id,
                symbol: next.symbol,
                name: next.name,
                signal_type: type,
                signal_time: nowIso,
                session_minute: sessionMinuteTaipei(nowIso),
                reference_price: referencePrice,
                reference_price_source: refSource,
                source: 'C',
                state: next.state,
                score: next.intraday_score,
                heat_score: next.heat_score,
                invalid_price: next.risk.invalid_price ?? undefined,
                invalid_reason: next.risk.invalid_reason ?? undefined,
                market_regime: undefined,
                strategy_version: STRATEGY_VERSION,
                config_hash: ctx.config_hash,
                intraday_rank_version: INTRADAY_RANK_VERSION,
                runtime_version: RUNTIME_VERSION,
                source_mode: ctx.source_mode,
                data_resolution: ctx.data_resolution,
                score_coverage_pct: next.score_coverage_pct,
                score_confidence: next.score_confidence,
                learning_eligible: baseLearning,
                universe_source: ctx.universe_source,
                feature_snapshot: Object.freeze({
                    intraday_score: next.intraday_score,
                    heat_score: next.heat_score,
                    momentum: next.metrics.return_1m,
                    momentum_acceleration:
                        next.metrics.momentum_acceleration,
                    volume_acceleration: next.metrics.volume_acceleration,
                    relative_strength: next.metrics.relative_strength_score,
                    vwap_structure: next.metrics.vwap_structure_score,
                    breakout_score: next.metrics.breakout_score,
                    breakout_type: next.metrics.breakout_type,
                    pullback_quality: next.metrics.pullback_quality_score,
                    rank: next.rank,
                    rank_change: next.rank_change,
                    rank_velocity: next.rank_velocity,
                    chase_risk: next.risk.chase_risk,
                    state: next.state,
                    ...extraSnap,
                }) as Record<string, unknown>,
                metadata: {
                    feature_availability: next.feature_availability,
                },
            };
    this.repo.save(signal);
    this.life.activate({
        symbol: next.symbol,
        signal_type: type,
        signal_id: signal.signal_id,
        nowIso,
        cooldownSec,
    });
    // For event types, cool immediately so cooldown applies
    if (type !== 'STRONG_ENTER') {
        this.life.setStatus(
            next.symbol,
            type,
            'cooling',
            nowIso,
            cooldownSec,
        );
    }
    out.push(signal);
        };

        // STRONG_ENTER: HEATING → STRONG only
        if (next.state === 'STRONG' && prev?.state === 'HEATING') {
            emit('STRONG_ENTER', 120);
        }
        if (next.state !== 'STRONG' && prev?.state === 'STRONG') {
            this.life.setStatus(
                next.symbol,
                'STRONG_ENTER',
                'closed',
                nowIso,
                60,
            );
        }

        for (const ev of next.events) {
            const st = C_EVENT_TO_SIGNAL[ev];
            if (!st) continue;
            const cd = eventCooldownsSec[ev] ?? 120;
            emit(st, cd, { event: ev });
        }

        return out;
    }
}
