// server/src/lib/context-research/alignment.ts

import type { ContextAlignment, ContextSnapshot, ContextTag } from './types.ts';

/** Research label only — never mutates strategy scores. */
export function deriveContextAlignment(
    snap: ContextSnapshot,
    tags: ContextTag[],
): ContextAlignment {
    const avail = Object.values(snap.feature_availability).filter(Boolean).length;
    if (avail < 2 || snap.context_coverage_pct < 25) {
        return 'INSUFFICIENT_DATA';
    }

    let support = 0;
    let contrary = 0;

    if (tags.includes('MARKET_RISK_ON')) support += 1;
    if (tags.includes('MARKET_RISK_OFF')) contrary += 1;

    if (
        tags.includes('SECTOR_ROTATING_IN') ||
        tags.includes('SECTOR_HOT') ||
        tags.includes('SECTOR_BROAD_STRENGTH')
    ) {
        support += 1;
    }
    if (tags.includes('SECTOR_ROTATING_OUT')) contrary += 1;
    if (tags.includes('SECTOR_HIGH_CONCENTRATION')) contrary += 0.5;

    if (tags.includes('CAPITAL_ATTENTION_RISING')) support += 0.5;
    if (tags.includes('EVENT_CONFIRMED')) support += 0.5;
    if (tags.includes('EVENT_UNCONFIRMED') && tags.includes('EVENT_RELEVANT')) {
        // relevant but unconfirmed — mixed lean
        support += 0.1;
    }

    if (support >= 1.5 && contrary < 0.5) return 'ALIGNED';
    if (contrary >= 1 && support < 0.5) return 'CONTRARY';
    if (support >= 0.5 || contrary >= 0.5) return 'MIXED';
    return 'INSUFFICIENT_DATA';
}
