// server/src/lib/historical-replay/replay-runner.ts
// Single-day 1m historical replay — no Outcome / learning / Telegram.
//
// Correct minute flow:
// 1) gather all bars with same known_at
// 2) atomic apply (all symbols + indexes)
// 3) ReplayClock = known_at
// 4) B evaluate once
// 5) C evaluate once
// speed only delays wall clock — never market time.

import { createHash } from 'node:crypto';
import type { MarketManager } from '../../providers/manager.ts';
import { IntradayRankService } from '../intraday-rank/service.ts';
import { loadIntradayRankConfig } from '../intraday-rank/config.ts';
import { MarketRuntime } from '../market-runtime/service.ts';
import { loadOpenGateConfig } from '../open-gate-v2/config.ts';
import { OpenGateV2Service } from '../open-gate-v2/service.ts';
import { resolvePhase } from '../open-gate-v2/open-gate-evaluator.ts';
import {
    JsonlSignalOutcomeRepository,
    SignalOutcomeService,
    type PriceBar,
} from '../signal-outcome/index.ts';
import {
    JsonlStrategySignalRepository,
    StrategySignalBridge,
    type StrategySignal,
} from '../strategy-signal/index.ts';
import {
    DEFAULT_BAR_TIMESTAMP_SEMANTICS,
} from './bar-time.ts';
import {
    buildSyntheticDayBars,
    HistoricalDataLoader,
    parseBarTs,
    SESSION_END_MIN,
    SESSION_START_MIN,
    type DayBars,
    type KBarFetcher,
} from './historical-data-loader.ts';
import {
    learningEligible,
    REPLAY_1M_FEATURES,
    replayConfidence,
    replayQualityFromDataMissing,
    type ReplayConfidence,
    type ReplayQuality,
    type UniverseSource,
} from './feature-capability.ts';
import { parseSpeed, ReplayClock } from './replay-clock.ts';
import { ReplayMarketSource } from './replay-market-source.ts';

export interface ReplayRunInput {
    date: string;
    symbols: string[];
    speed?: string | number;
    synthetic?: boolean;
    fetcher?: KBarFetcher | MarketManager;
    market?: MarketManager;
    until?: string;
    indexSymbols?: string[];
    universe_source?: UniverseSource;
    /** Optional isolated data dirs for tests. */
    signalsDir?: string;
    outcomesDir?: string;
}

export interface ReplayTimelinePoint {
    known_at: string;
    phase: string;
    b: {
        pass: number;
        watch: number;
        reject: number;
        early_pass: number;
        items: Array<{
            symbol: string;
            open_confirm: string;
            final_open_score: number;
        }>;
    };
    c: {
        strong: number;
        heating: number;
        emerging: number;
        events: string[];
        items: Array<{
            symbol: string;
            rank: number;
            state: string;
            intraday_score: number;
            score_coverage_pct?: number;
            score_confidence?: string;
            feature_availability?: Record<string, boolean>;
        }>;
    };
}

export interface ReplayRunReport {
    replay_run_id: string;
    date: string;
    symbols: string[];
    source_mode: 'replay';
    data_resolution: '1m';
    bar_timestamp_semantics: typeof DEFAULT_BAR_TIMESTAMP_SEMANTICS;
    universe_source: UniverseSource;
    learning_eligible: boolean;
    strategy_version: string;
    open_gate_config_hash: string;
    intraday_rank_config_hash: string;
    features: typeof REPLAY_1M_FEATURES;
    /** Mean of per-symbol per-minute score_coverage_pct — NOT a fixed constant. */
    feature_coverage_pct: number;
    replay_confidence: ReplayConfidence;
    data_quality: ReplayQuality;
    total_bars: number;
    data_missing_count: number;
    data_missing_ranges: string[];
    no_trade_count: number;
    no_trade_ranges: string[];
    /** @deprecated use data_missing_* */
    missing_bar_count: number;
    missing_bar_ranges: string[];
    amount_available: boolean;
    index_available: boolean;
    scanner_replay_available: false;
    /** Live MI must never be injected into historical replay (no point-in-time dataset). */
    market_intelligence_available: false;
    discovery_capability: 'fixed_universe_only';
    status: 'completed' | 'failed';
    started_at: string;
    completed_at: string;
    warnings: string[];
    summary: {
        b_pass: number;
        b_watch: number;
        b_reject: number;
        c_strong_enter: number;
        c_surge: number;
        c_breakout: number;
        c_rebreak: number;
        c_rank_jump: number;
        /** Counts from StrategySignalBridge.created */
        open_pass: number;
        strong_enter: number;
        surge: number;
        breakout: number;
        rebreak: number;
        rank_jump: number;
        pullback_ready: number;
    };
    signals: {
        total: number;
        by_type: Record<string, number>;
        learning_eligible_count: number;
        low_confidence_count: number;
    };
    outcomes: {
        complete: number;
        ambiguous: number;
        partial: number;
    };
    timeline: ReplayTimelinePoint[];
}

function configHash(obj: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify(obj))
        .digest('hex')
        .slice(0, 12);
}

function untilKnownAt(date: string, until?: string): number {
    if (until) {
        // until HH:mm is bar_start label → known_at = bar_end = +60s
        return parseBarTs(`${date} ${until}:00`) + 60_000;
    }
    const endH = String(Math.floor(SESSION_END_MIN / 60)).padStart(2, '0');
    const endM = String(SESSION_END_MIN % 60).padStart(2, '0');
    return parseBarTs(`${date} ${endH}:${endM}:00`) + 60_000;
}

function stableSnapshot(r: ReplayRunReport): string {
    return JSON.stringify({
        timeline: r.timeline.map((t) => ({
            known_at: t.known_at,
            phase: t.phase,
            b: t.b.items,
            c: t.c.items.map((i) => ({
                symbol: i.symbol,
                rank: i.rank,
                score: i.intraday_score,
                state: i.state,
                coverage: i.score_coverage_pct,
            })),
        })),
    });
}

export async function runHistoricalReplay(
    input: ReplayRunInput,
): Promise<ReplayRunReport> {
    const startedWall = new Date().toISOString();
    const warnings: string[] = [];
    const symbols = [...new Set(input.symbols.map((s) => s.trim()).filter(Boolean))].sort();
    if (!symbols.length) throw new Error('symbols required');

    const universe_source: UniverseSource =
        input.universe_source ??
        (input.synthetic ? 'synthetic' : 'manual_test');
    const learning_eligible = learningEligible(
        universe_source,
        Boolean(input.synthetic),
    );
    if (!learning_eligible) {
        warnings.push(
            `learning_eligible=false (universe_source=${universe_source})`,
        );
    }

    // Clock span: first bar known_at (09:01 for 09:00 bar) → until known_at
    const firstKnownAt = parseBarTs(`${input.date} 09:00:00`) + 60_000;
    const endKnownAt = untilKnownAt(input.date, input.until);
    const speed =
        typeof input.speed === 'number'
            ? input.speed
            : parseSpeed(String(input.speed ?? 'max'));

    const clock = new ReplayClock({
        startTime: new Date(firstKnownAt),
        endTime: new Date(endKnownAt),
        speed,
    });
    const source = new ReplayMarketSource(clock);

    const market = input.market;
    if (!market) {
        throw new Error('market (MarketManager) required for replay wiring');
    }

    const loader = new HistoricalDataLoader(input.fetcher ?? market);
    let stockDays: DayBars[];
    if (input.synthetic) {
        stockDays = symbols.map((s, i) =>
            buildSyntheticDayBars({
                symbol: s,
                date: input.date,
                startPrice: 100 + i * 10,
                withAmount: true,
                // Stronger path so C can form research signals on synthetic days
                mutateAfter: (sm, close) => {
                    if (sm >= 60 && sm < 90) return close * (1 + 0.004);
                    if (sm >= 120 && sm < 140) return close * (1 + 0.006);
                    return close;
                },
            }),
        );
        warnings.push('synthetic bars — not real exchange history');
    } else {
        const map = await loader.loadStocks(input.date, symbols);
        stockDays = symbols.map((s) => map.get(s)!);
    }

    const indexSymbols = input.indexSymbols ?? ['IX0001', 'IX0043'];
    const indexDays: DayBars[] = [];
    let indexAvailable = false;
    if (!input.synthetic) {
        for (const ix of indexSymbols) {
            const d = await loader.loadIndexDay(input.date, ix);
            if (d && d.bars.length) {
                indexDays.push(d);
                indexAvailable = true;
            }
        }
    } else {
        for (const ix of indexSymbols) {
            indexDays.push(
                buildSyntheticDayBars({
                    symbol: ix,
                    date: input.date,
                    startPrice: ix === 'IX0001' ? 20000 : 250,
                    withAmount: false,
                    volumePerBar: 0,
                }),
            );
        }
        indexAvailable = true;
        warnings.push('synthetic index bars');
    }
    if (!indexAvailable) {
        warnings.push(
            'index history unavailable — regime data_available=false',
        );
    }

    source.loadDayData(stockDays, indexDays);

    const runtime = new MarketRuntime({
        market,
        clock,
        source,
        replayMode: true,
    });
    runtime.setSourceMode('replay', '1m');
    runtime.setProfileAsOfExclusive(input.date);
    runtime.start();

    for (const d of stockDays) {
        const first = d.bars.find((b) => b.volume > 0) ?? d.bars[0];
        if (first) runtime.engine.seedPrevClose(d.symbol, first.open);
    }
    for (const d of indexDays) {
        const first = d.bars[0];
        if (first) runtime.engine.seedPrevClose(d.symbol, first.open);
    }

    if (input.synthetic) {
        for (const s of symbols) {
            const byMinute = new Map<number, number>();
            for (let m = 0; m <= 270; m++) byMinute.set(m, 1000 * (m + 1));
            runtime.profiles.injectCurve(s, byMinute, 20);
        }
    } else {
        try {
            await runtime.preloadProfiles(symbols);
        } catch (e) {
            warnings.push(
                `profile preload failed: ${e instanceof Error ? e.message : e}`,
            );
        }
    }

    await source.subscribeStocks(symbols);
    await source.subscribeIndexes(indexSymbols);

    const signalRepo = new JsonlStrategySignalRepository(
        input.signalsDir,
    );
    const signalBridge = new StrategySignalBridge(signalRepo);
    signalBridge.setContext({
        source_mode: 'replay',
        data_resolution: '1m',
        universe_source,
        learning_eligible,
    });
    signalBridge.resetCreated();

    const openGate = new OpenGateV2Service(
        market,
        runtime,
        signalBridge,
    );
    await openGate.setCandidates(
        symbols.map((code) => ({
            code,
            name: code,
            a_score: 60,
            strength: 60,
        })),
    );

    const intraday = new IntradayRankService(
        market,
        runtime,
        openGate,
        signalBridge,
    );
    intraday.seedReplayUniverse(symbols.map((s) => ({ symbol: s })));
    warnings.push('scanner_replay_available=false — fixed universe only');
    warnings.push(
        `bar_timestamp_semantics=${DEFAULT_BAR_TIMESTAMP_SEMANTICS} (known_at=bar_end)`,
    );

    const timeline: ReplayTimelinePoint[] = [];
    let bPass = 0;
    let bWatch = 0;
    let bReject = 0;
    let cStrongEnter = 0;
    let cSurge = 0;
    let cBreakout = 0;
    let cRebreak = 0;
    let cRankJump = 0;
    const prevState = new Map<string, string>();
    const coverageSamples: number[] = [];

    clock.start();
    const knownAts = source.knownAtTimeline(firstKnownAt, endKnownAt);

    for (const knownAt of knownAts) {
        // 1–2) Atomic apply all symbols+index for this known_at (sorted)
        source.emitBatchAtKnownAt(knownAt);

        // 3) Clock = known_at BEFORE evaluate
        clock.setCurrent(new Date(knownAt));

        // 4–5) One B + one C evaluation for the whole universe
        const bBatch = await openGate.evaluatePool();
        const cBatch = await intraday.evaluateOnce();
        const phase = resolvePhase(loadOpenGateConfig(), clock.now()).phase;

        const events: string[] = [];
        for (const it of cBatch?.items ?? []) {
            for (const e of it.events) events.push(`${it.symbol}:${e}`);
            if (it.events.includes('SURGE')) cSurge += 1;
            if (it.events.includes('BREAKOUT')) cBreakout += 1;
            if (it.events.includes('REBREAK')) cRebreak += 1;
            if (it.events.includes('RANK_JUMP')) cRankJump += 1;
            if (it.score_coverage_pct != null) {
                coverageSamples.push(it.score_coverage_pct);
            }
            const prev = prevState.get(it.symbol);
            if (
                (it.state === 'STRONG' || it.state === 'HEATING') &&
                prev !== 'STRONG' &&
                prev !== 'HEATING'
            ) {
                cStrongEnter += 1;
            }
            prevState.set(it.symbol, it.state);
        }

        bPass = Math.max(bPass, bBatch.pass);
        bWatch = Math.max(bWatch, bBatch.watch);
        bReject = Math.max(bReject, bBatch.reject);

        const timeLabel = clock.now().toLocaleString('en-CA', {
            timeZone: 'Asia/Taipei',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });

        timeline.push({
            known_at: timeLabel,
            phase,
            b: {
                pass: bBatch.pass,
                watch: bBatch.watch,
                reject: bBatch.reject,
                early_pass: bBatch.early_pass,
                items: bBatch.items.map((i) => ({
                    symbol: i.symbol,
                    open_confirm: i.open_confirm,
                    final_open_score: i.final_open_score,
                })),
            },
            c: {
                strong: cBatch?.strong ?? 0,
                heating: cBatch?.heating ?? 0,
                emerging: cBatch?.emerging ?? 0,
                events,
                items: (cBatch?.items ?? []).map((i) => ({
                    symbol: i.symbol,
                    rank: i.rank,
                    state: i.state,
                    intraday_score: i.intraday_score,
                    score_coverage_pct: i.score_coverage_pct,
                    score_confidence: i.score_confidence,
                    feature_availability: i.feature_availability,
                })),
            },
        });

        // Speed: wall-clock delay only — must not change scores
        if (speed !== Number.POSITIVE_INFINITY && speed > 0) {
            await sleep(Math.min(60_000 / speed, 50));
        }
    }

    clock.status = 'completed';

    // Outcome: after signals formed — may look at future bars (B/C already done)
    const signals: StrategySignal[] = [...signalBridge.created];
    const dayBarsBySymbol = new Map<string, PriceBar[]>();
    for (const d of stockDays) {
        dayBarsBySymbol.set(
            d.symbol,
            d.bars.map((b) => ({
                t: b.known_at,
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close,
            })),
        );
    }
    const outcomeRepo = new JsonlSignalOutcomeRepository(
        input.outcomesDir,
    );
    const outcomeSvc = new SignalOutcomeService(outcomeRepo);
    const outcomes = outcomeSvc.settleReplayDay(signals, dayBarsBySymbol);

    runtime.stop();

    const byType: Record<string, number> = {};
    for (const s of signals) {
        byType[s.signal_type] = (byType[s.signal_type] ?? 0) + 1;
    }

    const data_missing_count = stockDays.reduce(
        (a, d) => a + d.data_missing_count,
        0,
    );
    const data_missing_ranges = [
        ...new Set(stockDays.flatMap((d) => d.data_missing_ranges)),
    ];
    const no_trade_count = stockDays.reduce(
        (a, d) => a + d.no_trade_count,
        0,
    );
    const no_trade_ranges = [
        ...new Set(stockDays.flatMap((d) => d.no_trade_ranges)),
    ];
    const amount_available = stockDays.every((d) => d.amount_available);
    const meanCoverage =
        coverageSamples.length > 0
            ? coverageSamples.reduce((a, b) => a + b, 0) /
              coverageSamples.length
            : 0;
    const quality = replayQualityFromDataMissing(
        data_missing_count,
        data_missing_ranges,
    );
    const confidence = replayConfidence({
        meanCoveragePct: meanCoverage,
        dataMissingCount: data_missing_count,
        amountAvailable: amount_available,
        indexAvailable,
    });

    const ogCfg = loadOpenGateConfig();
    const irCfg = loadIntradayRankConfig();

    return {
        replay_run_id: `rr_${input.date}_${symbols.join('-')}_${Date.now()}`,
        date: input.date,
        symbols,
        source_mode: 'replay',
        data_resolution: '1m',
        bar_timestamp_semantics: DEFAULT_BAR_TIMESTAMP_SEMANTICS,
        universe_source,
        learning_eligible,
        strategy_version: 'bc-replay-v1',
        open_gate_config_hash: configHash(ogCfg),
        intraday_rank_config_hash: configHash(irCfg),
        features: REPLAY_1M_FEATURES,
        feature_coverage_pct: Math.round(meanCoverage),
        replay_confidence: confidence,
        data_quality: quality,
        total_bars: stockDays.reduce(
            (a, d) => a + d.bars.filter((b) => !b.gap_kind).length,
            0,
        ),
        data_missing_count,
        data_missing_ranges,
        no_trade_count,
        no_trade_ranges,
        missing_bar_count: data_missing_count,
        missing_bar_ranges: data_missing_ranges,
        amount_available,
        index_available: indexAvailable,
        scanner_replay_available: false,
        market_intelligence_available: false,
        discovery_capability: 'fixed_universe_only',
        status: 'completed',
        started_at: startedWall,
        completed_at: new Date().toISOString(),
        warnings,
        summary: {
            b_pass: bPass,
            b_watch: bWatch,
            b_reject: bReject,
            c_strong_enter: cStrongEnter,
            c_surge: cSurge,
            c_breakout: cBreakout,
            c_rebreak: cRebreak,
            c_rank_jump: cRankJump,
            open_pass: byType['OPEN_PASS'] ?? 0,
            strong_enter: byType['STRONG_ENTER'] ?? 0,
            surge: byType['SURGE'] ?? 0,
            breakout: byType['BREAKOUT'] ?? 0,
            rebreak: byType['REBREAK'] ?? 0,
            rank_jump: byType['RANK_JUMP'] ?? 0,
            pullback_ready: byType['PULLBACK_READY'] ?? 0,
        },
        signals: {
            total: signals.length,
            by_type: byType,
            learning_eligible_count: signals.filter((s) => s.learning_eligible)
                .length,
            low_confidence_count: signals.filter(
                (s) => s.score_confidence === 'low',
            ).length,
        },
        outcomes: {
            complete: outcomes.filter(
                (o) => o.status === 'complete' || o.status === 'ambiguous',
            ).length,
            ambiguous: outcomes.filter(
                (o) =>
                    o.status === 'ambiguous' ||
                    o.outcome_sequence === 'ambiguous',
            ).length,
            partial: outcomes.filter((o) => o.status === 'partial').length,
        },
        timeline,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

export function formatReplayReport(r: ReplayRunReport): string {
    const lines = [
        `Replay Date: ${r.date}`,
        `Symbols: ${r.symbols.join(', ')}`,
        `Universe: ${r.universe_source} (learning_eligible=${r.learning_eligible})`,
        `Bar semantics: ${r.bar_timestamp_semantics} → known_at=bar_end`,
        `Total Bars (traded): ${r.total_bars}`,
        `DATA_MISSING: ${r.data_missing_count}`,
        r.data_missing_ranges.length
            ? `  ranges: ${r.data_missing_ranges.slice(0, 20).join(', ')}`
            : '',
        `NO_TRADE: ${r.no_trade_count}`,
        r.no_trade_ranges.length
            ? `  ranges: ${r.no_trade_ranges.slice(0, 10).join(', ')}`
            : '',
        '',
        'B:',
        `  PASS max: ${r.summary.b_pass}`,
        `  WATCH max: ${r.summary.b_watch}`,
        `  REJECT max: ${r.summary.b_reject}`,
        '',
        'C:',
        `  STRONG_ENTER: ${r.summary.c_strong_enter}`,
        `  SURGE: ${r.summary.c_surge}`,
        `  BREAKOUT: ${r.summary.c_breakout}`,
        `  REBREAK: ${r.summary.c_rebreak}`,
        `  RANK_JUMP: ${r.summary.c_rank_jump}`,
        '',
        `Feature Coverage (mean per-eval): ${r.feature_coverage_pct}%`,
        `Replay Confidence: ${r.replay_confidence}`,
        `Data Quality: ${r.data_quality}`,
        `Amount available: ${r.amount_available}`,
        `Index available: ${r.index_available}`,
        `Scanner replay: ${r.scanner_replay_available}`,
        '',
        'Baseline unavailable (1m):',
        ...Object.entries(r.features)
            .filter(([, v]) => !v)
            .map(([k]) => `  - ${k}`),
        '',
        'Warnings:',
        ...(r.warnings.length
            ? r.warnings.map((w) => `  - ${w}`)
            : ['  (none)']),
        '',
        `Timeline points: ${r.timeline.length}`,
        `Phases sample: ${[...new Set(r.timeline.map((t) => `${t.known_at}=${t.phase}`))].slice(0, 8).join(' | ')}`,
        '',
        'StrategySignals:',
        `  total=${r.signals.total} learning_eligible=${r.signals.learning_eligible_count} low_conf=${r.signals.low_confidence_count}`,
        ...Object.entries(r.signals.by_type).map(
            ([k, v]) => `  ${k}: ${v}`,
        ),
        '',
        'Outcomes:',
        `  complete/ambiguous=${r.outcomes.complete} ambiguous=${r.outcomes.ambiguous} partial=${r.outcomes.partial}`,
    ];
    return lines.filter((l) => l !== undefined).join('\n');
}

export { stableSnapshot, SESSION_START_MIN, SESSION_END_MIN };
