// BoardAttack research — offline limit-up backtest (never mutates A/B/C).

export {
    runBoardAttackBacktest,
    sweepSingleFeatures,
    type BacktestOptions,
} from './backtest.ts';
export { buildOpenFeatures } from './features.ts';
export {
    FinMindDailyPriceStore,
    parseFinMindPriceRows,
    resolveFinMindToken,
} from './finmind-daily.ts';
export {
    LIMIT_UP_PCT,
    dayChangePct,
    isLimitUp,
    openGapPct,
} from './labels.ts';
export { evaluateDay, meanMetric } from './metrics.ts';
export {
    DEFAULT_SCORE_FEATURES,
    attachRanksAndLabels,
    scoreEqualWeight,
    scoreSingleFeature,
    type ScoreFeatureKey,
} from './score.ts';
export type {
    BacktestSummary,
    BoardOpenFeatures,
    BoardScoredRow,
    DailyBar,
    DayBacktestResult,
    FeatureSweepResult,
} from './types.ts';
export { BOARD_ATTACK_NOTES } from './types.ts';
