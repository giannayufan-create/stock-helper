// Shadow multi-experiment — research-only candidate overlays vs production.

export {
    buildAllExperimentAnalytics,
    buildShadowAnalytics,
    classifyComparison,
    computeSignalCoverageRatio,
    filterComparisonsByExperiment,
    hasProductionSignal,
    hasShadowSignal,
} from './analytics.ts';
export {
    DEFAULT_EXPERIMENTS,
    DEFAULT_SHADOW_CONFIG,
    deepMerge,
    loadShadowConfig,
    mergeNumericOverlay,
    reloadShadowConfig,
    setShadowConfigForTest,
    shadowConfigGeneration,
} from './config.ts';
export {
    assertNeverAutoPromote,
    evaluateShadowPromotion,
    recommendPromotion,
} from './promotion.ts';
export {
    JsonlShadowRepository,
    type ShadowRepository,
} from './repository.ts';
export {
    isShadowCashSession,
    sessionMinuteTaipei,
    taipeiYmd,
} from './session.ts';
export {
    isMeaningfulShadowDiff,
    ShadowEvaluationService,
    type EvaluatePairInput,
    type ShadowEvaluationOptions,
} from './service.ts';
export type {
    ShadowAnalyticsSummary,
    ShadowArmGroup,
    ShadowArmMetrics,
    ShadowComparisonDelta,
    ShadowComparisonRow,
    ShadowConfig,
    ShadowExperimentDef,
    ShadowExperimentLabel,
    ShadowOutcomeHint,
    ShadowPromotionConfig,
    ShadowPromotionRecommendation,
    ShadowPromotionStatus,
    ShadowSideSnapshot,
    ShadowStrategySignal,
} from './types.ts';
