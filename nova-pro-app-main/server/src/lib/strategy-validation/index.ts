// server/src/lib/strategy-validation/index.ts

export {
    TW_COST_ASSUMPTIONS_AS_OF,
    TW_COST_ASSUMPTIONS_SOURCE,
    DEFAULT_TW_COST_RATES,
    roundTripCost,
    netPnlAfterCost,
    type TwCostRates,
    type RoundTripCost,
} from './cost-model.ts';

export { simulateTrade, sameBarAmbiguous } from './simulator.ts';

export {
    computeSignalPathMetrics,
    validateSignals,
    emptyValidationSummary,
} from './tracker.ts';

export { StrategyValidationService } from './service.ts';

export {
    VALIDATION_STRATEGY_NAME,
    VALIDATION_STRATEGY_VERSION,
    EXIT_DECISIONS_NEEDED,
    DEFAULT_PROVISIONAL_ASSUMPTIONS,
    type ExitDecisionNeeded,
    type PriceBar,
    type SimulationAssumptions,
    type FillSkipReason,
    type ExitReason,
    type SimulatedTrade,
    type SignalPathMetrics,
    type RealFillPlaceholder,
    type ValidationTradeRow,
    type ValidationSummary,
    type ValidateSignalsInput,
} from './types.ts';
