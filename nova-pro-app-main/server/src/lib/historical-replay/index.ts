// server/src/lib/historical-replay/index.ts

export {
    DEFAULT_BAR_TIMESTAMP_SEMANTICS,
    resolveBarTimeWindow,
} from './bar-time.ts';
export {
    learningEligible,
    REPLAY_1M_FEATURES,
    replayConfidence,
    replayQualityFromDataMissing,
    scoreConfidenceFromCoverage,
} from './feature-capability.ts';
export type { UniverseSource } from './feature-capability.ts';
export {
    buildSyntheticDayBars,
    HistoricalDataLoader,
    parseBarTs,
    SESSION_END_MIN,
    SESSION_START_MIN,
} from './historical-data-loader.ts';
export type { DayBars, GapKind, MinuteBar } from './historical-data-loader.ts';
export { parseSpeed, ReplayClock } from './replay-clock.ts';
export { ReplayMarketSource } from './replay-market-source.ts';
export {
    formatReplayReport,
    runHistoricalReplay,
    stableSnapshot,
} from './replay-runner.ts';
export type { ReplayRunInput, ReplayRunReport } from './replay-runner.ts';
