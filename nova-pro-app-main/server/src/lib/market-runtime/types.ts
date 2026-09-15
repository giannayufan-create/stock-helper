// server/src/lib/market-runtime/types.ts
// Upstream Shioaji subscription consumers only — NOT UI SSE clients.
//
// Deferred Replay / Outcome constraints (STEP 4+ — do not violate later):
// - Replay v1 = 1m bars only; evaluate after each completed bar; never invent 3s ticks.
// - Unavailable tick-only features → available=false + renormalize weights (never fill 0).
// - Same-bar target+invalid without path → outcome_sequence=ambiguous.
// - Outcome JSONL via SignalRepository / OutcomeRepository / ReplayRunRepository only.
// - Persist signal_id, strategy_version, config_hash, source_mode, data_resolution.

export type SubscriptionConsumer =
    | 'OPEN_GATE'
    | 'INTRADAY_RANK'
    | 'USER_MONITOR'
    | 'UI_VIEW'
    | 'REPLAY';

export type SourceMode = 'live' | 'replay';

export type DataResolution = 'tick' | '1m' | 'unknown';

export interface MarketSourceInfo {
    source_mode: SourceMode;
    data_resolution: DataResolution;
}

/** Features that 1m replay cannot reliably rebuild — mark available=false. */
export const REPLAY_1M_UNAVAILABLE_FEATURES = [
    'TradeAggression',
    'BidAskImbalance',
    'OrderBook',
    'TickVelocity',
    'VolumeAcceleration_3s',
    'SpreadInstantChange',
] as const;
