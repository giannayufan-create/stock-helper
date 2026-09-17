// server/src/lib/intraday-rank/index.ts

export { loadIntradayRankConfig } from './config.ts';
export { DiscoveryEngine } from './discovery-engine.ts';
export { IntradayRankService } from './service.ts';
export {
    detectIntradayTraps,
    DEFAULT_TRAP_PENALTIES,
    DEFAULT_TRAP_THRESHOLDS,
    type TrapFlag,
    type TrapReport,
} from './trap-detector.ts';
export type {
    DiscoveryItem,
    IntradayEvent,
    IntradayRankBatch,
    IntradayRankItem,
} from './types.ts';
