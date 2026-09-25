// server/src/lib/radar-rescue/types.ts
// RADAR FULLSTACK RESCUE v3 — parallel types. Never mutates A/B/C/BP.

export const RESCUE_VERSION = 'rescue_v3';

export type RadarMode = 'legacy' | 'rescue';

export type DropReason =
    | 'NOT_IN_A'
    | 'NOT_IN_SCANNER'
    | 'NOT_IN_DISCOVERY'
    | 'DISCOVERY_POOL_LIMIT'
    | 'NOT_SUBSCRIBED'
    | 'SUBSCRIPTION_CAPACITY'
    | 'ACTIVE_WATCH_LIMIT'
    | 'LIQUIDITY_GATE'
    | 'DATA_STALE'
    | 'DATA_BLOCKED'
    | 'LOW_COVERAGE'
    | 'C_TOP30_LIMIT'
    | 'RADAR_WATCH_ONLY'
    | 'RADAR_BLOCKED'
    | 'NO_CURRENT_MOMENTUM'
    | 'FOCUS_NOT_SELECTED'
    | 'UI_FILTERED_LEGACY'
    | 'UNKNOWN';

export type DiscoveryLane =
    | 'LIQUIDITY_LANE'
    | 'ACCELERATION_LANE'
    | 'REVERSAL_LANE'
    | 'BREAKOUT_LANE'
    | 'A_PRIOR_LANE'
    | 'B_OPEN_LANE'
    | 'SECTOR_LEADER_LANE'
    | 'NEWS_EVENT_LANE';

export type RescueRadarState =
    | 'EARLY'
    | 'PRE_ATTACK'
    | 'ACTIVE'
    | 'PULLBACK'
    | 'WATCH'
    | 'INACTIVE'
    | 'INVALID'
    | 'INSUFFICIENT_DATA'
    | 'EARLY_FAILED'
    | 'WEAKENING'
    | 'NEAR_LIMIT'
    | 'LIMIT_UP'
    | 'STALLING'
    | 'FAKE_BREAKOUT'
    | 'DATA_STALE'
    | 'DATA_INCOMPLETE';

export type ChaseRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
export type DataConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type NewsMarketState =
    | 'NO_RELEVANT_NEWS'
    | 'POSITIVE_UNCONFIRMED'
    | 'POSITIVE_CONFIRMED'
    | 'NEGATIVE_UNCONFIRMED'
    | 'NEGATIVE_CONFIRMED'
    | 'MIXED'
    | 'STALE'
    | 'UNKNOWN';

export type EarlyEvidence =
    | 'RANK_ACCEL'
    | 'MOMENTUM_ACCEL'
    | 'VOLUME_ACCEL'
    | 'BP_RISING'
    | 'VWAP_RECLAIM'
    | 'BREAKOUT'
    | 'BUY_SURGE'
    | 'ASK_EATING'
    | 'TRADE_AGGRESSION_RISING'
    | 'RELATIVE_STRENGTH_RISING';

export interface FunnelTraceRow {
    trade_date: string;
    symbol: string;
    name: string;
    first_seen_at: string;
    in_a: boolean;
    a_score: number | null;
    a_rank: number | null;
    in_scanner: boolean;
    scanner_sources: string[];
    in_discovery: boolean;
    discovery_score: number | null;
    discovery_rank: number | null;
    trigger_score: number | null;
    lanes: DiscoveryLane[];
    in_active_watch: boolean;
    active_watch_rank: number | null;
    in_c: boolean;
    c_score: number | null;
    c_rank: number | null;
    c_state: string | null;
    bp_observed: boolean;
    bp_score: number | null;
    bp_state: string | null;
    bp_trend: number | null;
    radar_state: RescueRadarState;
    radar_confidence: DataConfidence;
    early_trigger: boolean;
    early_trigger_at: string | null;
    /** Sticky: true if radar_state was ACTIVE at any point today. */
    ever_active: boolean;
    /** Best (lowest) focus_rank seen today; null if never focused. */
    best_focus_rank: number | null;
    opportunity_score: number | null;
    chase_risk: ChaseRiskLevel | null;
    focus_score: number | null;
    focus_rank: number | null;
    ui_visible: boolean;
    first_ui_visible_at: string | null;
    news_state: NewsMarketState;
    news_confidence: number | null;
    drop_stage: string | null;
    drop_reason: DropReason | null;
    drop_score: number | null;
    drop_rank: number | null;
    drop_threshold: number | null;
    margin_to_threshold: number | null;
    updated_at: string;
}

export interface EodTruthRow {
    trade_date: string;
    symbol: string;
    prev_close: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number | null;
    adjusted_reference_price: number | null;
    max_return_pct: number | null;
    close_return_pct: number | null;
    max_twd_move: number | null;
    hit_plus_1_twd: boolean;
    hit_plus_3pct: boolean;
    hit_plus_5pct: boolean;
    hit_limit_up: boolean;
    intraday_range: number | null;
    corporate_action_type: string | null;
    corporate_action_adjusted: boolean;
    /** ok = usable for recall; incomplete/missing excluded from success rates. */
    data_status: 'ok' | 'incomplete' | 'missing';
}

export interface RescueNewsJudgement {
    news_id: string;
    published_at: string | null;
    observed_at: string;
    source: string;
    headline: string;
    event_type: string;
    symbols: string[];
    sectors: string[];
    relevance_score: number;
    impact_direction: 'POSITIVE' | 'NEGATIVE' | 'MIXED' | 'NEUTRAL' | 'UNKNOWN';
    impact_strength: 'LOW' | 'MEDIUM' | 'HIGH';
    impact_horizon: 'INTRADAY' | 'SHORT_TERM' | 'MEDIUM_TERM' | 'UNKNOWN';
    confidence: number;
    reason: string;
    evidence: string[];
    freshness: string;
}

export interface RescueCard {
    symbol: string;
    name: string;
    last_price: number | null;
    change_pct: number | null;
    radar_state: RescueRadarState;
    opportunity_score: number;
    chase_risk: ChaseRiskLevel;
    trigger_score: number;
    c_score: number | null;
    bp_score: number | null;
    rank: number | null;
    rank_prev: number | null;
    rank_change: number | null;
    bp_trend: number | null;
    news_state: NewsMarketState;
    news_confidence: number | null;
    reasons: string[];
    layers: {
        stock: boolean;
        sector: boolean;
        market: boolean;
        news: boolean;
    };
    early_evidence: EarlyEvidence[];
    data_confidence: DataConfidence;
    core_feature_ready: boolean;
    coverage_score: number;
    focus_score: number;
    lanes: DiscoveryLane[];
    late_detection: boolean;
    move_before_signal_pct: number | null;
    /** Day-change still below +3% but acceleration already firing. */
    pre_plus3: boolean;
    /** UI label: 漲3%前 / 準備發動 / 正在急攻 … */
    state_label: string;
    true_ask_eating: boolean;
    ask_eating_quality: number;
    push_efficiency: number;
    attack_score: number;
    data_stale: boolean;
    last_valid_state: RescueRadarState | null;
    /** Decision-support suggested buy-in (null when not actionable). */
    suggested_buy_price: number | null;
    suggested_buy_zone_low: number | null;
    suggested_buy_zone_high: number | null;
    suggested_buy_note: string | null;
}

export interface RescueFocusBlock {
    early: RescueCard[];
    confirmed: RescueCard[];
}

export interface DailyRecallReport {
    trade_date: string;
    plus_3_count: number;
    scanner: string;
    discovery: string;
    active: string;
    c: string;
    early: string;
    active_state: string;
    focus: string;
    ui: string;
    largest_recall_loss_stage: string;
    missed: MissedWinnerCase[];
}

export interface MissedWinnerCase {
    symbol: string;
    name: string;
    max_return_pct: number;
    in_a: boolean;
    in_scanner: boolean;
    in_discovery: boolean;
    in_active_watch: boolean;
    in_c: boolean;
    early: boolean;
    active: boolean;
    focus: boolean;
    ui: boolean;
    first_drop_stage: string;
    first_drop_reason: DropReason;
}

export interface FalsePositiveCase {
    symbol: string;
    signal_state: 'EARLY' | 'ACTIVE' | 'FOCUS';
    signal_time: string;
    mfe: number | null;
    mae: number | null;
    features: Record<string, number | string | null>;
}

export interface RescueBatch {
    as_of: string;
    version: string;
    mode: RadarMode;
    mutates_strategy: false;
    market_status: string | null;
    data_status: string;
    focus: RescueFocusBlock;
    early: RescueCard[];
    active: RescueCard[];
    pullback: RescueCard[];
    watch: RescueCard[];
    insufficient: RescueCard[];
    count: {
        early: number;
        active: number;
        pullback: number;
        watch: number;
        insufficient: number;
    };
}
