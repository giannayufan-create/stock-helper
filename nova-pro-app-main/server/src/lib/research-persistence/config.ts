// server/src/lib/research-persistence/config.ts

import type { ResearchRepositoryMode } from './types.ts';

export interface ResearchPersistenceConfig {
    /** Canonical configured mode from RESEARCH_REPOSITORY (or legacy alias). */
    configured_mode: ResearchRepositoryMode;
    /** Effective mode after fail-safe (may fall back to jsonl). */
    mode: ResearchRepositoryMode;
    /** True when RESEARCH_REPOSITORY and RESEARCH_REPOSITORY_MODE disagree. */
    env_conflict: boolean;
    env_conflict_message: string | null;
    /** Legacy alias was used because RESEARCH_REPOSITORY unset. */
    used_legacy_alias: boolean;
    queue_max_depth: number;
    queue_warn_depth: number;
    queue_critical_depth: number;
    hydrate_lookback_days: number;
    default_page_limit: number;
}

function parseMode(raw: string | undefined): ResearchRepositoryMode | null {
    if (!raw) return null;
    const v = raw.trim().toLowerCase();
    if (v === 'firestore' || v === 'dual' || v === 'jsonl') return v;
    return null;
}

/**
 * Canonical env: RESEARCH_REPOSITORY
 * Legacy alias: RESEARCH_REPOSITORY_MODE (backward compatible)
 *
 * Conflict (both set, different values) → fail-safe to jsonl + warning.
 * Never logs secret values.
 */
export function loadResearchPersistenceConfig(
    env: NodeJS.ProcessEnv = process.env,
): ResearchPersistenceConfig {
    const primaryRaw = env.RESEARCH_REPOSITORY;
    const legacyRaw = env.RESEARCH_REPOSITORY_MODE;
    const primary = parseMode(primaryRaw);
    const legacy = parseMode(legacyRaw);

    let configured_mode: ResearchRepositoryMode = 'jsonl';
    let used_legacy_alias = false;
    let env_conflict = false;
    let env_conflict_message: string | null = null;

    if (primary && legacy && primary !== legacy) {
        env_conflict = true;
        env_conflict_message =
            `RESEARCH_REPOSITORY=${primary} conflicts with RESEARCH_REPOSITORY_MODE=${legacy}; fail-safe effective_mode=jsonl`;
        configured_mode = primary; // report what primary asked for
        console.warn(`[research-persistence] ${env_conflict_message}`);
    } else if (primary) {
        configured_mode = primary;
    } else if (legacy) {
        configured_mode = legacy;
        used_legacy_alias = true;
        console.warn(
            '[research-persistence] RESEARCH_REPOSITORY unset; using legacy alias RESEARCH_REPOSITORY_MODE — prefer RESEARCH_REPOSITORY',
        );
    } else if (primaryRaw || legacyRaw) {
        console.warn(
            '[research-persistence] invalid repository mode value; fail-safe jsonl (allowed: jsonl|dual|firestore)',
        );
        configured_mode = 'jsonl';
    }

    // Conflict → fail-safe jsonl for effective mode
    const mode: ResearchRepositoryMode = env_conflict
        ? 'jsonl'
        : configured_mode;

    return {
        configured_mode,
        mode,
        env_conflict,
        env_conflict_message,
        used_legacy_alias,
        queue_max_depth: Number(env.RESEARCH_PERSISTENCE_QUEUE_MAX) || 500,
        queue_warn_depth: Number(env.RESEARCH_PERSISTENCE_QUEUE_WARN) || 100,
        queue_critical_depth:
            Number(env.RESEARCH_PERSISTENCE_QUEUE_CRITICAL) || 400,
        hydrate_lookback_days:
            Number(env.RESEARCH_HYDRATE_LOOKBACK_DAYS) || 30,
        default_page_limit: Number(env.RESEARCH_PAGE_LIMIT) || 100,
    };
}

/** Missing credential env names only — never values. */
export function missingFirebaseCredentialNames(
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    const missing: string[] = [];
    if (!env.FIREBASE_PROJECT_ID?.trim()) missing.push('FIREBASE_PROJECT_ID');
    if (!env.FIREBASE_CLIENT_EMAIL?.trim()) missing.push('FIREBASE_CLIENT_EMAIL');
    if (!env.FIREBASE_PRIVATE_KEY?.trim()) missing.push('FIREBASE_PRIVATE_KEY');
    // GOOGLE_APPLICATION_CREDENTIALS is optional fallback, not primary
    return missing;
}

export function hasPrimaryFirebaseCredentials(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return missingFirebaseCredentialNames(env).length === 0;
}
