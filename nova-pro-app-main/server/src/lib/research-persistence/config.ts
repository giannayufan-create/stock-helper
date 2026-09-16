// server/src/lib/research-persistence/config.ts

import type { ResearchRepositoryMode } from './types.ts';

export interface ResearchPersistenceConfig {
    mode: ResearchRepositoryMode;
    queue_max_depth: number;
    queue_warn_depth: number;
    queue_critical_depth: number;
    /** Startup hydrate lookback days for Firestore cache. */
    hydrate_lookback_days: number;
    default_page_limit: number;
}

export function loadResearchPersistenceConfig(
    env: NodeJS.ProcessEnv = process.env,
): ResearchPersistenceConfig {
    const raw = (
        env.RESEARCH_REPOSITORY ??
        env.RESEARCH_REPOSITORY_MODE ??
        'jsonl'
    )
        .trim()
        .toLowerCase();
    const mode: ResearchRepositoryMode =
        raw === 'firestore' || raw === 'dual' || raw === 'jsonl'
            ? raw
            : 'jsonl';
    return {
        mode,
        queue_max_depth: Number(env.RESEARCH_PERSISTENCE_QUEUE_MAX) || 500,
        queue_warn_depth: Number(env.RESEARCH_PERSISTENCE_QUEUE_WARN) || 100,
        queue_critical_depth:
            Number(env.RESEARCH_PERSISTENCE_QUEUE_CRITICAL) || 400,
        hydrate_lookback_days:
            Number(env.RESEARCH_HYDRATE_LOOKBACK_DAYS) || 30,
        default_page_limit: Number(env.RESEARCH_PAGE_LIMIT) || 100,
    };
}
