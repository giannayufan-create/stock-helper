// server/src/lib/context-research/sample-guard.ts

import type { ContextResearchConfig } from './config.ts';
import { DEFAULT_CR_CONFIG } from './config.ts';
import type { SampleGuardLabel } from './types.ts';

export function sampleGuardLabel(
    n: number,
    cfg: ContextResearchConfig = DEFAULT_CR_CONFIG,
): SampleGuardLabel {
    if (n < cfg.sample_guards.insufficient_below) return 'INSUFFICIENT_DATA';
    if (n < cfg.sample_guards.exploratory_below) return 'EXPLORATORY';
    return 'ANALYSIS_ELIGIBLE';
}

export function confidenceRank(c: 'HIGH' | 'MEDIUM' | 'LOW'): number {
    return c === 'HIGH' ? 3 : c === 'MEDIUM' ? 2 : 1;
}

export function passesContextQuality(
    coveragePct: number | null | undefined,
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null | undefined,
    cfg: ContextResearchConfig = DEFAULT_CR_CONFIG,
): boolean {
    if (coveragePct == null || confidence == null) return false;
    if (coveragePct < cfg.min_coverage_pct) return false;
    return (
        confidenceRank(confidence) >=
        confidenceRank(cfg.min_context_confidence)
    );
}
