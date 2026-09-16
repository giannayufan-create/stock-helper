// server/src/lib/buy-pressure/buy-pressure-service.ts
// Context only — NEVER mutates A/B/C / Heat / Rank / Events.
// NEVER creates Shioaji upstream subscriptions.

import type {
    CandidateSource,
    DiscoveryItem,
    IntradayRankItem,
} from '../intraday-rank/types.ts';
import type { IntradayRankService } from '../intraday-rank/service.ts';
import type { MarketRuntime } from '../market-runtime/index.ts';
import type { WebNotificationService } from '../web-notifications/index.ts';
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
    type BreakoutReference,
} from './detectors.ts';
import {
    DEFAULT_SLOPE_WINDOW_MS,
    FeatureHistoryStore,
    slopesFromHistory,
} from './feature-history.ts';
import {
    applyPriceFilter,
    computeBpChaseRisk,
    computeRadarRankScore,
    isOverheatedStrong,
    sortBuyPressureItems,
    type BpSortMode,
} from './ranking.ts';
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
    BuyPressureTag,
    BpInternalEvent,
    DiscoveryReason,
    UniverseSource,
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

function mapSource(src: CandidateSource | string | undefined): UniverseSource {
    switch (src) {
        case 'A':
            return 'A_POOL';
        case 'B_PASS':
            return 'B_PASS';
        case 'B_WATCH':
            return 'B_WATCH';
        case 'SCANNER_VOLUME':
            return 'SCANNER_VOLUME';
        case 'SCANNER_CHANGE':
            return 'SCANNER_CHANGE';
        case 'SCANNER_AMOUNT':
            return 'SCANNER_AMOUNT';
        case 'SCANNER_TICK':
            return 'SCANNER_TICK';
        case 'SCANNER_DAYRANGE':
            return 'SCANNER_DAYRANGE';
        default:
            return 'UNKNOWN';
    }
}

function pickUniverseSource(
    sources: CandidateSource[] | undefined,
    inCTop: boolean,
): { universe_source: UniverseSource; discovery_reason: DiscoveryReason | null } {
    if (inCTop) {
        return { universe_source: 'C_TOP_RANK', discovery_reason: null };
    }
    const order: CandidateSource[] = [
        'SCANNER_VOLUME',
        'SCANNER_AMOUNT',
        'SCANNER_CHANGE',
        'SCANNER_TICK',
        'SCANNER_DAYRANGE',
        'B_PASS',
        'B_WATCH',
        'A',
    ];
    for (const s of order) {
        if (sources?.includes(s)) {
            const u = mapSource(s);
            return { universe_source: u, discovery_reason: u };
        }
    }
    return { universe_source: 'C_DISCOVERY', discovery_reason: 'C_DISCOVERY' };
}

interface OpeningRange {
    high: number;
    high_at: number;
}

export class BuyPressureService {
    readonly cfg: BuyPressureConfig;
    private timer: ReturnType<typeof setInterval> | null = null;
    private lastBatch: BuyPressureBatch | null = null;
    private lastEvaluateAt: string | null = null;
    private bidAskHistory = new Map<string, BidAskSnap[]>();
    private eventLog = new Map<string, BuyPressureEvent[]>();
    private notifyCooldown = new Map<string, number>();
    private featureHistory = new FeatureHistoryStore();
    private notifications: WebNotificationService | null = null;
    /** Session opening-range high (first 15m) per symbol. */
    private openingRange = new Map<string, OpeningRange>();
    /** Last confirmed breakout level for PREVIOUS_BREAKOUT_LEVEL. */
    private prevBreakout = new Map<
        string,
        { level: number; at: number }
    >();
    private peakOrderbookDepth = 0;

    constructor(
        private intradayRank: IntradayRankService,
        private runtime: MarketRuntime,
        cfg?: BuyPressureConfig,
    ) {
        this.cfg = cfg ?? loadBuyPressureConfig();
    }

    setNotificationSink(svc: WebNotificationService | null): void {
        this.notifications = svc;
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

    getHealth(): BuyPressureHealth & {
        orderbook_depth_available_peak: number;
        max_active_observation: number;
        upstream_subscription_count: number;
        creates_upstream_subscription: false;
    } {
        const stale = this.lastBatch?.data_stale_global ?? false;
        const snap = this.runtime.subscriptions.snapshot();
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
            note: 'Buy Pressure reads MarketRuntime + IntradayRank Discovery only; no new upstream subscriptions.',
            creates_upstream_subscription: false,
            mutates_strategy: false,
            orderbook_depth_available_peak: this.peakOrderbookDepth,
            max_active_observation: this.cfg.max_active_observation,
            upstream_subscription_count: Object.keys(snap).length,
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
        return this.buildItem(ranked, true);
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

    /**
     * Broad Discovery → Candidate Pool → active observation (already subscribed)
     * → BuyPressureEngine. Never acquire new Shioaji upstream.
     */
    evaluate(): BuyPressureBatch {
        const batch = this.intradayRank.getLastBatch();
        const discovery = this.intradayRank.getDiscoveryPool();
        const warnings: string[] = [];
        if (!batch) warnings.push('intraday_rank_empty');

        const cItems = batch?.items ?? [];
        const cSet = new Set(cItems.map((i) => i.symbol));
        const candidates: Array<{
            row: IntradayRankItem;
            inCTop: boolean;
        }> = [];

        for (const row of cItems) {
            candidates.push({ row, inCTop: true });
        }

        // Discovery symbols not yet in C Top Rank — only if already observed
        for (const d of discovery) {
            if (cSet.has(d.symbol)) continue;
            if (!this.runtime.getState(d.symbol)) continue;
            candidates.push({
                row: this.syntheticRankFromDiscovery(d),
                inCTop: false,
            });
        }

        const maxObs = Math.max(10, this.cfg.max_active_observation);
        const limited = candidates.slice(0, maxObs);
        if (candidates.length > maxObs) {
            warnings.push(
                `active_observation_capped:${maxObs}/${candidates.length}`,
            );
        }

        const items: BuyPressureItem[] = [];
        let staleGlobal = false;
        for (const { row, inCTop } of limited) {
            this.captureBidAsk(row.symbol);
            this.trackOpeningRange(row.symbol);
            const item = this.buildItem(row, inCTop);
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
        this.notifications?.ingestFromBuyPressure(items);
        return out;
    }

    __setBidAskHistory(symbol: string, snaps: BidAskSnap[]): void {
        this.bidAskHistory.set(symbol, snaps);
    }

    private syntheticRankFromDiscovery(d: DiscoveryItem): IntradayRankItem {
        const st = this.runtime.getState(d.symbol);
        const nowIso = new Date().toISOString();
        return {
            symbol: d.symbol,
            name: d.name || d.symbol,
            candidate_origin: d.candidate_origin,
            candidate_sources: d.candidate_sources,
            a_score: d.a_score,
            open_score: d.open_score,
            open_gate_status: d.open_gate_status,
            rank: 999,
            rank_prev: null,
            rank_change: null,
            rank_1m_ago: null,
            rank_5m_ago: null,
            rank_velocity: null,
            last_price: st?.last_price ?? null,
            change_pct: d.change_pct,
            intraday_score: Math.min(100, d.discovery_score),
            raw_intraday_score: d.discovery_score,
            heat_score: 0,
            state: 'EMERGING',
            metrics: {
                return_30s: null,
                return_1m: null,
                return_3m: null,
                return_5m: null,
                momentum_acceleration: 0,
                volume_acceleration: null,
                volume_1m: null,
                volume_3m: null,
                vwap: null,
                vwap_pos_pct: null,
                vwap_structure_score: null,
                relative_strength_score: null,
                breakout_score: null,
                breakout_type: 'none',
                trade_aggression_score: null,
                trade_aggression_available: false,
                pullback_quality_score: null,
                pullback_state: 'none',
                spread_pct: null,
                liquidity_score: null,
            },
            risk: {
                chase_risk: 'low',
                invalid_price: null,
                invalid_reason: null,
            },
            events: [],
            reasons: [`discovery:${d.candidate_sources.join(',')}`],
            risks: [],
            data_health: st ? 'healthy' : 'partial',
            data_blocked: false,
            notification_candidate: false,
            confirmation_count: 0,
            signal_id: null,
            evaluation_id: `bp_disc_${d.symbol}`,
            updated_at: nowIso,
        };
    }

    private trackOpeningRange(symbol: string): void {
        const st = this.runtime.getState(symbol);
        if (!st || st.high <= 0) return;
        const now = this.runtime.now();
        // Taiwan session open 09:00 — opening range = first 15 minutes
        const hh = now.getHours();
        const mm = now.getMinutes();
        const inOr = hh === 9 && mm < 15;
        const existing = this.openingRange.get(symbol);
        if (inOr) {
            if (!existing || st.high > existing.high) {
                this.openingRange.set(symbol, {
                    high: st.high,
                    high_at: now.getTime(),
                });
            }
        } else if (!existing && st.open > 0) {
            // After OR window: seed once from current high if never tracked
            this.openingRange.set(symbol, {
                high: Math.max(st.open, st.high),
                high_at: st.last_tick_at ?? now.getTime(),
            });
        }
    }

    private breakoutRefs(symbol: string): BreakoutReference[] {
        const refs: BreakoutReference[] = [];
        const or = this.openingRange.get(symbol);
        if (or && or.high > 0) {
            refs.push({
                breakout_type: 'OPENING_RANGE_HIGH',
                reference_level: or.high,
                reference_time: new Date(or.high_at).toISOString(),
            });
        }
        const st = this.runtime.getState(symbol);
        if (st && st.high > 0) {
            refs.push({
                breakout_type: 'LOCAL_HIGH',
                reference_level: st.high,
                reference_time:
                    st.last_tick_at != null
                        ? new Date(st.last_tick_at).toISOString()
                        : null,
            });
        }
        const prev = this.prevBreakout.get(symbol);
        if (prev && prev.level > 0) {
            refs.push({
                breakout_type: 'PREVIOUS_BREAKOUT_LEVEL',
                reference_level: prev.level,
                reference_time: new Date(prev.at).toISOString(),
            });
        }
        return refs;
    }

    private captureBidAsk(symbol: string): void {
        const st = this.runtime.getState(symbol);
        if (!st) return;
        const hist = this.bidAskHistory.get(symbol) ?? [];
        const prev = hist[hist.length - 1];
        let askExecuted = 0;
        if (prev && st.best_ask > 0) {
            const volDelta = Math.max(0, st.total_volume - prev.total_volume);
            if (
                st.last_price > 0 &&
                Math.abs(st.last_price - st.best_ask) / st.best_ask < 0.003
            ) {
                askExecuted = volDelta;
            } else if (prev.best_ask === st.best_ask && volDelta > 0) {
                const atAsk = (st.recent_prices ?? [])
                    .filter(
                        (p) =>
                            Math.abs(p.p - st.best_ask) / st.best_ask < 0.003 &&
                            p.t >= prev.t,
                    )
                    .reduce((a, p) => a + (p.v ?? 0), 0);
                askExecuted = atAsk > 0 ? atAsk : 0;
            }
        }
        const bidLevels =
            st.bid_levels && st.bid_levels.length
                ? [...st.bid_levels]
                : st.best_bid > 0
                  ? [st.best_bid]
                  : [];
        const askLevels =
            st.ask_levels && st.ask_levels.length
                ? [...st.ask_levels]
                : st.best_ask > 0
                  ? [st.best_ask]
                  : [];
        const bidQty =
            st.bid_qty_levels && st.bid_qty_levels.length
                ? [...st.bid_qty_levels]
                : st.bid_volume > 0
                  ? [st.bid_volume]
                  : [];
        const askQty =
            st.ask_qty_levels && st.ask_qty_levels.length
                ? [...st.ask_qty_levels]
                : st.ask_volume > 0
                  ? [st.ask_volume]
                  : [];
        const depth =
            st.orderbook_depth && st.orderbook_depth > 0
                ? st.orderbook_depth
                : Math.max(bidLevels.length, askLevels.length);
        if (depth > this.peakOrderbookDepth) this.peakOrderbookDepth = depth;

        const snap: BidAskSnap = {
            t: this.runtime.now().getTime(),
            best_ask: st.best_ask || 0,
            ask_volume: st.ask_volume || 0,
            best_bid: st.best_bid || 0,
            bid_volume: st.bid_volume || 0,
            last_price: st.last_price || 0,
            total_volume: st.total_volume || 0,
            ask_executed_delta: askExecuted,
            bid_levels: bidLevels,
            ask_levels: askLevels,
            bid_qty: bidQty,
            ask_qty: askQty,
            orderbook_depth_available: depth,
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
        // Profile unavailable → available=false (never coerce missing to 0)

        const bid = st?.bid_volume ?? 0;
        const ask = st?.ask_volume ?? 0;
        const imb = bid + ask > 0 ? (bid - ask) / (bid + ask) : null;

        const vwapStructure =
            dist == null
                ? feat(null)
                : feat(Math.max(0, Math.min(100, 50 + dist * 15)));

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
            rank: row.rank < 900 ? row.rank : null,
            rank_prev: row.rank_prev,
            high: st?.high && st.high > 0 ? st.high : null,
            data_stale: stale,
            data_health: health,
        };
    }

    private buildItem(row: IntradayRankItem, inCTop: boolean): BuyPressureItem {
        const features = this.buildFeatures(row);
        const scored = computeBuyPressureScore(features, this.cfg);
        const nowMs = this.runtime.now().getTime();
        const windowMs = this.cfg.slope_window_ms || DEFAULT_SLOPE_WINDOW_MS;
        const featHist = this.featureHistory.push(row.symbol, {
            t: nowMs,
            rvol: features.rvol.value,
            volume_acceleration: features.volume_acceleration.value,
            trade_aggression: features.trade_aggression.value,
            rank_velocity: features.rank_velocity.value,
            momentum_acceleration: features.momentum_acceleration.value,
            bidask_imbalance: features.bidask_imbalance.value,
            distance_from_vwap_pct: features.distance_from_vwap_pct,
            rank: features.rank,
        });
        const slopes = slopesFromHistory(featHist, windowMs, nowMs);

        const hist = this.bidAskHistory.get(row.symbol) ?? [];
        const ask = detectAskConsumption(hist, this.cfg);
        const large = detectLargeBid(hist, this.cfg);
        const overheated = detectOverheated(features, this.cfg);
        const early = detectEarly(features, this.cfg, slopes);
        let buySurge = detectBuySurge(
            features,
            scored.buy_pressure_score,
            this.cfg,
        );
        if (
            buySurge &&
            slopes.volume_accel_label === 'DECELERATING' &&
            slopes.rvol_accel === 'DECELERATING'
        ) {
            buySurge = false;
        }
        const refs = this.breakoutRefs(row.symbol);
        const volBreak = detectVolumeBreakout(features, this.cfg, refs);
        if (volBreak.hit && volBreak.reference_level != null) {
            this.prevBreakout.set(row.symbol, {
                level: volBreak.reference_level,
                at: nowMs,
            });
        }
        const cooling = detectCooling(features, this.cfg);

        const { primary, states } = resolveStates({
            early,
            buySurge,
            askEating: ask.eating,
            volumeBreakout: volBreak.hit,
            largeBid: large.hit,
            overheated,
            cooling,
            dataStale: features.data_stale,
            staleBlock: this.cfg.stale_block_states,
        });

        const tags: BuyPressureTag[] = [];
        if (large.hit) tags.push('LARGE_BID');
        if (overheated) tags.push('OVERHEATED');

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

        const st = this.runtime.getState(row.symbol);
        const lastTickAt = st?.last_tick_at ?? null;
        const lastBaAt = st?.last_bidask_at ?? null;
        const ageMs =
            lastTickAt != null ? Math.max(0, nowMs - lastTickAt) : null;
        const freshness =
            features.data_stale || (ageMs != null && ageMs > 120_000)
                ? 'STALE'
                : ageMs != null && ageMs > 30_000
                  ? 'AGING'
                  : 'FRESH';

        // Lower confidence when RVOL profile missing
        let coverage = scored.coverage_pct;
        if (!features.rvol.available) {
            coverage = Math.min(coverage, scored.coverage_pct);
        }
        const conf: 'high' | 'medium' | 'low' =
            coverage >= 80 && features.rvol.available
                ? 'high'
                : coverage >= 50
                  ? 'medium'
                  : 'low';

        const { universe_source, discovery_reason } = pickUniverseSource(
            row.candidate_sources,
            inCTop,
        );

        const nowIso = new Date().toISOString();
        const newEvents: BuyPressureEvent[] = [];
        const pushEv = (
            type: BpInternalEvent,
            note: string | null,
            notify: boolean,
            reasons: string[],
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
                reasons,
                cycle_fresh: true,
            };
            if (notify && cooled) this.notifyCooldown.set(key, now);
            newEvents.push(ev);
        };

        const baseReasons: string[] = [];
        if (features.volume_acceleration.value != null) {
            baseReasons.push(
                `3分鐘量能 ${features.volume_acceleration.value > 0 ? '+' : ''}${Math.round(features.volume_acceleration.value)}%`,
            );
        }
        if (features.rank != null && features.rank_prev != null) {
            baseReasons.push(`Rank ${features.rank_prev} → ${features.rank}`);
        }
        if (features.rvol.available && features.rvol.value != null) {
            baseReasons.push(`RVOL ${features.rvol.value.toFixed(1)}x`);
        }
        if (features.distance_from_vwap_pct != null) {
            baseReasons.push(
                `VWAP ${features.distance_from_vwap_pct > 0 ? '+' : ''}${features.distance_from_vwap_pct.toFixed(1)}%`,
            );
        }

        if (early)
            pushEv('EARLY_ENTER', '開始轉強', true, [
                ...baseReasons,
                '尚未要求 C STRONG',
            ].slice(0, 4));
        if (buySurge && !features.data_stale)
            pushEv('BUY_SURGE', '買盤加速', true, [
                ...baseReasons,
                '主動買盤持續增強',
            ].slice(0, 4));
        if (ask.eating && !features.data_stale)
            pushEv(
                'ASK_EATING',
                ask.note,
                true,
                [...baseReasons, ask.note ?? '正在吃賣單']
                    .filter(Boolean)
                    .slice(0, 4) as string[],
            );
        if (ask.cancel)
            pushEv('ASK_CANCEL', ask.note, false, [
                ask.note ?? 'ASK_CANCEL',
            ]);
        if (volBreak.hit && !features.data_stale)
            pushEv(
                'VOLUME_BREAKOUT',
                `放量突破 ${volBreak.breakout_type ?? ''}`.trim(),
                true,
                baseReasons.slice(0, 4),
            );
        if (large.hit)
            pushEv('LARGE_BID_APPEAR', large.note, false, [
                large.note ?? '大額委買出現',
            ]);
        if (overheated)
            pushEv('OVERHEATED', '買盤強，短線延伸較大', false, [
                '買盤強，短線延伸較大',
                `Chase Risk ${bpChase}`,
            ]);
        if (
            features.rank_velocity.available &&
            (features.rank_velocity.value ?? 0) >= 10
        ) {
            pushEv(
                'RANK_ACCELERATION',
                '排名加速前進',
                true,
                baseReasons.slice(0, 4),
            );
        }

        const prevLog = (this.eventLog.get(row.symbol) ?? []).map((e) => ({
            ...e,
            cycle_fresh: false,
        }));
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
            tags,
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
            overheated_note: overheated ? '買盤強，短線延伸較大' : null,
            ask_eating_note: ask.eating ? ask.note : null,
            large_bid_note: large.hit ? large.note : null,
            data_stale: features.data_stale,
            data_health: features.data_health,
            updated_at: nowIso,
            last_updated: row.updated_at || nowIso,
            evaluated_at: nowIso,
            last_tick_at:
                lastTickAt != null ? new Date(lastTickAt).toISOString() : null,
            last_bidask_at:
                lastBaAt != null ? new Date(lastBaAt).toISOString() : null,
            data_age_ms: ageMs,
            freshness,
            rvol_slope: slopes.rvol_slope,
            volume_acceleration_slope: slopes.volume_acceleration_slope,
            rvol_accel: slopes.rvol_accel,
            volume_accel_label: slopes.volume_accel_label,
            events: merged,
            notification_candidates: newEvents.filter(
                (e) => e.notification_candidate,
            ),
            feature_availability: {
                ...scored.feature_availability,
                rvol: features.rvol.available,
            },
            score_coverage_pct: coverage,
            score_confidence: conf,
            universe_source,
            discovery_reason,
            orderbook_depth_available: ask.orderbook_depth_available,
            ask_eating_confidence: ask.ask_eating_confidence,
            breakout_type: volBreak.hit ? volBreak.breakout_type : null,
            reference_level: volBreak.hit ? volBreak.reference_level : null,
            reference_time: volBreak.hit ? volBreak.reference_time : null,
            slope_window_ms: slopes.window_ms,
            slope_sample_count: slopes.sample_count,
        };
    }
}
