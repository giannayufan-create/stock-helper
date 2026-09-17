// server/src/lib/research-persistence/factory.ts

import { JsonlStrategySignalRepository } from '../strategy-signal/repository.ts';
import { JsonlSignalOutcomeRepository } from '../signal-outcome/repository.ts';
import type { StrategySignalRepository } from '../strategy-signal/repository.ts';
import type { SignalOutcomeRepository } from '../signal-outcome/repository.ts';
import {
    hasPrimaryFirebaseCredentials,
    loadResearchPersistenceConfig,
    missingFirebaseCredentialNames,
    type ResearchPersistenceConfig,
} from './config.ts';
import {
    getFirebaseProjectIdSafe,
    getFirebaseStatus,
    isFirebaseAdminReady,
    verifyFirestoreConnectivity,
} from './admin.ts';
import { FirestoreStrategySignalRepository } from './firestore-signal-repository.ts';
import { FirestoreSignalOutcomeRepository } from './firestore-outcome-repository.ts';
import {
    DualSignalOutcomeRepository,
    DualStrategySignalRepository,
} from './dual-repository.ts';
import type { HydrateStatus, ResearchPersistenceHealth } from './types.ts';

export interface ResearchRepositories {
    configured_mode: ResearchPersistenceConfig['configured_mode'];
    mode: ResearchPersistenceConfig['mode'];
    signals: StrategySignalRepository;
    outcomes: SignalOutcomeRepository;
    cfg: ResearchPersistenceConfig;
    getHealth(): ResearchPersistenceHealth;
    hydrate(): Promise<void>;
    flush(): Promise<void>;
}

function emptyLatency() {
    return {
        sample_count: 0,
        avg_ms: null,
        p95_ms: null,
        max_ms: null,
        max_queue_depth: 0,
    };
}

export function createResearchRepositories(
    cfg: ResearchPersistenceConfig = loadResearchPersistenceConfig(),
): ResearchRepositories {
    console.log(
        `[research-persistence] configured_mode=${cfg.configured_mode} effective_repository_mode=${cfg.mode}` +
            (cfg.used_legacy_alias ? ' (legacy RESEARCH_REPOSITORY)' : '') +
            (cfg.env_conflict ? ' ENV_CONFLICT_FAILSAFE' : ''),
    );

    // dual/firestore without credentials → fail-safe jsonl (no silent pretend)
    let effectiveCfg = cfg;
    if (
        (cfg.mode === 'dual' || cfg.mode === 'firestore') &&
        !hasPrimaryFirebaseCredentials() &&
        !isFirebaseAdminReady()
    ) {
        const missing = missingFirebaseCredentialNames();
        console.warn(
            `[research-persistence] Firestore credentials missing (${missing.join(', ')}); fail-safe effective_mode=jsonl — set Render env before dual/firestore cutover`,
        );
        effectiveCfg = {
            ...cfg,
            mode: 'jsonl',
        };
    }

    if (effectiveCfg.mode === 'jsonl') {
        const signals = new JsonlStrategySignalRepository();
        const outcomes = new JsonlSignalOutcomeRepository();
        let hydrate_status: HydrateStatus = 'IDLE';
        let last_hydrate_at: string | null = null;
        return {
            configured_mode: cfg.configured_mode,
            mode: 'jsonl',
            signals,
            outcomes,
            cfg: effectiveCfg,
            getHealth: () => ({
                provider: 'JSONL',
                mode: 'jsonl',
                configured_mode: cfg.configured_mode,
                effective_mode: 'jsonl',
                primary_repository: 'JSONL',
                firebase_status: getFirebaseStatus(),
                firestore_initialized: isFirebaseAdminReady(),
                firestore_connected: false,
                connected: true,
                durable: true,
                queue_depth: 0,
                queue_pressure: 'NORMAL',
                max_queue_depth: 0,
                write_latency: emptyLatency(),
                last_write_latency_ms: null,
                last_signal_write_at: null,
                last_outcome_write_at: null,
                write_success_count: 0,
                write_failure_count: 0,
                conflict_count: 0,
                last_error: cfg.env_conflict
                    ? cfg.env_conflict_message
                    : missingFirebaseCredentialNames().length &&
                        cfg.configured_mode !== 'jsonl'
                      ? `missing credentials: ${missingFirebaseCredentialNames().join(', ')}`
                      : null,
                hydrate_status,
                last_hydrate_at,
                env_conflict: cfg.env_conflict,
                status:
                    cfg.env_conflict || cfg.configured_mode !== 'jsonl'
                        ? 'DEGRADED'
                        : 'HEALTHY',
                mutates_strategy: false,
                creates_upstream_subscription: false,
            }),
            hydrate: async () => {
                hydrate_status = 'RUNNING';
                try {
                    signals.hydrateKnownIds();
                    hydrate_status = 'PASS';
                    last_hydrate_at = new Date().toISOString();
                } catch {
                    hydrate_status = 'FAIL';
                }
            },
            flush: async () => undefined,
        };
    }

    if (effectiveCfg.mode === 'firestore') {
        const signals = new FirestoreStrategySignalRepository(
            undefined,
            effectiveCfg,
        );
        const outcomes = new FirestoreSignalOutcomeRepository(
            undefined,
            effectiveCfg,
        );
        const project = getFirebaseProjectIdSafe();
        if (project) {
            console.log(
                `[research-persistence] Firestore project_id=${project} (value not a secret)`,
            );
        }
        return {
            configured_mode: cfg.configured_mode,
            mode: 'firestore',
            signals,
            outcomes,
            cfg: effectiveCfg,
            getHealth: () => signals.getHealth(),
            hydrate: async () => {
                // Connectivity probe first — CONNECTED only after live op
                await verifyFirestoreConnectivity();
                await signals.hydrateAsync(effectiveCfg.hydrate_lookback_days);
            },
            flush: async () => {
                await signals.flush();
                await outcomes.flush();
            },
        };
    }

    // dual
    const jsonlSignals = new JsonlStrategySignalRepository();
    const jsonlOutcomes = new JsonlSignalOutcomeRepository();
    const fsSignals = new FirestoreStrategySignalRepository(
        undefined,
        effectiveCfg,
    );
    const fsOutcomes = new FirestoreSignalOutcomeRepository(
        undefined,
        effectiveCfg,
    );
    const signals = new DualStrategySignalRepository(jsonlSignals, fsSignals);
    const outcomes = new DualSignalOutcomeRepository(jsonlOutcomes, fsOutcomes);
    const project = getFirebaseProjectIdSafe();
    if (project) {
        console.log(
            `[research-persistence] dual mode Firestore project_id=${project}`,
        );
    }
    return {
        configured_mode: cfg.configured_mode,
        mode: 'dual',
        signals,
        outcomes,
        cfg: effectiveCfg,
        getHealth: () => {
            const fh = signals.getHealth();
            return {
                ...fh,
                provider: 'DUAL',
                configured_mode: cfg.configured_mode,
                effective_mode: 'dual',
                mode: 'dual',
                primary_repository: 'DUAL',
            };
        },
        hydrate: async () => {
            await verifyFirestoreConnectivity();
            signals.hydrateKnownIds();
            await fsSignals.hydrateAsync(effectiveCfg.hydrate_lookback_days);
        },
        flush: async () => {
            await signals.flush();
            await outcomes.flush();
        },
    };
}
