// server/src/lib/research-persistence/index.ts

export {
    createResearchRepositories,
    type ResearchRepositories,
} from './factory.ts';
export {
    loadResearchPersistenceConfig,
    missingFirebaseCredentialNames,
    hasPrimaryFirebaseCredentials,
} from './config.ts';
export type { FirebaseAdminStatus } from './types.ts';
export {
    getResearchFirestore,
    isFirebaseAdminReady,
    getFirebaseProjectIdSafe,
    getFirebaseStatus,
    getAdminInitError,
    verifyFirestoreConnectivity,
} from './admin.ts';
export { MemoryStrategySignalRepository } from './memory-signal-repository.ts';
export { MemorySignalOutcomeRepository } from './memory-outcome-repository.ts';
export { FirestoreStrategySignalRepository } from './firestore-signal-repository.ts';
export { FirestoreSignalOutcomeRepository } from './firestore-outcome-repository.ts';
export {
    DualStrategySignalRepository,
    DualSignalOutcomeRepository,
} from './dual-repository.ts';
export { signalIdentityHash, signalsContentEqual } from './hash.ts';
export type {
    ResearchPersistenceHealth,
    ResearchRepositoryMode,
    PersistResult,
} from './types.ts';
export {
    STRATEGY_SIGNALS_COLLECTION,
    SIGNAL_OUTCOMES_COLLECTION,
    RESEARCH_DIAGNOSTICS_COLLECTION,
} from './types.ts';
