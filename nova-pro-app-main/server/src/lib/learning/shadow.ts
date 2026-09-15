// server/src/lib/learning/shadow.ts
// Shadow candidate vs production — same MarketRuntime, no second subscription.
// Never auto-promotes. Session-immutable production params.

import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLearningConfig } from './config.ts';
import type { CandidateConfig, ShadowComparisonRow } from './types.ts';

export interface ShadowState {
    enabled: boolean;
    candidate: CandidateConfig | null;
    experiment_id: string | null;
    activated_at: string | null;
    days_observed: number;
    signals_observed: number;
    /** Hard rule: production config path is never overwritten by this module. */
    production_immutable: true;
}

function shadowRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', 'data', 'learning', 'shadow');
}

function statePath(): string {
    return join(shadowRoot(), 'shadow_state.json');
}

function comparisonsPath(): string {
    return join(shadowRoot(), 'comparisons.jsonl');
}

function ensureDir(): void {
    const root = shadowRoot();
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
}

export function loadShadowState(): ShadowState {
    ensureDir();
    const p = statePath();
    if (!existsSync(p)) {
        return {
            enabled: false,
            candidate: null,
            experiment_id: null,
            activated_at: null,
            days_observed: 0,
            signals_observed: 0,
            production_immutable: true,
        };
    }
    const raw = JSON.parse(readFileSync(p, 'utf8')) as ShadowState;
    return { ...raw, production_immutable: true };
}

/**
 * Arm shadow for research — does NOT modify production yaml.
 * Requires explicit enable; auto_promote remains false.
 */
export function armShadow(args: {
    candidate: CandidateConfig;
    experiment_id: string;
    enabled?: boolean;
}): ShadowState {
    const cfg = loadLearningConfig();
    if (cfg.promotion.auto_promote) {
        throw new Error('auto_promote must remain false');
    }
    ensureDir();
    const state: ShadowState = {
        enabled: args.enabled ?? cfg.shadow.enabled,
        candidate: args.candidate,
        experiment_id: args.experiment_id,
        activated_at: new Date().toISOString(),
        days_observed: 0,
        signals_observed: 0,
        production_immutable: true,
    };
    writeFileSync(statePath(), JSON.stringify(state, null, 2));
    return state;
}

export function disarmShadow(): ShadowState {
    const state = loadShadowState();
    state.enabled = false;
    writeFileSync(statePath(), JSON.stringify(state, null, 2));
    return state;
}

/**
 * Record production vs shadow scores from the same evaluation tick.
 * Callers must feed both scores from one MarketRuntime snapshot.
 */
export function recordShadowComparison(row: ShadowComparisonRow): void {
    ensureDir();
    appendFileSync(comparisonsPath(), `${JSON.stringify(row)}\n`);
    const state = loadShadowState();
    state.signals_observed += 1;
    writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

export function shadowReadyForManualReview(state?: ShadowState): {
    ready: boolean;
    reason: string;
} {
    const cfg = loadLearningConfig().shadow;
    const s = state ?? loadShadowState();
    if (!s.enabled || !s.candidate) {
        return { ready: false, reason: 'shadow not armed' };
    }
    if (
        s.days_observed >= cfg.min_shadow_days ||
        s.signals_observed >= cfg.min_shadow_signals
    ) {
        return {
            ready: true,
            reason: `READY_FOR_MANUAL_REVIEW (days=${s.days_observed} signals=${s.signals_observed})`,
        };
    }
    return {
        ready: false,
        reason: `need days>=${cfg.min_shadow_days} or signals>=${cfg.min_shadow_signals}`,
    };
}

/**
 * Apply candidate threshold to a production score for shadow state labeling.
 * Pure function — no market I/O.
 */
export function shadowStateFromScore(
    score: number,
    candidate: CandidateConfig,
): string {
    if (candidate.target === 'open-gate') {
        const enter = candidate.open_gate?.pass_enter_threshold ?? 78;
        const exit = candidate.open_gate?.pass_exit_threshold ?? 74;
        if (score >= enter) return 'PASS';
        if (score >= exit) return 'WATCH';
        return 'REJECT';
    }
    const enter = candidate.intraday_rank?.strong_enter ?? 80;
    const exit = candidate.intraday_rank?.strong_exit ?? 74;
    if (score >= enter) return 'STRONG';
    if (score >= exit) return 'HEATING';
    return 'WATCH';
}
