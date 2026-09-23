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

        const universe = new Map<string, { name: string }>();
        for (const d of discovery) universe.set(d.symbol, { name: d.name });
        for (const i of cItems) universe.set(i.symbol, { name: i.name });
        for (const l of laneMerged) universe.set(l.symbol, { name: l.name });

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

            const chase = computeChaseRisk(this.cfg, {
                changePct: c?.change_pct ?? bp?.change_pct ?? disc?.change_pct,
                vwapExtPct:
                    c?.metrics?.vwap_pos_pct ?? bp?.distance_from_vwap_pct,
                moveCompletedPct:
                    c?.change_pct != null
                        ? Math.min(1, Math.max(0, c.change_pct / 10))
                        : null,
            });

            const discChg = disc?.change_pct ?? 0;
            const discHot =
                !c &&
                disc != null &&
                discChg >= this.cfg.rescue_disc_active_min_change_pct &&
                (trigger >= this.cfg.rescue_disc_active_min_trigger ||
                    (disc.discovery_score ?? 0) >=
                        this.cfg.rescue_disc_active_min_discovery ||
                    (disc.scanner_ranks?.change ?? 999) <= 40);

            const radarState = this.resolveState({
                stale: !!stale,
                dataConfidence,
                coreReady,
                early: early.early || discHot,
                c,
                bp,
                newsState: news.state,
                cashSession,
                discHot,
                trigger,
            });

            const focusScore = this.computeFocusScore(
                radarState,
                opportunity,
                trigger,
                dataConfidence,
            );

            const card: RescueCard = {
                symbol,
                name: c?.name ?? bp?.name ?? meta.name,
                last_price: c?.last_price ?? bp?.last_price ?? null,
                change_pct:
                    c?.change_pct ?? bp?.change_pct ?? disc?.change_pct ?? null,
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
                reasons: this.buildReasons(
                    early.evidence,
                    c,
                    bp,
                    news.state,
                ).slice(0, 3),
                layers: {
                    stock:
                        early.early ||
                        radarState === 'ACTIVE' ||
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
                focus_score: focusScore,
                lanes: lane?.lanes ?? [],
                late_detection: false,
                move_before_signal_pct: null,
            };

            const chg = card.change_pct ?? 0;
            if (
                (radarState === 'EARLY' || radarState === 'ACTIVE') &&
                chg >= 6.5
            ) {
                card.late_detection = true;
                card.move_before_signal_pct = chg;
            }

            cards.push(card);

            const inScanner = !!disc?.candidate_sources.some((s) =>
                s.startsWith('SCANNER_'),
            );
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
                // Rescue-shadow active: lane/disc-hot counts even if C top-30 missed.
                in_active_watch:
                    !!c ||
                    discHot ||
                    radarState === 'ACTIVE' ||
                    radarState === 'EARLY',
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
                early_trigger: early.early || radarState === 'EARLY' || discHot,
                opportunity_score: opportunity,
                chase_risk: chase,
                news_state: news.state,
                news_confidence: news.confidence,
                ui_visible:
                    radarState === 'EARLY' ||
                    radarState === 'ACTIVE' ||
                    radarState === 'PULLBACK' ||
                    discHot ||
                    (radarState === 'WATCH' &&
                        ((c?.intraday_score ?? 0) >= 70 ||
                            opportunity >= 60 ||
                            (disc?.change_pct ?? 0) >= 2)),
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

        const earlyCards = cards
            .filter((x) => x.radar_state === 'EARLY')
            .sort(
                (a, b) =>
                    b.trigger_score - a.trigger_score ||
                    (b.rank_change ?? 0) - (a.rank_change ?? 0),
            );
        const activeCards = cards
            .filter((x) => x.radar_state === 'ACTIVE')
            .sort(
                (a, b) =>
                    b.focus_score - a.focus_score ||
                    b.opportunity_score - a.opportunity_score,
            );
        const pullbackCards = cards
            .filter((x) => x.radar_state === 'PULLBACK')
            .sort((a, b) => b.focus_score - a.focus_score);
        const watchCards = cards
            .filter((x) => x.radar_state === 'WATCH')
            .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
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
            .slice(0, this.cfg.early_focus_top_n);
        let confirmedFocus = [...activeCards, ...pullbackCards]
            .filter(
                (x) =>
                    !this.cfg.focus_block_low_confidence ||
                    x.data_confidence !== 'LOW',
            )
            .sort((a, b) => b.focus_score - a.focus_score)
            .slice(0, this.cfg.confirmed_focus_top_n);

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
                        (b.c_score ?? 0) - (a.c_score ?? 0) ||
                        b.opportunity_score - a.opportunity_score ||
                        b.focus_score - a.focus_score,
                )
                .slice(0, this.cfg.confirmed_focus_top_n);
        }

        // Always promote top WATCH runners into focus if still sparse (< half quota).
        if (
            confirmedFocus.length < Math.ceil(this.cfg.confirmed_focus_top_n / 2) &&
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

    private resolveState(opts: {
        stale: boolean;
        dataConfidence: DataConfidence;
        coreReady: boolean;
        early: boolean;
        c: IntradayRankItem | null;
        bp: BuyPressureItem | null;
        newsState: NewsMarketState;
        cashSession: boolean;
        /** Discovery-only morning runner (not yet in C top pool). */
        discHot: boolean;
        trigger: number;
    }): RescueRadarState {
        // Hard fail only when quotes are blocked or we have no usable core.
        if (opts.c?.data_blocked) return 'INSUFFICIENT_DATA';
        if (
            !opts.coreReady &&
            opts.dataConfidence === 'LOW' &&
            !opts.c &&
            !opts.bp &&
            !opts.discHot
        ) {
            return 'INSUFFICIENT_DATA';
        }
        if (opts.c?.state === 'INVALID') return 'INVALID';

        const pullbackReady =
            opts.c?.events?.includes('PULLBACK_READY') ||
            opts.c?.metrics?.pullback_state === 'holding' ||
            opts.c?.metrics?.pullback_state === 'reclaiming';

        const hasMomentum =
            (opts.c?.state === 'STRONG' ||
                opts.c?.state === 'HEATING' ||
                opts.c?.state === 'EMERGING') &&
            (opts.c.intraday_score ?? 0) >= 55;

        const bpHot =
            !!opts.bp &&
            ['BUY_SURGE', 'ASK_EATING', 'VOLUME_BREAKOUT', 'EARLY'].includes(
                opts.bp.primary_state,
            );

        // Stale residual with no momentum → watch/insufficient; keep residual WATCH.
        if (opts.stale && !hasMomentum && !bpHot && !opts.discHot) {
            return opts.c || opts.bp ? 'WATCH' : 'INSUFFICIENT_DATA';
        }

        // News alone cannot force ACTIVE
        if (
            opts.newsState === 'POSITIVE_UNCONFIRMED' &&
            !hasMomentum &&
            !bpHot &&
            !opts.discHot
        ) {
            if (opts.early) return 'EARLY';
            return opts.c || opts.bp || opts.discHot ? 'WATCH' : 'INACTIVE';
        }

        if (pullbackReady && (hasMomentum || bpHot)) return 'PULLBACK';

        // Clear C strength / BP surge / discovery morning runner.
        if (hasMomentum || bpHot || opts.discHot) {
            if (opts.cashSession) {
                if (
                    opts.dataConfidence !== 'LOW' ||
                    (opts.c?.intraday_score ?? 0) >= 70 ||
                    opts.discHot ||
                    opts.trigger >= this.cfg.rescue_disc_active_min_trigger
                ) {
                    return 'ACTIVE';
                }
            } else if (hasMomentum || opts.discHot) {
                // After hours: don't fake 發動中
                return 'WATCH';
            } else if (opts.dataConfidence !== 'LOW') {
                return 'ACTIVE';
            }
        }

        if (opts.early) return 'EARLY';
        if (opts.c || opts.bp || opts.discHot) return 'WATCH';
        return 'INACTIVE';
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
        if (state === 'ACTIVE') base = 40;
        else if (state === 'PULLBACK') base = 25;
        else if (state === 'EARLY') base = 30;
        else if (state === 'WATCH') base = 10;
        return clamp(base + opportunity * 0.35 + trigger * 0.25);
    }
}
