// server/src/lib/strategy-signal/types.ts
// Decision research signal only — NOT an order / position / fill.

export type SignalType =
    | 'OPEN_PASS'
    | 'STRONG_ENTER'
    | 'SURGE'
    | 'BREAKOUT'
    | 'REBREAK'
    | 'RANK_JUMP'
    | 'PULLBACK_READY';

export type SignalSource = 'B' | 'C';

export type SignalLifecycleStatus =
    | 'active'
    | 'cooling'
    | 'invalid'
    | 'expired'
    | 'closed';

export type ScoreConfidence = 'high' | 'medium' | 'low';

export interface StrategySignal {
    signal_id: string;
    evaluation_id?: string;

    symbol: string;
    name?: string;

    signal_type: SignalType;

    signal_time: string;
    /** Session minutes from 09:00 at signal_time (Taipei). */
    session_minute?: number;

    reference_price: number;
    reference_price_source: string;

    source: SignalSource;
    state?: string;

    score?: number;
    heat_score?: number;

    invalid_price?: number;
    invalid_reason?: string;

    market_regime?: string;

    strategy_version: string;
    config_hash: string;
    open_gate_version?: string;
    intraday_rank_version?: string;
    runtime_version?: string;

    source_mode: 'live' | 'replay';
    data_resolution: 'tick' | '1m';

    score_coverage_pct?: number;
    score_confidence?: ScoreConfidence;

    learning_eligible: boolean;
    universe_source?: string;

    /** Immutable snapshot at signal formation — never overwrite.
     * Optional future keys (point-in-time only; never backfill):
     * broker_context?: {
     *   available, main_force_score, top3_concentration,
     *   net_buy_5d, consecutive_buy_days, freshness, inferred
     * }
     */
    feature_snapshot: Record<string, unknown>;

    metadata?: Record<string, unknown>;
}

export interface LifecycleRecord {
    symbol: string;
    signal_type: SignalType;
    active_signal_id: string | null;
    created_at: string | null;
    last_seen_at: string | null;
    cooldown_until: string | null;
    lifecycle_status: SignalLifecycleStatus;
}

export const STRATEGY_VERSION = 'bc-strategy-v1';
export const OPEN_GATE_VERSION = 'open-gate-v2';
export const INTRADAY_RANK_VERSION = 'intraday-rank-v1';
export const RUNTIME_VERSION = 'market-runtime-v1';

export const FORMAL_SIGNAL_TYPES: SignalType[] = [
    'OPEN_PASS',
    'STRONG_ENTER',
    'SURGE',
    'BREAKOUT',
    'REBREAK',
    'RANK_JUMP',
    'PULLBACK_READY',
];
