// BoardAttack research types — never mutates A/B/C/BP/Rank.
// Offline backtest of limit-up recall using daily OHLC (+ open gap).
// Minute-bar / orderbook features are optional later (Sponsor or local bars).

export interface DailyBar {
    date: string;
    symbol: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    amount: number | null;
}

/** Features known at/near the open — no same-day close leakage. */
export interface BoardOpenFeatures {
    symbol: string;
    date: string;
    gap_pct: number | null;
    prev_chg_pct: number | null;
    prev_vol_ratio_20d: number | null;
    prev_was_limit_up: boolean;
    prev_limit_streak: number;
    prev_range_pct: number | null;
    /** Present only when minute bars are supplied. */
    rvol_30m?: number | null;
    chg_30m?: number | null;
}

export interface BoardScoredRow extends BoardOpenFeatures {
    score: number;
    rank: number;
    /** Label for the same calendar day (end-of-day). */
    is_limit_up: boolean;
    day_chg_pct: number | null;
}

export interface DayBacktestResult {
    date: string;
    limit_up_count: number;
    universe_count: number;
    top_n: number;
    hit_in_top_n: number;
    recall: number | null;
    precision: number | null;
    avg_gap_pct_hits: number | null;
    rows: BoardScoredRow[];
}

export interface FeatureSweepResult {
    feature: keyof BoardOpenFeatures;
    top_n: number;
    days: number;
    mean_recall: number | null;
    mean_precision: number | null;
}

export interface BacktestSummary {
    from: string;
    to: string;
    top_n: number;
    mode: 'equal_weight' | 'single_feature';
    feature?: string;
    days: DayBacktestResult[];
    mean_recall: number | null;
    mean_precision: number | null;
    total_limit_ups: number;
    total_hits: number;
    notes: string[];
}

export const BOARD_ATTACK_NOTES = [
    'Research only — does not mutate A/B/C / Buy Pressure / Rank.',
    'v1 uses daily FinMind TaiwanStockPrice: open-gap + previous-day structure.',
    'True 0–30m RVOL / bid-ask need minute bars or post-candidate subscribe (not in Free path).',
    'Equal-weight / single-feature scores are placeholders until sweep results stabilize.',
] as const;
