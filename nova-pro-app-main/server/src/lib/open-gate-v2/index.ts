// server/src/lib/open-gate-v2/index.ts — public exports

export { adaptACandidate, adaptACandidates } from './a-candidate-adapter.ts';
export type { ACandidateRaw } from './a-candidate-adapter.ts';
export { ACandidateRepository } from './a-candidate-repository.ts';
export {
    DEFAULT_OPEN_GATE_CONFIG,
    loadOpenGateConfig,
    reloadOpenGateConfig,
} from './config.ts';
export type { OpenGateConfig } from './config.ts';
export { DataHealthService } from './data-health.ts';
export { HistoricalProfileCache } from './historical-intraday-profile.ts';
export { MarketDataEngine } from './market-data-engine.ts';
export { MarketRegimeService } from './market-regime.ts';
export { OpenConfirmRepository } from './open-confirm-repository.ts';
export {
    evaluateOpenGate,
    resolvePhase,
} from './open-gate-evaluator.ts';
export { OpenGateV2Service } from './service.ts';
export type { OpenConfirmBatchResult } from './service.ts';
export { OpenGateRuntimeCoordinator } from './open-gate-runtime-coordinator.ts';
export { ACandidateStore } from './a-candidate-store.ts';
export type { ACandidateSnapshot } from './a-candidate-store.ts';
export type {
    ACandidate,
    ChaseRisk,
    DataHealth,
    OpenConfirmResult,
    OpenConfirmStatus,
    OpenPhase,
} from './types.ts';
