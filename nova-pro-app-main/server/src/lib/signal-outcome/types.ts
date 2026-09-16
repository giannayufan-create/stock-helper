// server/src/lib/signal-outcome/types.ts
// Market path after StrategySignal — NOT trading P&L / win-loss.

import type { SignalType } from '../strategy-signal/types.ts';

export type OutcomeStatus =
    | 'pending'
    | 'partial'
    | 'complete'
    | 'ambiguous'
    | 'invalid_data';

export type OutcomeSequence =
    | 'ambiguous'
    | 'target_only'
    | 'invalid_only'
    | 'neither'
    | 'unknown';

export interface SignalOutcome {
    signal_id: string;
    symbol: string;
    signal_type: SignalType;

    signal_time: string;
    reference_price: number;

    status: OutcomeStatus;

    forward_return_1m?: number;
    forward_return_3m?: number;
    forward_return_5m?: number;
    forward_return_15m?: number;
    forward_return_30m?: number;
    forward_return_60m?: number;
    close_return?: number;

    mfe_5m?: number;
    mfe_15m?: number;
    mfe_30m?: number;
    mfe_60m?: number;

    mae_5m?: number;
    mae_15m?: number;
    mae_30m?: number;
    mae_60m?: number;

    invalid_hit?: boolean;
    time_to_invalid_sec?: number;

    hit_plus_1pct?: boolean;
    hit_plus_2pct?: boolean;
    hit_plus_3pct?: boolean;

    time_to_plus_1pct_sec?: number;
    time_to_plus_2pct_sec?: number;
    time_to_plus_3pct_sec?: number;

    outcome_sequence?: OutcomeSequence | string;

    /**
     * True when forward path crosses an ex-right/ex-div date and returns
     * were not reliably adjusted — exclude from learning stats.
     */
    corporate_action_crossed?: boolean;
    learning_exclude_reason?: string | null;

    source_mode: 'live' | 'replay';
    data_resolution: 'tick' | '1m';

    calculated_at: string;
    event_kind?: 'PARTIAL' | 'COMPLETE';
}

export interface PriceBar {
    /** Bar known_at / timestamp ms */
    t: number;
    open: number;
    high: number;
    low: number;
    close: number;
}

export const FORWARD_HORIZONS_MIN = [1, 3, 5, 15, 30, 60] as const;
export const MFE_MAE_HORIZONS_MIN = [5, 15, 30, 60] as const;
