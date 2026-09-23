// server/src/lib/radar-rescue/service.ts
// RADAR FULLSTACK RESCUE v3 orchestrator — Decision Support only.
// NEVER mutates production A / B / C / BP scores.

import type { BuyPressureService } from '../buy-pressure/index.ts';
import type { BuyPressureItem } from '../buy-pressure/types.ts';
import type { EventIntelligenceService } from '../event-intelligence/index.ts';
import type { IntradayRankService } from '../intraday-rank/service.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';
import type { MarketContextRuntime } from '../market-context/index.ts';
import type { OpenGateV2Service } from '../open-gate-v2/service.ts';
import { loadRadarRescueConfig, type RadarRescueConfig } from './config.ts';
import {
    attackStateLabel,
    buildAttackFeatures,
    resolveAttackState,
    type EarlyTrack,
} from './attack-state.ts';
import { EarlySignalStore } from './early-signal-store.ts';
import { evaluateEarlyTrigger } from './early-trigger.ts';
import { EodTruthService } from './eod-truth.ts';
import { FunnelTraceService } from './funnel-trace.ts';
import { buildMultiLaneCandidates } from './multi-lane.ts';
import { judgeNewsForSymbol } from './news-judge.ts';
import {
    computeChaseRisk,
    computeOpportunityScore,
} from './opportunity-chase.ts';
import { buildDailyRecall, persistRecall } from './recall.ts';
import { computeSuggestedBuy } from './suggested-buy.ts';
import { computeTriggerScore } from './trigger-score.ts';
import {
    RESCUE_VERSION,
    type DataConfidence,
    type DailyRecallReport,
    type EarlyEvidence,
    type NewsMarketState,
    type RescueBatch,
    type RescueCard,
    type RescueRadarState,
} from './types.ts';

function clamp(n: number, lo = 0, hi = 100): number {
    return Math.max(lo, Math.min(hi, n));
}

/** Taipei cash session 09:00–13:30 — used only for presentation state, not strategy. */
function isTaipeiCashSession(now = new Date()): boolean {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Taipei',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        weekday: 'short',
    }).formatToParts(now);
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
    if (wd === 'Sat' || wd === 'Sun') return false;
    const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const minutes = hh * 60 + mm;
    return minutes >= 9 * 60 && minutes < 13 * 60 + 30;
}

export class RadarRescueService {
    readonly cfg: RadarRescueConfig;
    private timer: ReturnType<typeof setInterval> | null = null;
    private last: RescueBatch | null = null;
    private bySymbol = new Map<string, RescueCard>();
    private funnel: FunnelTraceService;
    private eod: EodTruthService;
    private lastRecall: DailyRecallReport | null = null;
    private startedAt = Date.now();
    private prevBp = new Map<string, number>();
    private prevVwap = new Map<string, number>();
    private earlyTracks = new Map<string, EarlyTrack>();
    private earlySignals: EarlySignalStore;
    private transitionFlushAt = 0;

    constructor(
        private dataDir: string,
        private intradayRank: IntradayRankService,
        private buyPressure: BuyPressureService | null,
        private openGate: OpenGateV2Service | null,
        private marketContext: MarketContextRuntime | null,
        private eventIntelligence: EventIntelligenceService | null,
        cfg?: RadarRescueConfig,
    ) {
        this.cfg = cfg ?? loadRadarRescueConfig();
        this.funnel = new FunnelTraceService(dataDir);
        this.eod = new EodTruthService(dataDir);
        this.earlySignals = new EarlySignalStore(dataDir);
        this.funnel.loadToday();
        void this.openGate;
    }

    start(): void {
        if (!this.cfg.enabled) return;
        if (this.timer) return;
        void this.evaluate();
        this.timer = setInterval(() => {
            void this.evaluate();
        }, Math.max(3, this.cfg.evaluate_interval_sec) * 1000);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    getHealth() {
        return {
            enabled: this.cfg.enabled,
            status: this.cfg.enabled ? 'OK' : 'DISABLED',
            version: RESCUE_VERSION,
            mode: this.cfg.mode,
            count: this.bySymbol.size,
            as_of: this.last?.as_of ?? null,
            uptime_ms: Date.now() - this.startedAt,
            mutates_strategy: false as const,
            production_abc_bp_scores_changed: false as const,
        };
    }

    getLastBatch(): RescueBatch | null {
        return this.last;
    }

    getSymbol(symbol: string): RescueCard | null {
        return this.bySymbol.get(symbol) ?? null;
    }

    getFunnel() {
        return this.funnel.list();
    }

    getFunnelSymbol(symbol: string) {
        return this.funnel.get(symbol);
    }

    getRecall(): DailyRecallReport | null {
        return this.lastRecall;
    }

    getEodTruth() {
        return this.eod.getLast().length ? this.eod.getLast() : this.eod.load();
    }

    async runEodTruthAndRecall(symbols?: string[]): Promise<DailyRecallReport> {
        const pool =
            symbols ??
            [
                ...this.intradayRank.getDiscoveryPool().map((d) => d.symbol),
                ...(this.intradayRank.getLastBatch()?.items.map((i) => i.symbol) ??
                    []),
                ...this.funnel.list().map((f) => f.symbol),
            ];
        const truth = await this.eod.buildForSymbols(pool);
        const ymd =
            truth[0]?.trade_date ??
            new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Asia/Taipei',
            }).format(new Date());
        const report = buildDailyRecall(ymd, truth, this.funnel);
        persistRecall(this.dataDir, report);
        this.lastRecall = report;
        return report;
    }

    async evaluate(): Promise<RescueBatch | null> {
        if (!this.cfg.enabled) return null;
        const cBatch = this.intradayRank.getLastBatch();
        const discovery = this.intradayRank.getDiscoveryPool();
        const cItems = cBatch?.items ?? [];
        const cBy = new Map(cItems.map((i) => [i.symbol, i]));

        const bpBy = new Map<string, BuyPressureItem>();
        if (this.buyPressure) {
            try {
                const bpBatch = this.buyPressure.list({ limit: 150 });
                for (const it of bpBatch.items ?? []) bpBy.set(it.symbol, it);
            } catch {
                /* ignore */
            }
        }

        const sectorHot = new Set<string>();
        try {
            const sectors =
                (
                    this.marketContext as unknown as {
                        getSectors?: () => Array<Record<string, unknown>>;
                    }
                )?.getSectors?.() ?? [];
            for (const s of sectors) {
                const st = String(s.state ?? s.rotation_state ?? '');
                if (/ROTATING_IN|HOT|LEADING/i.test(st)) {
                    for (const sym of (s.symbols as string[]) ?? []) {
                        sectorHot.add(sym);
                    }
                }
            }
        } catch {
            /* ignore */
        }

        const newsSymbols = new Set<string>();
        try {
            for (const ev of this.eventIntelligence?.getActive() ?? []) {
                for (const c of ev.companies ?? []) newsSymbols.add(c);
            }
        } catch {
            /* ignore */
        }

        const { merged: laneMerged } = buildMultiLaneCandidates(this.cfg, {
            discovery,
            cItems,
            bpBySymbol: bpBy,
            sectorHotSymbols: sectorHot,
            newsSymbols,
        });
        const laneBy = new Map(laneMerged.map((l) => [l.symbol, l]));
        const cashSession = isTaipeiCashSession();

        // All discovery day-change movers — Rescue path that does NOT need C top-30.
        // board_mover_top_n <= 0 means no cap (comprehensive for scanned names).
        const boardMoverSorted = [...discovery]
            .filter(
                (d) =>
                    (d.change_pct ?? 0) >= this.cfg.board_mover_min_change_pct,
            )
            .sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0));
        const boardMoverPicked =
            this.cfg.board_mover_top_n > 0
                ? boardMoverSorted.slice(0, this.cfg.board_mover_top_n)
                : boardMoverSorted;
        const boardMovers = new Set(boardMoverPicked.map((d) => d.symbol));
        const uiGuaranteePct = this.cfg.board_mover_ui_guarantee_pct;

        const universe = new Map<string, { name: string }>();
        for (const d of discovery) universe.set(d.symbol, { name: d.name });
        for (const i of cItems) universe.set(i.symbol, { name: i.name });
        for (const l of laneMerged) universe.set(l.symbol, { name: l.name });
        for (const sym of boardMovers) {
            const d = discovery.find((x) => x.symbol === sym);
            if (d) universe.set(sym, { name: d.name });
        }

        const discRank = new Map(discovery.map((d, i) => [d.symbol, i + 1]));
        const cards: RescueCard[] = [];

        for (const [symbol, meta] of universe) {
            const c = cBy.get(symbol) ?? null;
            const bp = bpBy.get(symbol) ?? null;
            const disc = discovery.find((d) => d.symbol === symbol) ?? null;
            const lane = laneBy.get(symbol);

            const stale =
                c?.data_blocked === true ||
                c?.data_health === 'stale' ||
                c?.data_health === 'disconnected';
            const coverage =
                c?.score_coverage_pct ??
                (bp ? 70 : disc?.change_pct != null ? 55 : disc ? 40 : 20);
            const coreReady = Boolean(
                c?.last_price || bp?.last_price || disc?.change_pct != null,
            );
            let dataConfidence: DataConfidence =
                coverage >= 90 ? 'HIGH' : coverage >= 70 ? 'MEDIUM' : 'LOW';
            if (stale || coverage < this.cfg.coverage_not_ready_below) {
                dataConfidence = 'LOW';
            }

            const trigger = computeTriggerScore(this.cfg, {
                c,
                bp,
                disc,
                bpSlope: bp?.volume_acceleration_slope,
            });

            const prevBp = this.prevBp.get(symbol);
            const bpRising =
                bp != null &&
                prevBp != null &&
                bp.buy_pressure_score > prevBp + 3;
            if (bp) this.prevBp.set(symbol, bp.buy_pressure_score);

            const early = evaluateEarlyTrigger(this.cfg, {
                c,
                bp,
                dataConfidence,
                coreReady,
                // Round-2: stale always blocks live EARLY evidence path.
                stale: !!stale,
                bpRising,
                vwapReclaim:
                    (c?.metrics?.vwap_pos_pct ??
                        bp?.distance_from_vwap_pct ??
                        -1) >= 0 && (c?.change_pct ?? 0) < 1,
            });

            const news = judgeNewsForSymbol(
                this.cfg,
                this.eventIntelligence,
                symbol,
                { c, bp, sectorRising: sectorHot.has(symbol) },
            );

            const opportunity = computeOpportunityScore(this.cfg, {
                c,
                bp,
                sectorSupport: sectorHot.has(symbol),
                newsAdj: news.opportunityAdj,
            });

            const dayChg =
                c?.change_pct ?? bp?.change_pct ?? disc?.change_pct ?? null;
            const chase = computeChaseRisk(this.cfg, {
                changePct: dayChg,
                vwapExtPct:
                    c?.metrics?.vwap_pos_pct ?? bp?.distance_from_vwap_pct,
                moveCompletedPct:
                    dayChg != null
                        ? Math.min(1, Math.max(0, dayChg / 10))
                        : null,
            });

            const discChg = disc?.change_pct ?? 0;
            const boardMover = boardMovers.has(symbol);
            const discHot =
                boardMover ||
                (disc != null &&
                    discChg >= this.cfg.rescue_disc_active_min_change_pct &&
                    (trigger >= this.cfg.rescue_disc_active_min_trigger ||
                        (disc.discovery_score ?? 0) >=
                            this.cfg.rescue_disc_active_min_discovery ||
                        (disc.scanner_ranks?.change ?? 999) <= 50));

            const features = buildAttackFeatures({
                c,
                bp,
                trigger,
                changePct: dayChg,
                prevVwapPos: this.prevVwap.get(symbol) ?? null,
                bpRising,
                nowMs: Date.now(),
            });
            const prevTrack = this.earlyTracks.get(symbol) ?? null;
            // Also flag stale from C/BP health + age TTL inside features.
            const bpStale = bp?.data_stale === true;
            const attack = resolveAttackState(this.cfg, features, {
                symbol,
                cashSession,
                stale: !!stale || bpStale,
                dataBlocked: !!c?.data_blocked,
                prev: prevTrack,
                nowMs: Date.now(),
            });
            if (attack.track) {
                this.earlyTracks.set(symbol, attack.track);
            }
            const vwapNow = features.vwap_pos_pct;
            if (vwapNow != null && Number.isFinite(vwapNow)) {
                this.prevVwap.set(symbol, vwapNow);
            }

            // Preserve INVALID / PULLBACK overlays without mutating A/B/C.
            let radarState = attack.state;
            if (c?.state === 'INVALID') radarState = 'INVALID';
            else if (
                (c?.events?.includes('PULLBACK_READY') ||
                    c?.metrics?.pullback_state === 'holding' ||
                    c?.metrics?.pullback_state === 'reclaiming') &&
                (radarState === 'WATCH' || radarState === 'INACTIVE')
            ) {
                radarState = 'PULLBACK';
            }

            const prePlus3 = attack.pre_plus3;
            const stateLabel =
                attack.label || attackStateLabel(radarState);

            // History: record on fresh EARLY / PRE_ATTACK trigger timestamp
            if (
                (radarState === 'EARLY' || radarState === 'PRE_ATTACK') &&
                attack.track &&
                (!prevTrack ||
                    attack.track.triggered_at_ms !== prevTrack.triggered_at_ms)
            ) {
                this.earlySignals.recordTrigger({
                    symbol,
                    name: c?.name ?? bp?.name ?? meta.name,
                    timestamp: new Date(
                        attack.track.triggered_at_ms,
                    ).toISOString(),
                    trigger_price: attack.track.trigger_price,
                    change_pct: dayChg,
                    vwap_pos_pct: features.vwap_pos_pct,
                    volume_accel: features.volume_accel,
                    rank_velocity: features.rank_velocity,
                    bp_score: bp?.buy_pressure_score ?? null,
                    bp_slope: features.bp_slope,
                    ask_eating: attack.true_ask_eating,
                    buy_surge: features.buy_surge,
                    trigger_score: trigger,
                    state: radarState,
                });
            }
            this.earlySignals.sample(
                symbol,
                features.last_price,
                radarState,
            );

            const focusScore = this.computeFocusScore(
                radarState,
                opportunity,
                trigger,
                dataConfidence,
            );

            const reasons = [
                ...attack.reasons,
                ...this.buildReasons(early.evidence, c, bp, news.state),
            ].slice(0, 4);

            const suggested = computeSuggestedBuy({
                state: radarState,
                dataStale: attack.data_stale,
                lastPrice: features.last_price,
                vwap: c?.metrics?.vwap ?? null,
                breakoutPrice: attack.track?.breakout_price ?? null,
                triggerPrice: attack.track?.trigger_price ?? null,
                chaseRisk: chase,
            });

            const card: RescueCard = {
                symbol,
                name: c?.name ?? bp?.name ?? meta.name,
                last_price: c?.last_price ?? bp?.last_price ?? null,
                change_pct: dayChg,
                radar_state: radarState,
                opportunity_score: opportunity,
                chase_risk: chase,
                trigger_score: trigger,
                c_score: c?.intraday_score ?? null,
                bp_score: bp?.buy_pressure_score ?? null,
                rank: c?.rank ?? null,
                rank_prev: c?.rank_prev ?? null,
                rank_change:
                    c?.rank != null && c.rank_prev != null
                        ? c.rank_prev - c.rank
                        : null,
                bp_trend: bp?.volume_acceleration_slope ?? null,
                news_state: news.state,
                news_confidence: news.confidence,
                reasons,
                layers: {
                    stock:
                        early.early ||
                        prePlus3 ||
                        radarState === 'ACTIVE' ||
                        radarState === 'PRE_ATTACK' ||
                        radarState === 'EARLY' ||
                        (c?.intraday_score ?? 0) >= 60,
                    sector: sectorHot.has(symbol),
                    market: true,
                    news:
                        news.state === 'POSITIVE_CONFIRMED' ||
                        news.state === 'NEGATIVE_CONFIRMED',
                },
                early_evidence: early.evidence,
                data_confidence: dataConfidence,
                core_feature_ready: coreReady,
                coverage_score: coverage,
                focus_score:
                    focusScore +
                    (prePlus3 ? 12 : 0) +
                    (radarState === 'PRE_ATTACK' ? 8 : 0) +
                    (attack.true_ask_eating ? 5 : 0),
                lanes: lane?.lanes ?? [],
                late_detection: false,
                move_before_signal_pct: null,
                pre_plus3: prePlus3,
                state_label: stateLabel,
                true_ask_eating: attack.true_ask_eating,
                ask_eating_quality: attack.ask_eating_quality,
                push_efficiency: attack.push_efficiency,
                attack_score: attack.attack_score,
                data_stale: attack.data_stale,
                last_valid_state: attack.last_valid_state,
                suggested_buy_price: suggested?.price ?? null,
                suggested_buy_zone_low: suggested?.zone_low ?? null,
                suggested_buy_zone_high: suggested?.zone_high ?? null,
                suggested_buy_note: suggested?.note ?? null,
            };

            const chg = card.change_pct ?? 0;
            if (
                (radarState === 'EARLY' ||
                    radarState === 'PRE_ATTACK' ||
                    radarState === 'ACTIVE') &&
                chg >= 6.5
            ) {
                card.late_detection = true;
                card.move_before_signal_pct = chg;
            }

            cards.push(card);

            const inScanner = !!disc?.candidate_sources.some((s) =>
                s.startsWith('SCANNER_'),
            );
            const attackVisible =
                !attack.data_stale &&
                (radarState === 'EARLY' ||
                    radarState === 'PRE_ATTACK' ||
                    radarState === 'ACTIVE' ||
                    radarState === 'NEAR_LIMIT' ||
                    radarState === 'LIMIT_UP' ||
                    radarState === 'STALLING');
            this.funnel.upsert({
                symbol,
                name: card.name,
                in_a: !!disc?.candidate_sources.includes('A'),
                a_score: disc?.a_score ?? null,
                in_scanner: inScanner,
                scanner_sources: disc?.candidate_sources ?? [],
                in_discovery: !!disc,
                discovery_score: disc?.discovery_score ?? null,
                discovery_rank: discRank.get(symbol) ?? null,
                trigger_score: trigger,
                lanes: card.lanes,
                in_active_watch:
                    !!c || discHot || attackVisible || prePlus3,
                in_c: !!c,
                c_score: c?.intraday_score ?? null,
                c_rank: c?.rank ?? null,
                c_state: c?.state ?? null,
                bp_observed: !!bp,
                bp_score: bp?.buy_pressure_score ?? null,
                bp_state: bp?.primary_state ?? null,
                bp_trend: bp?.volume_acceleration_slope ?? null,
                radar_state: radarState,
                radar_confidence: dataConfidence,
                early_trigger:
                    early.early ||
                    attackVisible ||
                    discHot ||
                    prePlus3,
                opportunity_score: opportunity,
                chase_risk: chase,
                news_state: news.state,
                news_confidence: news.confidence,
                ui_visible:
                    attackVisible ||
                    radarState === 'PULLBACK' ||
                    radarState === 'WATCH' ||
                    radarState === 'EARLY_FAILED' ||
                    radarState === 'WEAKENING' ||
                    discHot ||
                    boardMover ||
                    prePlus3 ||
                    (disc != null &&
                        (disc.change_pct ?? 0) >= uiGuaranteePct) ||
                    ((c?.intraday_score ?? 0) >= 65 ||
                        opportunity >= 55 ||
                        (disc?.change_pct ?? 0) >=
                            this.cfg.board_mover_min_change_pct),
            });

            if (!disc) {
                this.funnel.markDrop(symbol, 'Discovery', 'NOT_IN_DISCOVERY');
            } else if (!c) {
                this.funnel.markDrop(symbol, 'C', 'C_TOP30_LIMIT', {
                    score: disc.discovery_score,
                    threshold: 30,
                });
            }
        }

        const attackSort = (a: RescueCard, b: RescueCard) =>
            this.attackPriority(b) - this.attackPriority(a) ||
            b.focus_score - a.focus_score ||
            (b.true_ask_eating ? 1 : 0) - (a.true_ask_eating ? 1 : 0) ||
            (b.rank_change ?? 0) - (a.rank_change ?? 0) ||
            // Prefer lower day-change within EARLY band (not chase by % gain)
            (a.change_pct ?? 99) - (b.change_pct ?? 99);

        const preAttackCards = cards
            .filter((x) => x.radar_state === 'PRE_ATTACK')
            .sort(attackSort);
        const earlyCards = [
            ...preAttackCards,
            ...cards.filter((x) => x.radar_state === 'EARLY').sort(attackSort),
            ...cards
                .filter((x) => x.radar_state === 'STALLING')
                .sort(attackSort),
        ];
        const activeCards = cards
            .filter(
                (x) =>
                    !x.data_stale &&
                    (x.radar_state === 'ACTIVE' ||
                        x.radar_state === 'NEAR_LIMIT' ||
                        x.radar_state === 'LIMIT_UP'),
            )
            .sort(
                (a, b) =>
                    b.focus_score - a.focus_score ||
                    b.opportunity_score - a.opportunity_score,
            );
        const pullbackCards = cards
            .filter((x) => x.radar_state === 'PULLBACK')
            .sort((a, b) => b.focus_score - a.focus_score);
        const watchCards = cards
            .filter(
                (x) =>
                    x.radar_state === 'WATCH' ||
                    x.radar_state === 'EARLY_FAILED' ||
                    x.radar_state === 'WEAKENING' ||
                    x.radar_state === 'FAKE_BREAKOUT' ||
                    x.radar_state === 'DATA_STALE' ||
                    x.radar_state === 'DATA_INCOMPLETE',
            )
            .sort(attackSort);
        const insufficient = cards.filter(
            (x) =>
                x.radar_state === 'INSUFFICIENT_DATA' ||
                x.radar_state === 'INVALID',
        );

        const earlyFocus = earlyCards
            .filter(
                (x) =>
                    !this.cfg.focus_block_low_confidence ||
                    x.data_confidence !== 'LOW',
            )
            .filter(
                (x, i, arr) =>
                    arr.findIndex((y) => y.symbol === x.symbol) === i,
            )
            .slice(
                0,
                Math.max(
                    this.cfg.early_focus_top_n,
                    this.cfg.pre_plus3_focus_top_n,
                ),
            );
        let confirmedFocus = [...activeCards, ...pullbackCards]
            .filter(
                (x) =>
                    !this.cfg.focus_block_low_confidence ||
                    x.data_confidence !== 'LOW',
            )
            .sort((a, b) => b.focus_score - a.focus_score)
            .slice(0, this.cfg.confirmed_focus_top_n);

        // Force top board movers into focus first (bypass C top-30 recall hole).
        {
            const movers = cards
                .filter((x) => boardMovers.has(x.symbol))
                .sort((a, b) => (b.change_pct ?? 0) - (a.change_pct ?? 0));
            const have = new Set<string>();
            const forced: typeof confirmedFocus = [];
            for (const m of movers) {
                if (forced.length >= this.cfg.confirmed_focus_top_n) break;
                forced.push(m);
                have.add(m.symbol);
            }
            for (const c of confirmedFocus) {
                if (forced.length >= this.cfg.confirmed_focus_top_n) break;
                if (have.has(c.symbol)) continue;
                forced.push(c);
                have.add(c.symbol);
            }
            if (forced.length) confirmedFocus = forced;
        }

        // After hours / degraded: still surface strongest residual names so UI
        // is not an empty "目前沒有符合條件" when C already ranked them.
        if (
            confirmedFocus.length === 0 &&
            earlyFocus.length === 0 &&
            watchCards.length > 0
        ) {
            confirmedFocus = [...watchCards]
                .sort(
                    (a, b) =>
                        (b.change_pct ?? 0) - (a.change_pct ?? 0) ||
                        (b.c_score ?? 0) - (a.c_score ?? 0) ||
                        b.opportunity_score - a.opportunity_score,
                )
                .slice(0, this.cfg.confirmed_focus_top_n);
        }

        // Always promote top WATCH runners into focus if still sparse.
        if (
            confirmedFocus.length < this.cfg.confirmed_focus_top_n &&
            watchCards.length > 0
        ) {
            const have = new Set(confirmedFocus.map((x) => x.symbol));
            for (const w of [...watchCards]
                .sort(
                    (a, b) =>
                        (b.change_pct ?? 0) - (a.change_pct ?? 0) ||
                        b.opportunity_score - a.opportunity_score,
                )
                .slice(0, this.cfg.ui_promote_watch_top_n)) {
                if (have.has(w.symbol)) continue;
                confirmedFocus.push(w);
                have.add(w.symbol);
                if (confirmedFocus.length >= this.cfg.confirmed_focus_top_n) break;
            }
        }

        earlyFocus.forEach((x, i) =>
            this.funnel.upsert({
                symbol: x.symbol,
                focus_score: x.focus_score,
                focus_rank: i + 1,
                ui_visible: true,
            }),
        );
        confirmedFocus.forEach((x, i) =>
            this.funnel.upsert({
                symbol: x.symbol,
                focus_score: x.focus_score,
                focus_rank: i + 1,
                ui_visible: true,
            }),
        );

        this.bySymbol = new Map(cards.map((x) => [x.symbol, x]));

        const lowRatio =
            cards.length === 0
                ? 1
                : cards.filter((x) => x.data_confidence === 'LOW').length /
                  cards.length;

        this.last = {
            as_of: new Date().toISOString(),
            version: RESCUE_VERSION,
            mode: this.cfg.mode,
            mutates_strategy: false,
            market_status: cashSession ? 'CASH_LIVE' : 'AFTER_HOURS',
            data_status: lowRatio > 0.6 ? 'DEGRADED' : 'OK',
            focus: { early: earlyFocus, confirmed: confirmedFocus },
            early: earlyCards,
            active: activeCards,
            pullback: pullbackCards,
            watch: watchCards,
            insufficient,
            count: {
                early: earlyCards.length,
                active: activeCards.length,
                pullback: pullbackCards.length,
                watch: watchCards.length,
                insufficient: insufficient.length,
            },
        };

        if (
            this.cfg.persist_transitions &&
            Date.now() - this.transitionFlushAt > 60_000
        ) {
            this.funnel.flushTransitions();
            this.transitionFlushAt = Date.now();
        }

        return this.last;
    }

    /** Sort priority: PRE_ATTACK > EARLY > WATCH (+ push efficiency / ask quality). */
    private attackPriority(card: RescueCard): number {
        const stateBoost: Record<string, number> = {
            PRE_ATTACK: 300,
            EARLY: 200,
            ACTIVE: 250,
            NEAR_LIMIT: 260,
            LIMIT_UP: 270,
            STALLING: 60,
            WATCH: 100,
            PULLBACK: 80,
            WEAKENING: 40,
            EARLY_FAILED: 30,
            FAKE_BREAKOUT: 20,
            DATA_STALE: 10,
            DATA_INCOMPLETE: 10,
        };
        const vol = Number.isFinite(card.trigger_score) ? card.trigger_score : 0;
        const askQ = Number.isFinite(card.ask_eating_quality)
            ? card.ask_eating_quality
            : 0;
        const push = Number.isFinite(card.push_efficiency)
            ? card.push_efficiency
            : 0;
        const attack = Number.isFinite(card.attack_score)
            ? card.attack_score
            : 0;
        const vwap =
            card.reasons.some((r) => r.includes('VWAP')) ? 10 : 0;
        // Prefer price-push efficiency over raw volume.
        return (
            (stateBoost[card.radar_state] ?? 0) +
            vol * 0.15 +
            askQ * 0.35 +
            push * 0.45 +
            attack * 0.2 +
            vwap -
            (card.data_stale ? 80 : 0)
        );
    }

    private buildReasons(
        evidence: EarlyEvidence[],
        c: IntradayRankItem | null,
        bp: BuyPressureItem | null,
        newsState: NewsMarketState,
    ): string[] {
        const map: Record<string, string> = {
            RANK_ACCEL: 'Rank暴升',
            MOMENTUM_ACCEL: 'Momentum轉正',
            VOLUME_ACCEL: '量加速',
            BP_RISING: 'BP上升',
            VWAP_RECLAIM: 'VWAP reclaim',
            BREAKOUT: '突破中',
            BUY_SURGE: '買盤湧現',
            ASK_EATING: '吃賣單',
            TRADE_AGGRESSION_RISING: '成交攻擊上升',
            RELATIVE_STRENGTH_RISING: '相對強勢',
        };
        const reasons: string[] = [];
        for (const e of evidence) {
            if (map[e]) reasons.push(map[e]!);
        }
        if (c?.metrics?.vwap_pos_pct != null && c.metrics.vwap_pos_pct >= 0) {
            reasons.push('VWAP上方');
        }
        if (newsState === 'POSITIVE_CONFIRMED') reasons.push('新聞正向確認');
        if (bp?.primary_state === 'COOLING') reasons.push('買盤轉冷');
        return [...new Set(reasons)];
    }

    private computeFocusScore(
        state: RescueRadarState,
        opportunity: number,
        trigger: number,
        conf: DataConfidence,
    ): number {
        if (conf === 'LOW') return -1;
        if (state === 'INSUFFICIENT_DATA' || state === 'INVALID') return -1;
        let base = 0;
        if (state === 'LIMIT_UP') base = 50;
        else if (state === 'NEAR_LIMIT') base = 45;
        else if (state === 'ACTIVE') base = 40;
        else if (state === 'PRE_ATTACK') base = 35;
        else if (state === 'PULLBACK') base = 25;
        else if (state === 'EARLY') base = 30;
        else if (state === 'STALLING') base = 12;
        else if (state === 'WATCH') base = 10;
        else if (
            state === 'WEAKENING' ||
            state === 'EARLY_FAILED' ||
            state === 'FAKE_BREAKOUT'
        )
            base = 5;
        const t = Number.isFinite(trigger) ? trigger : 0;
        const o = Number.isFinite(opportunity) ? opportunity : 0;
        return clamp(base + o * 0.35 + t * 0.25);
    }
}
