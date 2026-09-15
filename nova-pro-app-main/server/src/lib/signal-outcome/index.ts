// server/src/lib/signal-outcome/index.ts

export {
    applyFilters,
    formatAnalyticsTable,
    groupBySignalType,
    heatBuckets,
    openPassScoreBuckets,
    regimeGroups,
    scoreBucketsC,
    type AnalyticsFilter,
    type BucketStats,
    type SignalTypeStats,
} from './analytics.ts';
export { calculateOutcome, priceAtOrAfter } from './outcome-calculator.ts';
export {
    JsonlSignalOutcomeRepository,
    type SignalOutcomeRepository,
} from './repository.ts';
export { SignalOutcomeService } from './service.ts';
export type {
    OutcomeSequence,
    OutcomeStatus,
    PriceBar,
    SignalOutcome,
} from './types.ts';
