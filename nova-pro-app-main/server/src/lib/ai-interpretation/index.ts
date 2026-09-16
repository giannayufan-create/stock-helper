// server/src/lib/ai-interpretation/index.ts

export {
    AI_INTERPRETATION_VERSION,
    type StockAIInterpretation,
    type RadarAIInterpretation,
    type StockInterpretationInput,
    type RadarStockRowInput,
    type RadarFilterSnapshot,
} from './types.ts';
export {
    DEFAULT_AI_INTERPRETATION_CONFIG,
    loadAiInterpretationConfig,
    configHash,
} from './config.ts';
export { scoreStockInterpretation } from './stock-scorer.ts';
export { scoreRadarInterpretation } from './radar-scorer.ts';
export { buildRadarAggregate } from './radar-aggregate.ts';
export { AiInterpretationService } from './service.ts';
export { scoreBand, finalizeScore } from './score-bands.ts';
