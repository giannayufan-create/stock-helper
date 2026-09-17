// server/src/lib/intraday-rank/types.ts

export type CandidateSource =
    | 'A'
    | 'B_PASS'
    | 'B_WATCH'
    | 'SCANNER_CHANGE'
    | 'SCANNER_VOLUME'
    | 'SCANNER_AMOUNT'
    | 'SCANNER_TICK'
    | 'SCANNER_DAYRANGE';

export type CandidateOrigin =
    | 'eod_a'
    | 'open_gate'
    | 'intraday_scanner'
    | 'mixed';

export type IntradayState =
    | 'DORMANT'
    | 'EMERGING'
    | 'HEATING'
    | 'STRONG'
    | 'COOLING'
    | 'INVALID';

export type BreakoutType =
    | 'none'
    | 'attempt'
    | 'breakout'
    | 'rebreak'
    | 'failed_breakout';

export type PullbackState =
    | 'none'
    | 'pullback'
    | 'holding'
    | 'reclaiming'
    | 'failed';

export type ChaseRisk = 'low' | 'medium' | 'high' | 'extreme';

export type IntradayEventType =
    | 'SURGE'
    | 'BREAKOUT'
    | 'REBREAK'
    | 'PULLBACK_READY'
    | 'RANK_JUMP'
    | 'COOLING'
    | 'INVALID';

export type EligibilityStatus = 'eligible' | 'watch' | 'blocked';

export interface DiscoveryItem {
    symbol: string;
    name: string;
    candidate_sources: CandidateSource[];
    candidate_origin: CandidateOrigin;
    discovery_score: number;
    a_score: number | null;
    open_score: number | null;
    open_gate_status: string | null;
    scanner_ranks: {
        change?: number;
        volume?: number;
        amount?: number;
        tick?: number;
        day_range?: number;
    };
    change_pct: number | null;
    total_amount: number | null;
    total_volume: number | null;
}

export interface IntradayMetrics {
    return_30s: number | null;
    return_1m: number | null;
    return_3m: number | null;
    return_5m: number | null;
    momentum_acceleration: number;
    volume_acceleration: number | null;
    volume_1m: number | null;
    volume_3m: number | null;
    vwap: number | null;
    vwap_pos_pct: number | null;
    vwap_structure_score: number | null;
    relative_strength_score: number | null;
    breakout_score: number | null;
    breakout_type: BreakoutType;
    trade_aggression_score: number | null;
    trade_aggression_available: boolean;
    pullback_quality_score: number | null;
    pullback_state: PullbackState;
    spread_pct: number | null;
    liquidity_score: number | null;
}

export interface IntradayRisk {
    chase_risk: ChaseRisk;
    invalid_price: number | null;
    invalid_reason: string | null;
    /** Fake-breakout / fade patterns detected on the same snapshot. */
    trap_flags?: import('./trap-detector.ts').TrapFlag[];
    /** Score already deducted for those traps. */
    trap_penalty?: number;
}

export interface IntradayRankItem {
    symbol: string;
    name: string;
    candidate_origin: CandidateOrigin;
    candidate_sources: CandidateSource[];
    a_score: number | null;
    open_score: number | null;
    open_gate_status: string | null;
    rank: number;
    rank_prev: number | null;
    rank_change: number | null;
    rank_1m_ago: number | null;
    rank_5m_ago: number | null;
    rank_velocity: number | null;
    /** Last trade / reference for UI — may be 0 after hours. */
    last_price: number | null;
    /** Strategy / display primary change — adjusted on ex-div day. */
    change_pct: number | null;
    /** Unadjusted vs raw previous close (ex-div day). */
    raw_change_pct?: number | null;
    adjusted_change_pct?: number | null;
    gap_adjustment_reason?: 'CORPORATE_ACTION' | 'NONE' | null;
    corporate_action?: {
        has_action_today: boolean;
        action_type: string | null;
        badge: 'EX-DIV' | 'EX-RIGHT' | 'EX-RIGHT-DIV' | null;
        cash_dividend: number | null;
        ex_reference_price: number | null;
    } | null;
    intraday_score: number;
    raw_intraday_score: number;
    heat_score: number;
    state: IntradayState;
    metrics: IntradayMetrics;
    risk: IntradayRisk;
    events: IntradayEventType[];
    reasons: string[];
    risks: string[];
    data_health: string;
    data_blocked: boolean;
    notification_candidate: boolean;
    confirmation_count: number;
    signal_id: string | null;
    evaluation_id: string;
    updated_at: string;
    /** Available weight / total weight after renormalization. */
    score_coverage_pct?: number;
    score_confidence?: 'high' | 'medium' | 'low';
    feature_availability?: Record<string, boolean>;
}

export interface IntradayEvent {
    event_id: string;
    event_type: IntradayEventType;
    symbol: string;
    name: string;
    strength: number;
    price_at_event: number | null;
    rank: number | null;
    intraday_score: number | null;
    heat_score: number | null;
    timestamp: string;
    notification_candidate: boolean;
}

export interface IntradayRankBatch {
    as_of: string;
    phase_hint: string;
    count: number;
    strong: number;
    heating: number;
    emerging: number;
    items: IntradayRankItem[];
    warnings: string[];
    evaluate_interval_sec: number;
    scanner_interval_sec: number;
}
