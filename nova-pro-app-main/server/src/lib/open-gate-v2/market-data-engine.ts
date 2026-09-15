// server/src/lib/open-gate-v2/market-data-engine.ts
// Snapshot = init / gap-fill. Stream updates state only.
// VWAP priority: tick.avg_price → snapshot.average_price → amount/volume → stream fallback.

import type { MarketManager } from '../../providers/manager.ts';
import type { Snapshot, SseBidAsk, SseTick } from '../../types/dto.ts';
import type {
    SymbolMarketState,
    VwapConfidence,
    VwapSource,
} from './types.ts';

function n(v: unknown): number {
    const x = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(x) ? x : 0;
}

function emptyState(symbol: string): SymbolMarketState {
    return {
        symbol,
        timestamp: Date.now(),
        last_price: 0,
        open: 0,
        high: 0,
        low: 0,
        prev_close: 0,
        total_volume: 0,
        total_amount: 0,
        turnover: 0,
        avg_price: 0,
        best_bid: 0,
        best_ask: 0,
        bid_volume: 0,
        ask_volume: 0,
        tick_count: 0,
        last_tick_at: null,
        last_bidask_at: null,
        vwap_num: 0,
        vwap_den: 0,
        vwap_source: 'fallback',
        vwap_valid: false,
        vwap_available: false,
        vwap_confidence: 'none',
        recent_prices: [],
    };
}

function resolveVwap(st: SymbolMarketState): {
    vwap: number | null;
    source: VwapSource;
    valid: boolean;
    available: boolean;
    confidence: VwapConfidence;
} {
    if (st.vwap_source === 'approx_1m' && st.avg_price > 0) {
        return {
            vwap: st.avg_price,
            source: 'approx_1m',
            valid: false,
            available: true,
            confidence: 'degraded',
        };
    }
    // 1) official avg_price from tick/snapshot
    if (st.avg_price > 0) {
        const src: VwapSource =
            st.vwap_source === 'tick' ||
            st.vwap_source === 'snapshot' ||
            st.vwap_source === 'calculated'
                ? st.vwap_source
                : 'tick';
        return {
            vwap: st.avg_price,
            source: src,
            valid: true,
            available: true,
            confidence: 'high',
        };
    }
    // 2) cumulative amount / volume
    if (st.total_amount > 0 && st.total_volume > 0) {
        return {
            vwap: st.total_amount / st.total_volume,
            source: 'calculated',
            valid: true,
            available: true,
            confidence: 'high',
        };
    }
    // 3) stream local accumulator — fallback only
    if (st.vwap_den > 0) {
        return {
            vwap: st.vwap_num / st.vwap_den,
            source: 'fallback',
            valid: false,
            available: true,
            confidence: 'degraded',
        };
    }
    return {
        vwap: null,
        source: 'fallback',
        valid: false,
        available: false,
        confidence: 'none',
    };
}

export class MarketDataEngine {
    private states = new Map<string, SymbolMarketState>();
    private stockWatch = new Set<string>();
    private indexWatch = new Set<string>();
    private streamOk = false;
    private lastAnyTickAt: number | null = null;
    private lastAnyBidAskAt: number | null = null;
    private lastStreamErrorAt: number | null = null;
    private hooked = false;

    constructor(private market: MarketManager) {}

    attach(): void {
        if (this.hooked) return;
        this.hooked = true;
        this.market.onTick((_ch, tick) => this.onTick(tick));
        this.market.onBidAsk((_ch, ba) => this.onBidAsk(ba));
        this.streamOk = true;
    }

    getState(symbol: string): SymbolMarketState | undefined {
        return this.states.get(symbol);
    }

    watchedSymbols(): string[] {
        return [...this.stockWatch];
    }

    streamConnected(): boolean {
        // recently marked error without recovery → not connected
        if (
            this.lastStreamErrorAt != null &&
            Date.now() - this.lastStreamErrorAt < 15_000 &&
            !this.streamOk
        ) {
            return false;
        }
        return this.streamOk;
    }

    lastTickAt(): number | null {
        return this.lastAnyTickAt;
    }

    lastBidAskAt(): number | null {
        return this.lastAnyBidAskAt;
    }

    markStreamError(): void {
        this.lastStreamErrorAt = Date.now();
        this.streamOk = false;
    }

    markStreamOk(): void {
        this.streamOk = true;
        this.lastStreamErrorAt = null;
    }

    /** Stocks: Tick + BidAsk */
    async subscribeStock(symbols: string[]): Promise<void> {
        this.attach();
        const needSnap: string[] = [];
        for (const raw of symbols) {
            const symbol = raw.trim();
            if (!symbol) continue;
            if (!this.stockWatch.has(symbol)) {
                this.stockWatch.add(symbol);
                needSnap.push(symbol);
                const key = {
                    code: symbol,
                    security_type: 'STK' as const,
                    exchange: null,
                };
                try {
                    await this.market.subscribe(key, 'Tick');
                    await this.market.subscribe(key, 'BidAsk');
                    this.markStreamOk();
                } catch {
                    this.markStreamError();
                }
            }
            if (!this.states.has(symbol)) needSnap.push(symbol);
        }
        const unique = [...new Set(needSnap)];
        if (unique.length) await this.bootstrapFromSnapshots(unique);
    }

    /** Called only when SubscriptionManager ref_count hits 0. */
    async unsubscribeStock(symbols: string[]): Promise<void> {
        for (const raw of symbols) {
            const symbol = raw.trim();
            if (!symbol || !this.stockWatch.has(symbol)) continue;
            this.stockWatch.delete(symbol);
            const key = {
                code: symbol,
                security_type: 'STK' as const,
                exchange: null,
            };
            try {
                await this.market.unsubscribe(key, 'Tick');
                await this.market.unsubscribe(key, 'BidAsk');
            } catch {
                // best-effort
            }
            // Keep last state in memory for display; do not delete states
        }
    }

    /**
     * Indices: prefer Quote-like path.
     * Current providers map Quote→Tick; we only subscribe Tick once (no BidAsk).
     */
    async subscribeIndex(symbols: string[]): Promise<void> {
        this.attach();
        for (const raw of symbols) {
            const symbol = raw.trim();
            if (!symbol || this.indexWatch.has(symbol)) continue;
            this.indexWatch.add(symbol);
            try {
                await this.market.subscribe(
                    {
                        code: symbol,
                        security_type: 'IND' as const,
                        exchange: null,
                    },
                    'Tick',
                );
                this.markStreamOk();
            } catch {
                // IND may not resolve on all providers — soft fail
                try {
                    await this.market.subscribe(
                        {
                            code: symbol,
                            security_type: 'STK' as const,
                            exchange: null,
                        },
                        'Tick',
                    );
                } catch {
                    this.markStreamError();
                }
            }
        }
    }

    /** @deprecated use subscribeStock */
    async ensureWatching(symbols: string[]): Promise<void> {
        await this.subscribeStock(symbols);
    }

    async bootstrapFromSnapshots(symbols: string[]): Promise<void> {
        if (!symbols.length) return;
        try {
            const snaps = await this.market.snapshots(
                symbols.map((code) => ({
                    code,
                    security_type: 'STK' as const,
                    exchange: null,
                })),
            );
            for (const s of snaps) this.applySnapshot(s);
            this.markStreamOk();
        } catch {
            this.markStreamError();
        }
    }

    async refreshSnapshots(symbols?: string[]): Promise<void> {
        const list = symbols?.length ? symbols : [...this.stockWatch];
        await this.bootstrapFromSnapshots(list);
    }

    applySnapshot(s: Snapshot): void {
        const symbol = s.code;
        const prev = this.states.get(symbol) ?? emptyState(symbol);
        const last = n(s.close);
        const open = n(s.open) || prev.open;
        const high = Math.max(n(s.high), prev.high, last);
        const low =
            n(s.low) > 0
                ? prev.low > 0
                    ? Math.min(n(s.low), prev.low)
                    : n(s.low)
                : prev.low;
        const totalVol = Math.max(n(s.total_volume), prev.total_volume);
        const totalAmt = Math.max(n(s.total_amount), prev.total_amount);
        const avg = n(s.average_price);

        let prevClose = prev.prev_close;
        if (n(s.change_price) && last) {
            const inferred = last - n(s.change_price);
            if (inferred > 0) prevClose = inferred;
        }
        if (!prevClose && last && n(s.change_rate)) {
            const rate = n(s.change_rate) / 100;
            if (rate !== -1) prevClose = last / (1 + rate);
        }

        // Prefer snapshot avg_price for bootstrap; don't overwrite tick avg
        let avg_price = prev.avg_price;
        let vwap_source = prev.vwap_source;
        if (avg > 0 && (prev.vwap_source !== 'tick' || prev.avg_price <= 0)) {
            avg_price = avg;
            vwap_source = 'snapshot';
        }

        const next: SymbolMarketState = {
            ...prev,
            symbol,
            timestamp: Date.now(),
            last_price: last || prev.last_price,
            open,
            high,
            low,
            prev_close: prevClose,
            total_volume: totalVol,
            total_amount: totalAmt,
            turnover: totalAmt,
            avg_price,
            best_bid: n(s.buy_price) || prev.best_bid,
            best_ask: n(s.sell_price) || prev.best_ask,
            bid_volume: n(s.buy_volume) || prev.bid_volume,
            ask_volume: n(s.sell_volume) || prev.ask_volume,
            vwap_source,
            vwap_valid: false,
        };
        const resolved = resolveVwap(next);
        next.vwap_source = resolved.source;
        next.vwap_valid = resolved.valid;
        next.vwap_available = resolved.available;
        next.vwap_confidence = resolved.confidence;
        if (resolved.vwap != null && next.avg_price <= 0) {
            next.avg_price = resolved.vwap;
        }
        this.states.set(symbol, next);
    }

    private onTick(tick: SseTick): void {
        if (tick.simtrade) return;
        const symbol = tick.code;
        if (!this.stockWatch.has(symbol) && !this.indexWatch.has(symbol)) {
            return;
        }

        const st = this.states.get(symbol) ?? emptyState(symbol);
        const price = n(tick.close);
        const vol = n(tick.volume);
        const totalVol = Math.max(n(tick.total_volume), st.total_volume);
        const totalAmt = Math.max(n(tick.total_amount), st.total_amount);
        const now = Date.now();

        // stream accumulator = consistency only
        let vwapNum = st.vwap_num;
        let vwapDen = st.vwap_den;
        if (price > 0 && vol > 0) {
            vwapNum += price * vol;
            vwapDen += vol;
        }

        const tickAvg = n(tick.avg_price);
        let avg_price = st.avg_price;
        let vwap_source = st.vwap_source;
        if (tickAvg > 0) {
            avg_price = tickAvg;
            vwap_source = 'tick';
        }

        const open = st.open || n(tick.open) || price;
        const high = Math.max(st.high, n(tick.high), price);
        const low =
            st.low > 0
                ? Math.min(st.low, n(tick.low) || price, price)
                : n(tick.low) || price;

        const recent = [...st.recent_prices, { t: now, p: price, v: vol }];
        const cutoff = now - 180_000;
        const trimmed = recent.filter((r) => r.t >= cutoff).slice(-120);

        const next: SymbolMarketState = {
            ...st,
            timestamp: now,
            last_price: price || st.last_price,
            open,
            high,
            low,
            total_volume: totalVol,
            total_amount: totalAmt,
            turnover: totalAmt,
            avg_price,
            tick_count: st.tick_count + 1,
            last_tick_at: now,
            vwap_num: vwapNum,
            vwap_den: vwapDen,
            vwap_source,
            vwap_valid: false,
            recent_prices: trimmed,
        };
        const resolved = resolveVwap(next);
        next.vwap_source = resolved.source;
        next.vwap_valid = resolved.valid;
        next.vwap_available = resolved.available;
        next.vwap_confidence = resolved.confidence;
        this.states.set(symbol, next);
        this.lastAnyTickAt = now;
        this.markStreamOk();
    }

    private onBidAsk(ba: SseBidAsk): void {
        if (ba.simtrade) return;
        const symbol = ba.code;
        if (!this.stockWatch.has(symbol)) return;
        const st = this.states.get(symbol) ?? emptyState(symbol);
        const bid = n(ba.bid_price?.[0]);
        const ask = n(ba.ask_price?.[0]);
        const now = Date.now();
        this.states.set(symbol, {
            ...st,
            timestamp: now,
            best_bid: bid || st.best_bid,
            best_ask: ask || st.best_ask,
            bid_volume: n(ba.bid_volume?.[0]) || st.bid_volume,
            ask_volume: n(ba.ask_volume?.[0]) || st.ask_volume,
            last_bidask_at: now,
        });
        this.lastAnyBidAskAt = now;
        this.markStreamOk();
    }

    vwap(symbol: string): {
        vwap: number | null;
        source: VwapSource;
        valid: boolean;
        available: boolean;
        confidence: VwapConfidence;
    } {
        const st = this.states.get(symbol);
        if (!st) {
            return {
                vwap: null,
                source: 'fallback',
                valid: false,
                available: false,
                confidence: 'none',
            };
        }
        return resolveVwap(st);
    }

    /**
     * Replay v1: apply one completed 1m bar at known_at.
     * Does NOT invent intrabar ticks. OHLC path unknown → use close as last.
     */
    applyCompletedBar(bar: {
        symbol: string;
        /** Use known_at (when bar is knowable). */
        timestamp: number;
        known_at?: number;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        amount: number;
        amount_available: boolean;
        is_index?: boolean;
    }): void {
        const symbol = bar.symbol;
        const at = bar.known_at ?? bar.timestamp;
        const st = this.states.get(symbol) ?? emptyState(symbol);
        const open = st.open > 0 ? st.open : bar.open;
        const high = Math.max(st.high, bar.high, bar.close);
        const low =
            st.low > 0
                ? Math.min(st.low, bar.low || bar.close)
                : bar.low || bar.close;
        const totalVol = st.total_volume + Math.max(0, bar.volume);
        let totalAmt = st.total_amount;
        let avg_price = st.avg_price;
        let vwap_source = st.vwap_source;
        let vwap_num = st.vwap_num;
        let vwap_den = st.vwap_den;

        if (bar.amount_available && bar.amount > 0) {
            totalAmt += bar.amount;
            if (totalVol > 0) {
                avg_price = totalAmt / totalVol;
                vwap_source = 'calculated';
            }
        } else if (bar.volume > 0) {
            const typical = (bar.high + bar.low + bar.close) / 3;
            vwap_num += typical * bar.volume;
            vwap_den += bar.volume;
            if (vwap_den > 0) {
                avg_price = vwap_num / vwap_den;
                vwap_source = 'approx_1m';
            }
            totalAmt += typical * bar.volume;
        }

        const recent = [
            ...st.recent_prices,
            { t: at, p: bar.close, v: bar.volume },
        ];
        const cutoff = at - 180_000;
        const trimmed = recent.filter((r) => r.t >= cutoff).slice(-120);

        if (!bar.is_index) {
            this.stockWatch.add(symbol);
        } else {
            this.indexWatch.add(symbol);
        }

        const next: SymbolMarketState = {
            ...st,
            symbol,
            timestamp: at,
            last_price: bar.close || st.last_price,
            open,
            high,
            low,
            total_volume: totalVol,
            total_amount: totalAmt,
            turnover: totalAmt,
            avg_price,
            tick_count: st.tick_count + (bar.volume > 0 ? 1 : 0),
            last_tick_at: at,
            vwap_num,
            vwap_den,
            vwap_source,
            vwap_valid: false,
            recent_prices: trimmed,
            best_bid: 0,
            best_ask: 0,
        };
        if (vwap_source === 'approx_1m' && avg_price > 0) {
            next.vwap_source = 'approx_1m';
            next.vwap_valid = false;
            next.vwap_available = true;
            next.vwap_confidence = 'degraded';
            next.avg_price = avg_price;
        } else {
            const resolved = resolveVwap(next);
            next.vwap_source = resolved.source;
            next.vwap_valid = resolved.valid;
            next.vwap_available = resolved.available;
            next.vwap_confidence = resolved.confidence;
        }
        this.states.set(symbol, next);
        this.lastAnyTickAt = at;
        this.streamOk = true;
    }

    /** Replay / tests: seed prev_close without live snapshot. */
    seedPrevClose(symbol: string, prevClose: number): void {
        const st = this.states.get(symbol) ?? emptyState(symbol);
        this.states.set(symbol, { ...st, symbol, prev_close: prevClose });
    }

    clearStates(): void {
        this.states.clear();
        this.stockWatch.clear();
        this.indexWatch.clear();
    }
}
