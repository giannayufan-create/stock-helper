// server/src/lib/research-persistence/factory.ts

import { JsonlStrategySignalRepository } from '../strategy-signal/repository.ts';
import { JsonlSignalOutcomeRepository } from '../signal-outcome/repository.ts';
import type { StrategySignalRepository } from '../strategy-signal/repository.ts';
import type { SignalOutcomeRepository } from '../signal-outcome/repository.ts';
import {
    loadResearchPersistenceConfig,
    type ResearchPersistenceConfig,
} from './config.ts';
import { FirestoreStrategySignalRepository } from './firestore-signal-repository.ts';
import { FirestoreSignalOutcomeRepository } from './firestore-outcome-repository.ts';
import {
    DualSignalOutcomeRepository,
    DualStrategySignalRepository,
} from './dual-repository.ts';
import type { ResearchPersistenceHealth } from './types.ts';

export interface ResearchRepositories {
    mode: ResearchPersistenceConfig['mode'];
    signals: StrategySignalRepository;
    outcomes: SignalOutcomeRepository;
    getHealth(): ResearchPersistenceHealth;
    hydrate(): Promise<void>;
    flush(): Promise<void>;
}

export function createResearchRepositories(
    cfg: ResearchPersistenceConfig = loadResearchPersistenceConfig(),
): ResearchRepositories {
    if (cfg.mode === 'jsonl') {
        const signals = new JsonlStrategySignalRepository();
        const outcomes = new JsonlSignalOutcomeRepository();
        return {
            mode: 'jsonl',
            signals,
            outcomes,
            getHealth: () => ({
                provider: 'JSONL',
                mode: 'jsonl',
                connected: true,
                durable: true,
                queue_depth: 0,
                queue_pressure: 'NORMAL',
                last_signal_write_at: null,
                last_outcome_write_at: null,
                write_success_count: 0,
                write_failure_count: 0,
                conflict_count: 0,
                last_error: null,
                mutates_strategy: false,
                creates_upstream_subscription: false,
            }),
            hydrate: async () => {
                signals.hydrateKnownIds();
            },
            flush: async () => undefined,
        };
    }

    if (cfg.mode === 'firestore') {
        const signals = new FirestoreStrategySignalRepository(undefined, cfg);
        const outcomes = new FirestoreSignalOutcomeRepository(undefined, cfg);
        return {
            mode: 'firestore',
            signals,
            outcomes,
            getHealth: () => signals.getHealth(),
            hydrate: async () => {
                await signals.hydrateAsync(cfg.hydrate_lookback_days);
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
    const fsSignals = new FirestoreStrategySignalRepository(undefined, cfg);
    const fsOutcomes = new FirestoreSignalOutcomeRepository(undefined, cfg);
    const signals = new DualStrategySignalRepository(jsonlSignals, fsSignals);
    const outcomes = new DualSignalOutcomeRepository(jsonlOutcomes, fsOutcomes);
    return {
        mode: 'dual',
        signals,
        outcomes,
        getHealth: () => signals.getHealth(),
        hydrate: async () => {
            signals.hydrateKnownIds();
            await fsSignals.hydrateAsync(cfg.hydrate_lookback_days);
        },
        flush: async () => {
            await signals.flush();
            await outcomes.flush();
        },
    };
}
