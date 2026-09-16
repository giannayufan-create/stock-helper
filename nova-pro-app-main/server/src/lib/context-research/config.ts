// server/src/lib/context-research/config.ts

export interface ContextResearchConfig {
    enabled: boolean;
    min_context_confidence: 'LOW' | 'MEDIUM' | 'HIGH';
    min_coverage_pct: number;
    sample_guards: {
        insufficient_below: number;
        exploratory_below: number;
    };
    strength_weights: {
        sector_rotation: number;
        capital_rotation: number;
        taiwan_regime: number;
        sector_breadth: number;
        sector_rs: number;
        event_confirmation: number;
        institutional: number;
    };
}

export const DEFAULT_CR_CONFIG: ContextResearchConfig = {
    enabled: true,
    min_context_confidence: 'MEDIUM',
    min_coverage_pct: 40,
    sample_guards: {
        insufficient_below: 30,
        exploratory_below: 100,
    },
    strength_weights: {
        sector_rotation: 0.25,
        capital_rotation: 0.2,
        taiwan_regime: 0.15,
        sector_breadth: 0.15,
        sector_rs: 0.1,
        event_confirmation: 0.1,
        institutional: 0.05,
    },
};
