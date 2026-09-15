// server/src/lib/market-runtime/service.ts
// Shared market runtime — owns engine/health/profiles/regime.
// Depends on MarketSource + Clock — NOT OpenGate/IntradayRank services.
// UI SSE must NOT acquire through SubscriptionManager.

import type { MarketManager } from '../../providers/manager.ts';
import { loadOpenGateConfig } from '../open-gate-v2/config.ts';
import {
    DataHealthService,
    type DataHealthReport,
} from '../open-gate-v2/data-health.ts';
import { HistoricalProfileCache } from '../open-gate-v2/historical-intraday-profile.ts';
import { MarketDataEngine } from '../open-gate-v2/market-data-engine.ts';
import {
    MarketRegimeService,
    type MarketRegimeResult,
} from '../open-gate-v2/market-regime.ts';
import type { SymbolMarketState, VwapSource } from '../open-gate-v2/types.ts';
import { type Clock, SystemClock } from './clock.ts';
import { LiveMarketSource } from './live-market-source.ts';
import type { MarketSource } from './market-source.ts';
import { SubscriptionManager } from './subscription-manager.ts';
import type {
    DataResolution,
    MarketSourceInfo,
    SourceMode,
    SubscriptionConsumer,
} from './types.ts';

export interface MarketRuntimeOptions {
    market: MarketManager;
    clock?: Clock;
    source?: MarketSource;
    /** When true, skip attaching live tick stream (replay uses applyCompletedBar). */
    replayMode?: boolean;
}

export class MarketRuntime {
    readonly engine: MarketDataEngine;
    readonly health: DataHealthService;
    readonly profiles: HistoricalProfileCache;
    readonly regime: MarketRegimeService;
    readonly subscriptions: SubscriptionManager;
    readonly clock: Clock;
    readonly source: MarketSource;
    private desired = new Map<SubscriptionConsumer, Set<string>>();
    private sourceMode: SourceMode;
    private dataResolution: DataResolution;
    private started = false;
    private replayMode: boolean;
    private unsubSource: (() => void) | null = null;
    /** Point-in-time exclusive YMD for profile preload (replay day). */
    private profileAsOfExclusive: string | null = null;

    constructor(opts: MarketRuntimeOptions | MarketManager) {
        const market = 'market' in opts ? opts.market : opts;
        const clock =
            'market' in opts && opts.clock ? opts.clock : new SystemClock();
        const replayMode =
            'market' in opts ? Boolean(opts.replayMode) : false;
        const source =
            'market' in opts && opts.source
                ? opts.source
                : new LiveMarketSource(market, clock);

        this.clock = clock;
        this.source = source;
        this.replayMode = replayMode;
        this.sourceMode = source.mode;
        this.dataResolution = source.dataResolution;

        const gateCfg = loadOpenGateConfig();
        this.engine = new MarketDataEngine(market);
        this.health = new DataHealthService(
            this.engine,
            gateCfg,
            market.name(),
        );
        this.profiles = new HistoricalProfileCache(market, gateCfg);
        this.regime = new MarketRegimeService(gateCfg);
        this.subscriptions = new SubscriptionManager();
    }

    now(): Date {
        return this.clock.now();
    }

    sourceInfo(): MarketSourceInfo {
        return {
            source_mode: this.sourceMode,
            data_resolution: this.dataResolution,
        };
    }

    setSourceMode(mode: SourceMode, resolution: DataResolution): void {
        this.sourceMode = mode;
        this.dataResolution = resolution;
    }

    setProfileAsOfExclusive(ymd: string | null): void {
        this.profileAsOfExclusive = ymd;
    }

    setProviderName(name: string): void {
        this.health.setProviderName(name);
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        void this.source.start();
        this.health.setProviderName(
            this.replayMode ? 'replay' : this.source.mode,
        );

        if (!this.replayMode) {
            this.engine.attach();
            void this.source.subscribeIndexes(['IX0001', 'IX0043']);
            void this.engine.subscribeIndex(['IX0001', 'IX0043']);
        } else {
            // Replay: apply BarEvents into engine state store
            this.unsubSource = this.source.onMarketEvent((ev) => {
                if (ev.type === 'bar') {
                    this.engine.applyCompletedBar({
                        symbol: ev.symbol,
                        timestamp: ev.known_at,
                        known_at: ev.known_at,
                        open: ev.open,
                        high: ev.high,
                        low: ev.low,
                        close: ev.close,
                        volume: ev.volume,
                        amount: ev.amount,
                        amount_available: ev.amount_available,
                        is_index: ev.is_index,
                    });
                }
            });
        }

        console.log(
            `market-runtime: ${this.sourceMode}/${this.dataResolution}` +
                ` — UI SSE is separate`,
        );
    }

    async bootstrap(): Promise<void> {
        this.start();
    }

    stop(): void {
        this.started = false;
        if (this.unsubSource) {
            this.unsubSource();
            this.unsubSource = null;
        }
        void this.source.stop();
    }

    getState(symbol: string): SymbolMarketState | undefined {
        return this.engine.getState(symbol);
    }

    vwap(symbol: string): {
        vwap: number | null;
        source: VwapSource;
        valid: boolean;
        available: boolean;
        confidence: import('../open-gate-v2/types.ts').VwapConfidence;
    } {
        return this.engine.vwap(symbol);
    }

    healthReport(symbol?: string): DataHealthReport {
        this.health.setHistoricalProfileAvailable(this.profiles.isReady());
        return this.health.report(symbol, this.now().getTime());
    }

    profilesReady(): boolean {
        return this.profiles.isReady();
    }

    profilesError(): string | null {
        return this.profiles.lastErrorMessage();
    }

    async preloadProfiles(symbols: string[]): Promise<void> {
        await this.profiles.preload(symbols, {
            asOfExclusiveYmd: this.profileAsOfExclusive ?? undefined,
        });
        this.health.setHistoricalProfileAvailable(this.profiles.isReady());
    }

    rvolSameTime(
        symbol: string,
        totalVolume: number,
        sessionMinutes: number,
    ): number | null {
        return this.profiles.rvolSameTime(symbol, totalVolume, sessionMinutes);
    }

    async evaluateRegime(
        breadthPct: number | null = null,
    ): Promise<MarketRegimeResult> {
        if (this.replayMode) {
            // Prefer offline if index states present
            const taiex = this.engine.getState('IX0001');
            const tpex = this.engine.getState('IX0043');
            const chg = (st: SymbolMarketState | undefined) => {
                if (!st || st.prev_close <= 0 || st.last_price <= 0)
                    return null;
                return ((st.last_price - st.prev_close) / st.prev_close) * 100;
            };
            return this.regime.evaluateOffline({
                taiexChangePct: chg(taiex),
                tpexChangePct: chg(tpex),
                breadthPct,
                nowMs: this.now().getTime(),
            });
        }
        return this.regime.evaluate(breadthPct);
    }

    async acquireStocks(
        symbols: string[],
        consumer: SubscriptionConsumer,
    ): Promise<void> {
        this.start();
        await this.subscriptions.acquireMany(
            symbols,
            consumer,
            async (syms) => {
                await this.source.subscribeStocks(syms);
                if (!this.replayMode) {
                    await this.engine.subscribeStock(syms);
                }
            },
        );
        const set = this.desired.get(consumer) ?? new Set<string>();
        for (const s of symbols.map((x) => x.trim()).filter(Boolean)) {
            set.add(s);
        }
        this.desired.set(consumer, set);
    }

    async releaseStocks(
        symbols: string[],
        consumer: SubscriptionConsumer,
    ): Promise<void> {
        await this.subscriptions.releaseMany(
            symbols,
            consumer,
            async (syms) => {
                await this.source.unsubscribeStocks(syms);
                if (!this.replayMode) {
                    await this.engine.unsubscribeStock(syms);
                }
            },
        );
        const set = this.desired.get(consumer);
        if (set) {
            for (const s of symbols.map((x) => x.trim()).filter(Boolean)) {
                set.delete(s);
            }
        }
    }

    async syncStocks(
        nextSymbols: string[],
        consumer: SubscriptionConsumer,
    ): Promise<void> {
        const next = [
            ...new Set(nextSymbols.map((s) => s.trim()).filter(Boolean)),
        ];
        const prev = [...(this.desired.get(consumer) ?? [])];
        const nextSet = new Set(next);
        const toRelease = prev.filter((s) => !nextSet.has(s));
        if (toRelease.length) {
            await this.releaseStocks(toRelease, consumer);
        }
        if (next.length) {
            await this.acquireStocks(next, consumer);
        } else {
            this.desired.set(consumer, new Set());
        }
    }

    providerName(): string {
        return this.source.mode;
    }
}
