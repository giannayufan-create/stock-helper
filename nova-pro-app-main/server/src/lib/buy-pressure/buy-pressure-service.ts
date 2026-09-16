// server/src/lib/buy-pressure/buy-pressure-service.ts
// Context only — NEVER mutates A/B/C / Heat / Rank / Events.
// NEVER creates Shioaji upstream subscriptions.

import type { IntradayRankItem } from '../intraday-rank/types.ts';
import type { IntradayRankService } from '../intraday-rank/service.ts';
import type { MarketRuntime } from '../market-runtime/index.ts';
import {
    loadBuyPressureConfig,
    type BuyPressureConfig,
} from './config.ts';
import {
    detectAskConsumption,
    detectBuySurge,
    detectCooling,
    detectEarly,
    detectLargeBid,
    detectOverheated,
    detectVolumeBreakout,
    resolveStates,
    vwapBucket,
} from './detectors.ts';
import { applyPriceFilter, computeBpChaseRisk, computeRadarRankScore, isOverheatedStrong, sortBuyPressureItems, type BpSortMode } from './ranking.ts';
import { computeBuyPressureScore } from './score-engine.ts';
import type {
    BidAskSnap,
    BuyPressureBatch,
    BuyPressureEvent,
    BuyPressureFeatures,
    BuyPressureHealth,
    BuyPressureItem,
    BuyPressureMarket,
    BuyPressureQuery,
    BuyPressureState,
    BpInternalEvent,
} from './types.ts';
import { BP_VERSION } from './types.ts';

function feat(
    value: number | null | undefined,
    available?: boolean,
): { value: number | null; available: boolean } {
    if (available === false) return { value: null, available: false };
    if (value == null || !Number.isFinite(value)) {
        return { value: null, available: false };
    }
    return { value, available: true };
}

function isStaleHealth(h: string | undefined): boolean {
    const x = (h ?? '').toLowerCase();
    return (
        x.includes('stale') ||
        x.includes('disconnect') ||
        x.includes('blocked') ||
        x === 'unhealthy'
    );
}

export class BuyPressureService {
    readonly cfg: BuyPressureConfig;
    private timer: ReturnType<typeof setInterval> | null = null;
    private lastBatch: BuyPressureBatch | null = null;
    private lastEvaluateAt: string | null = null;
    private bidAskHistory = new Map<string, BidAskSnap[]>();
    private eventLog = new Map<string, BuyPressureEvent[]>();
    private notifyCooldown = new Map<string, number>();

    constructor(
        private intradayRank: IntradayRankService,
        private runtime: MarketRuntime,
        cfg?: BuyPressureConfig,
    ) {
        this.cfg = cfg ?? loadBuyPressureConfig();
    }

    start(): void {
        if (!this.cfg.enabled || this.timer) return;
        this.evaluate();
        this.timer = setInterval(
            () => this.evaluate(),
            Math.max(1, this.cfg.evaluate_interval_sec) * 1000,
        );
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    getHealth(): BuyPressureHealth {
        const stale = this.lastBatch?.data_stale_global ?? false;
        return {
            enabled: this.cfg.enabled,
            status: !this.cfg.enabled
                ? 'UNAVAILABLE'
                : stale
                  ? 'STALE'
                  : this.lastBatch
                    ? 'HEALTHY'
                    : 'PARTIAL',
            version: BP_VERSION,
            last_evaluate_at: this.lastEvaluateAt,
            item_count: this.lastBatch?.count ?? 0,
            note: 'Buy Pressure reads MarketRuntime + IntradayRank only; no new upstream subscriptions.',
            creates_upstream_subscription: false,
            mutates_strategy: false,
        };
    }

    getLastBatch(): BuyPressureBatch | null {
        return this.lastBatch;
    }

    getSymbol(symbol: string): BuyPressureItem | null {
        const code = symbol.trim();
        const fromBatch = this.lastBatch?.items.find((i) => i.symbol === code);
        if (fromBatch) return fromBatch;
        const ranked = this.intradayRank.getSymbol(code);
        if (!ranked) return null;
        return this.buildItem(ranked);
    }

    list(query: BuyPressureQuery = {}): BuyPressureBatch {
        const base = this.lastBatch ?? {
            as_of: new Date().toISOString(),
            version: BP_VERSION,
            count: 0,
            items: [],
            evaluate_interval_sec: this.cfg.evaluate_interval_sec,
            default_price_filter: 'ALL' as const,
            warnings: ['not_evaluated_yet'],
            data_stale_global: false,
        };

        let items = [...base.items];

        // Price filter — display only; scores already computed without it.
        if (query.min_price != null || query.max_price != null) {
            items = applyPriceFilter(items, query.min_price, query.max_price);
        }
        if (query.min_score != null) {
            items = items.filter(
                (i) => i.buy_pressure_score >= query.min_score!,
            );
        }
        if (query.state && query.state !== 'ALL') {
            if (query.state === 'OVERHEATED_STRONG') {
                items = items.filter((i) => isOverheatedStrong(i));
            } else {
                items = items.filter(
                    (i) =>
                        i.primary_state === query.state ||
                        i.states.includes(query.state as BuyPressureState),
                );
            }
        }
        if (query.market && query.market !== 'ALL') {
            if (query.market === 'ESM') {
                items = [];
            } else {
                items = items.filter(
                    (i) =>
                        i.market === query.market ||
                        i.market === 'UNKNOWN',
                );
            }
        }
        // 「僅未過熱」— user opt-in only; default includes OVERHEATED
        if (query.overheated === false) {
            items = items.filter((i) => !i.overheated);
        } else if (query.overheated === true) {
            items = items.filter((i) => i.overheated);
        }

        const sortMode = (query.sort ?? 'strongest') as BpSortMode;
        items = sortBuyPressureItems(items, sortMode);
        const limit =
            query.limit != null && Number.isFinite(query.limit)
                ? Math.max(1, Math.min(200, query.limit))
                : 50;
        items = items.slice(0, limit);

        return {
            ...base,
            count: items.length,
            items,
            default_price_filter: 'ALL',
        };
    }

    /** Evaluate cycle — read-only against runtime + C batch. */
    evaluate(): BuyPressureBatch {
        const batch = this.intradayRank.getLastBatch();
        const warnings: string[] = [];
        if (!batch) {
            warnings.push('intraday_rank_empty');
        }
        const items: BuyPressureItem[] = [];
        let staleGlobal = false;

        for (const row of batch?.items ?? []) {
            this.captureBidAsk(row.symbol);
            const item = this.buildItem(row);
            if (item.data_stale) staleGlobal = true;
            items.push(item);
        }

        items.sort(
            (a, b) =>
                b.buy_pressure_score - a.buy_pressure_score ||
                b.radar_rank_score - a.radar_rank_score,
        );
        const out: BuyPressureBatch = {
            as_of: new Date().toISOString(),
            version: BP_VERSION,
            count: items.length,
            items,
            evaluate_interval_sec: this.cfg.evaluate_interval_sec,
            default_price_filter: 'ALL',
            warnings,
            data_stale_global: staleGlobal,
        };
        this.lastBatch = out;
        this.lastEvaluateAt = out.as_of;
        return out;
    }

    /** Test hook: inject bid/ask history without live market. */
    __setBidAskHistory(symbol: string, snaps: BidAskSnap[]): void {
        this.bidAskHistory.set(symbol, snaps);
    }

    private captureBidAsk(symbol: string): void {
        const st = this.runtime.getState(symbol);
        if (!st) return;
        const hist = this.bidAskHistory.get(symbol) ?? [];
        const prev = hist[hist.length - 1];
        let askExecuted = 0;
        if (prev && st.best_ask > 0) {
            const volDelta = Math.max(0, st.total_volume - prev.total_volume);
            // If last trade near ask, attribute volume to ask consumption.
            if (
                st.last_price > 0 &&
                Math.abs(st.last_price - st.best_ask) / st.best_ask < 0.003
            ) {
                askExecuted = volDelta;
            } else if (prev.best_ask === st.best_ask && volDelta > 0) {
                // Split unknown — use recent_prices at ask
                const atAsk = (st.recent_prices ?? [])
                    .filter(
                        (p) =>
                            Math.abs(p.p - st.best_ask) / st.best_ask < 0.003 &&
                            (!prev || p.t >= prev.t),
                    )
                    .reduce((a, p) => a + (p.v ?? 0), 0);
                askExecuted = atAsk > 0 ? atAsk : 0;
            }
        }
        const snap: BidAskSnap = {
            t: this.runtime.now().getTime(),
            best_ask: st.best_ask || 0,
            ask_volume: st.ask_volume || 0,
            best_bid: st.best_bid || 0,
            bid_volume: st.bid_volume || 0,
            last_price: st.last_price || 0,
            total_volume: st.total_volume || 0,
            ask_executed_delta: askExecuted,
        };
        const next = [...hist, snap].slice(-this.cfg.bidask_history_len);
        this.bidAskHistory.set(symbol, next);
    }

    private buildFeatures(row: IntradayRankItem): BuyPressureFeatures {
        const st = this.runtime.getState(row.symbol);
        const health = row.data_health || 'unknown';
        const runtimeHealth = this.runtime.healthReport(row.symbol);
        const stale =
            row.data_blocked ||
            isStaleHealth(health) ||
            isStaleHealth(runtimeHealth.health) ||
            runtimeHealth.health === 'stale';

        const dist = row.metrics.vwap_pos_pct;
        const bucket = vwapBucket(dist, this.cfg.near_vwap_pct);

        let rvol: number | null = null;
        let rvolAvail = false;
        if (st && st.total_volume > 0) {
            const sessionMin = Math.max(
                1,
                Math.floor(
                    (this.runtime.now().getTime() -
                        (st.last_tick_at ?? this.runtime.now().getTime())) /
                        60000,
                ) || 60,
            );
            // Prefer same-time RVOL from runtime when profiles exist.
            const rv = this.runtime.rvolSameTime(
                row.symbol,
                st.total_volume,
                Math.min(270, Math.max(5, sessionMin)),
            );
            if (rv != null && Number.isFinite(rv)) {
                rvol = rv;
                rvolAvail = true;
            }
        }

        const bid = st?.bid_volume ?? 0;
        const ask = st?.ask_volume ?? 0;
        const imb =
            bid + ask > 0 ? (bid - ask) / (bid + ask) : null;

        const vwapStructure =
            dist == null
                ? feat(null)
                : feat(
                      // Above VWAP positive structure 50..100
                      Math.max(
                          0,
                          Math.min(100, 50 + dist * 15),
                      ),
                  );

        // Rank velocity: prefer engine field; else rank improve positive
        let rankVel = row.rank_velocity;
        if (rankVel == null && row.rank != null && row.rank_prev != null) {
            rankVel = row.rank_prev - row.rank;
        }

        return {
            volume_acceleration: feat(row.metrics.volume_acceleration),
            trade_aggression: feat(
                row.metrics.trade_aggression_score,
                row.metrics.trade_aggression_available,
            ),
            rvol: feat(rvol, rvolAvail),
            rank_velocity: feat(rankVel),
            momentum_acceleration: feat(row.metrics.momentum_acceleration),
            vwap_structure: vwapStructure,
            bidask_imbalance: feat(imb, st != null && bid + ask > 0),
            distance_from_vwap_pct: dist,
            vwap_bucket: bucket,
            change_pct: row.change_pct,
            heat_score: row.heat_score,
            c_score: row.intraday_score,
            chase_risk: row.risk?.chase_risk ?? null,
            last_price: row.last_price ?? st?.last_price ?? null,
            rank: row.rank,
            rank_prev: row.rank_prev,
            high: st?.high && st.high > 0 ? st.high : null,
            data_stale: stale,
            data_health: health,
        };
    }

    private buildItem(row: IntradayRankItem): BuyPressureItem {
        const features = this.buildFeatures(row);
        const scored = computeBuyPressureScore(features, this.cfg);
        const hist = this.bidAskHistory.get(row.symbol) ?? [];
        const ask = detectAskConsumption(hist, this.cfg);
        const large = detectLargeBid(hist, this.cfg);
        const overheated = detectOverheated(features, this.cfg);
        const early = detectEarly(features, this.cfg);
        const buySurge = detectBuySurge(
            features,
            scored.buy_pressure_score,
            this.cfg,
        );
        const volBreak = detectVolumeBreakout(features, this.cfg);
        const cooling = detectCooling(features, this.cfg);

        const { primary, states } = resolveStates({
            early,
            buySurge,
            askEating: ask.eating,
            volumeBreakout: volBreak,
            largeBid: large.hit,
            overheated,
            cooling,
            dataStale: features.data_stale,
            staleBlock: this.cfg.stale_block_states,
        });

        const bpChase = computeBpChaseRisk(features);
        const rankOut = computeRadarRankScore({
            buy_pressure_score: scored.buy_pressure_score,
            states,
            rank_velocity: features.rank_velocity.value,
            volume_acceleration: features.volume_acceleration.value,
            trade_aggression: features.trade_aggression.value,
            cfg: this.cfg,
            heat_score: features.heat_score,
            chase_risk: bpChase,
        });

        const nowIso = new Date().toISOString();
        const newEvents: BuyPressureEvent[] = [];
        const pushEv = (
            type: BpInternalEvent,
            note: string | null,
            notify: boolean,
        ) => {
            if (features.data_stale && this.cfg.stale_block_states) {
                if (
                    type === 'BUY_SURGE' ||
                    type === 'ASK_EATING' ||
                    type === 'VOLUME_BREAKOUT'
                ) {
                    return;
                }
            }
            const key = `${row.symbol}:${type}`;
            const last = this.notifyCooldown.get(key) ?? 0;
            const now = Date.now();
            const cooled =
                now - last >= this.cfg.notification_cooldown_sec * 1000;
            const ev: BuyPressureEvent = {
                event_id: `${key}:${now}`,
                event_type: type,
                symbol: row.symbol,
                timestamp: nowIso,
                price: features.last_price,
                note,
                notification_candidate: notify && cooled,
            };
            if (notify && cooled) this.notifyCooldown.set(key, now);
            newEvents.push(ev);
        };

        if (early) pushEv('EARLY_ENTER', '開始轉強', true);
        if (buySurge && !features.data_stale)
            pushEv('BUY_SURGE', '買盤加速', true);
        if (ask.eating && !features.data_stale)
            pushEv('ASK_EATING', ask.note, true);
        if (ask.cancel) pushEv('ASK_CANCEL', ask.note, false);
        if (volBreak && !features.data_stale)
            pushEv('VOLUME_BREAKOUT', '放量突破', true);
        if (large.hit) pushEv('LARGE_BID_APPEAR', large.note, false);
        if (overheated)
            pushEv('OVERHEATED', '買盤強，但短線延伸較大', false);
        if (
            features.rank_velocity.available &&
            (features.rank_velocity.value ?? 0) >= 10
        ) {
            pushEv('RANK_ACCELERATION', '排名加速前進', true);
        }

        const prevLog = this.eventLog.get(row.symbol) ?? [];
        const merged = [...prevLog, ...newEvents].slice(-40);
        this.eventLog.set(row.symbol, merged);

        return {
            symbol: row.symbol,
            name: row.name,
            market: 'UNKNOWN' as BuyPressureMarket | 'UNKNOWN',
            last_price: features.last_price,
            change_pct: features.change_pct,
            buy_pressure_score: scored.buy_pressure_score,
            radar_rank_score: rankOut.radar_rank_score,
            primary_state: primary,
            states,
            c_score: features.c_score,
            heat_score: features.heat_score,
            rank: features.rank,
            rank_prev: features.rank_prev,
            rank_velocity: features.rank_velocity.value,
            volume_acceleration: features.volume_acceleration.value,
            rvol: features.rvol.value,
            trade_aggression: features.trade_aggression.value,
            bidask_imbalance: features.bidask_imbalance.value,
            momentum_acceleration: features.momentum_acceleration.value,
            vwap_bucket: features.vwap_bucket,
            distance_from_vwap_pct: features.distance_from_vwap_pct,
            chase_penalty: 0,
            chase_risk: bpChase,
            overheated,
            overheated_note: overheated
                ? '買盤強，但短線延伸較大'
                : null,
            ask_eating_note: ask.eating ? ask.note : null,
            large_bid_note: large.hit ? large.note : null,
            data_stale: features.data_stale,
            data_health: features.data_health,
            updated_at: nowIso,
            last_updated: row.updated_at || nowIso,
            events: merged,
            notification_candidates: merged.filter((e) => e.notification_candidate),
            feature_availability: scored.feature_availability,
            score_coverage_pct: scored.coverage_pct,
        };
    }
}
