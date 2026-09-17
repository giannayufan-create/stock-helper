// server/src/lib/radar-quality/index.ts
export { RadarQualityService } from './service.ts';
export { loadRadarQualityConfig, DEFAULT_RQ_CONFIG } from './config.ts';
export type { RadarQualityConfig } from './config.ts';
export {
    RQ_VERSION,
    type RadarQualityBatch,
    type RadarQualityItem,
    type RadarMomentumState,
    type FocusSlot,
    type InstitutionalSnapshot,
    type InstitutionalContinuation,
    type ForeignBackground,
    type RadarQualityInput,
} from './types.ts';
export {
    evaluateMomentum,
    evaluateRawMomentum,
    applyHysteresis,
    collectActiveConfirmations,
} from './momentum.ts';
export {
    computeFocusScore,
    selectFocusTop3,
} from './focus.ts';
export {
    classifyForeignBackground,
    evaluateContinuation,
    containsForbiddenForeignWording,
    FORBIDDEN_FOREIGN_PHRASES,
    backgroundLabel,
    continuationLabel,
} from './institutional.ts';
