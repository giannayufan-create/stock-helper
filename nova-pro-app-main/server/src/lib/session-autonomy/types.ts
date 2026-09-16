// server/src/lib/session-autonomy/types.ts
// Headless session FSM — never requires UI_VIEW / EventSource / frontend polling.

export const SESSION_AUTONOMY_VERSION = 'session_autonomy_v1';

export type TradingSessionState =
    | 'NIGHT_LIVE'
    | 'PREOPEN'
    | 'CASH_LIVE'
    | 'CLOSE_AUCTION'
    | 'WEEKEND';

export interface SessionTransition {
    from: TradingSessionState;
    to: TradingSessionState;
    at: string;
    trigger: 'clock' | 'forced';
}

export interface OvernightSnapshot {
    snapshot_id: string;
    session_date: string;
    created_at: string;
    created_during: TradingSessionState;
    source: 'session_autonomy';
    ui_required: false;
    global_assets: Array<{
        id: string;
        change_pct: number | null;
        available: boolean;
    }>;
    us_overnight_bias: string | null;
    notes: string[];
    persisted_to: Array<'disk' | 'firestore' | 'jsonl' | 'memory'>;
}

export interface SessionAutonomyHealth {
    version: string;
    state: TradingSessionState;
    previous_state: TradingSessionState | null;
    last_transition_at: string | null;
    overnight_snapshots: number;
    transitions: number;
    ui_view_consumers: 0;
    event_source_clients: 0;
    headless: true;
    mutates_strategy: false;
    engines_noted: {
        preopen_context: boolean;
        cash_market_context: boolean;
        c_eval_count: number;
        bp_eval_count: number;
        notification_candidates: number;
        persistence_writes: number;
    };
}
