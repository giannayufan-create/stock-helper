// server/src/lib/strategy-signal/index.ts

export { StrategySignalFactory, configHashOf } from './factory.ts';
export {
    StrategySignalBridge,
    hashConfig,
    sha12,
} from './bridge.ts';
export { SignalLifecycleManager } from './lifecycle.ts';
export {
    JsonlStrategySignalRepository,
    type StrategySignalRepository,
} from './repository.ts';
export {
    FORMAL_SIGNAL_TYPES,
    INTRADAY_RANK_VERSION,
    OPEN_GATE_VERSION,
    RUNTIME_VERSION,
    STRATEGY_VERSION,
    type LifecycleRecord,
    type ScoreConfidence,
    type SignalLifecycleStatus,
    type SignalSource,
    type SignalType,
    type StrategySignal,
} from './types.ts';
