// server/src/lib/radar-rescue/index.ts
export { RadarRescueService } from './service.ts';
export { loadRadarRescueConfig, DEFAULT_RESCUE_CONFIG } from './config.ts';
export { computeTriggerScore } from './trigger-score.ts';
export { evaluateEarlyTrigger } from './early-trigger.ts';
export {
    resolveAttackState,
    buildAttackFeatures,
    isTrueAskEating,
    attackStateLabel,
} from './attack-state.ts';
export {
    computeOpportunityScore,
    computeChaseRisk,
} from './opportunity-chase.ts';
export { buildMultiLaneCandidates } from './multi-lane.ts';
export { FunnelTraceService } from './funnel-trace.ts';
export { EodTruthService } from './eod-truth.ts';
export { EarlySignalStore } from './early-signal-store.ts';
export {
    EarlyBacktestSession,
    evaluatePriceTarget,
    isTrackingCompleteToClose,
    expectedSessionEndKnownAt,
} from './early-backtest.ts';
export {
    buildEarlyDailyReport,
    EarlyDailyReportStore,
    formatRateLabel,
    toBucketView,
    EARLY_REPORT_SOURCE_LABEL,
} from './early-daily-report.ts';
export type {
    EarlyDailyReport,
    EarlyReportSource,
    MetricBucketView,
    EarlySignalReportRow,
} from './early-daily-report.ts';
export { printsFromRecentPrices } from './print-samples.ts';
export { computeSuggestedBuy } from './suggested-buy.ts';
export { buildDailyRecall, buildMissedWinners } from './recall.ts';
export { judgeNewsForSymbol } from './news-judge.ts';
export * from './types.ts';
