// server/src/lib/strategy-signal/bridge.ts
// Shared wiring for Live + Replay — B/C call this after each evaluate.

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenConfirmResult } from '../open-gate-v2/types.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';
import type { MarketRuntime } from '../market-runtime/service.ts';
import { StrategySignalFactory, configHashOf } from './factory.ts';
import { SignalLifecycleManager } from './lifecycle.ts';
import {
    JsonlStrategySignalRepository,
    type StrategySignalRepository,
} from './repository.ts';
import type { StrategySignal } from './types.ts';

export interface BridgeContext {
    source_mode: 'live' | 'replay';
    data_resolution: 'tick' | '1m';
    universe_source?: string;
    learning_eligible?: boolean;
    config_hash?: string;
}

function defaultSignalsRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', 'data', 'signals');
}

export class StrategySignalBridge {
    readonly life = new SignalLifecycleManager();
    readonly repo: StrategySignalRepository;
    readonly factory: StrategySignalFactory;
    readonly created: StrategySignal[] = [];
    private ctx: BridgeContext = {
        source_mode: 'live',
        data_resolution: 'tick',
        universe_source: 'live_scanner',
        learning_eligible: true,
    };

    constructor(repo?: StrategySignalRepository) {
        this.repo = repo ?? new JsonlStrategySignalRepository();
        this.factory = new StrategySignalFactory(this.repo, this.life);

        // Restart hydrate: known signal ids + lifecycle.json
        if (typeof this.repo.hydrateKnownIds === 'function') {
            this.repo.hydrateKnownIds();
        }
        const signalsRoot =
            this.repo instanceof JsonlStrategySignalRepository
                ? this.repo.rootDir()
                : defaultSignalsRoot();
        this.life.hydrateFromDisk(join(signalsRoot, 'lifecycle.json'));
    }

    setContext(ctx: Partial<BridgeContext>): void {
        this.ctx = { ...this.ctx, ...ctx };
    }

    onBResult(
        prev: OpenConfirmResult | null,
        next: OpenConfirmResult,
        runtime: MarketRuntime,
        configHash: string,
    ): StrategySignal | null {
        const st = runtime.getState(next.symbol);
        const ref =
            st?.last_price && st.last_price > 0
                ? st.last_price
                : 0;
        const sig = this.factory.maybeCreateFromB(
            prev,
            next,
            {
                source_mode: this.ctx.source_mode,
                data_resolution: this.ctx.data_resolution,
                universe_source: this.ctx.universe_source,
                learning_eligible: this.ctx.learning_eligible !== false,
                config_hash: configHash,
            },
            ref,
        );
        if (sig) this.created.push(sig);
        return sig;
    }

    onCResult(
        prev: IntradayRankItem | null,
        next: IntradayRankItem,
        runtime: MarketRuntime,
        configHash: string,
        eventCooldowns: Record<string, number>,
    ): StrategySignal[] {
        const st = runtime.getState(next.symbol);
        const ref =
            st?.last_price && st.last_price > 0
                ? st.last_price
                : 0;
        const sigs = this.factory.maybeCreateFromC(
            prev,
            next,
            {
                source_mode: this.ctx.source_mode,
                data_resolution: this.ctx.data_resolution,
                universe_source: this.ctx.universe_source,
                learning_eligible: this.ctx.learning_eligible !== false,
                config_hash: configHash,
            },
            ref,
            eventCooldowns,
        );
        this.created.push(...sigs);
        return sigs;
    }

    resetCreated(): void {
        this.created.length = 0;
        this.life.clear();
    }
}

export function hashConfig(obj: unknown): string {
    return configHashOf(obj);
}

export function sha12(s: string): string {
    return createHash('sha256').update(s).digest('hex').slice(0, 12);
}
