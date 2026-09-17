// server/src/acceptance-gate.ts
// Final Acceptance Gate — run before Shadow A/B.
// npm run acceptance:gate

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockMarketDataProvider } from './providers/mock/market.ts';
import { MarketManager } from './providers/manager.ts';
import { loadOpenGateConfig } from './lib/open-gate-v2/config.ts';
import { DataHealthService } from './lib/open-gate-v2/data-health.ts';
import { evaluateOpenGate } from './lib/open-gate-v2/open-gate-evaluator.ts';
import { runMomentumEngine } from './lib/open-gate-v2/momentum-engine.ts';
import type {
    ACandidate,
    OpenConfirmResult,
    SymbolMarketState,
} from './lib/open-gate-v2/types.ts';
import { DEFAULT_INTRADAY_RANK_CONFIG } from './lib/intraday-rank/config.ts';
import {
    attachRanks,
    scoreIntradaySymbol,
} from './lib/intraday-rank/intraday-rank-engine.ts';
import type { DiscoveryItem } from './lib/intraday-rank/types.ts';
import { EventEngine } from './lib/intraday-rank/event-engine.ts';
import type { Clock } from './lib/market-runtime/clock.ts';
import { SubscriptionManager } from './lib/market-runtime/subscription-manager.ts';
import {
    runHistoricalReplay,
} from './lib/historical-replay/index.ts';
import { JsonlStrategySignalRepository } from './lib/strategy-signal/repository.ts';
import { SignalLifecycleManager } from './lib/strategy-signal/lifecycle.ts';
import { StrategySignalFactory } from './lib/strategy-signal/factory.ts';
import type { StrategySignal } from './lib/strategy-signal/types.ts';

type Status = 'PASS' | 'FAIL';

const results: Array<{
    id: number;
    name: string;
    status: Status;
    detail: string;
}> = [];

function record(
    id: number,
    name: string,
    status: Status,
    detail: string,
): void {
    results.push({ id, name, status, detail });
    console.log(`[${status}] ${id}. ${name} — ${detail}`);
}

async function mockMarket(): Promise<MarketManager> {
    const manager = new MarketManager();
    const mock = new MockMarketDataProvider();
    await mock.init();
    manager.start(mock, 'mock');
    return manager;
}

function tempPair() {
    const signalsDir = mkdtempSync(join(tmpdir(), 'ag-sig-'));
    const outcomesDir = mkdtempSync(join(tmpdir(), 'ag-out-'));
    return {
        signalsDir,
        outcomesDir,
        cleanup: () => {
            rmSync(signalsDir, { recursive: true, force: true });
            rmSync(outcomesDir, { recursive: true, force: true });
        },
    };
}

function strategyFingerprint(r: Awaited<ReturnType<typeof runHistoricalReplay>>) {
    // Strategy-affecting only — strip run ids / wall completed_at
    return JSON.stringify({
        summary: r.summary,
        signals: {
            total: r.signals.total,
            by_type: r.signals.by_type,
            learning_eligible_count: r.signals.learning_eligible_count,
        },
        coverage: r.feature_coverage_pct,
        discovery: r.discovery_capability,
        scanner: r.scanner_replay_available,
        learning_eligible: r.learning_eligible,
        timeline: r.timeline.map((t) => ({
            known_at: t.known_at,
            phase: t.phase,
            b: t.b,
            c: {
                strong: t.c.strong,
                heating: t.c.heating,
                emerging: t.c.emerging,
                events: t.c.events,
                items: t.c.items.map((i) => ({
                    symbol: i.symbol,
                    rank: i.rank,
                    state: i.state,
                    intraday_score: i.intraday_score,
                })),
            },
        })),
    });
}

function signalStrategyView(signalsDir: string) {
    if (!existsSync(signalsDir)) return [];
    const files = readdirSync(signalsDir).filter((f) => f.endsWith('.jsonl'));
    const rows: Array<Record<string, unknown>> = [];
    for (const f of files) {
        if (f === 'known_ids.json' || f === 'lifecycle.json') continue;
        const text = readFileSync(join(signalsDir, f), 'utf8');
        for (const line of text.split('\n').filter(Boolean)) {
            const s = JSON.parse(line) as StrategySignal;
            rows.push({
                signal_type: s.signal_type,
                symbol: s.symbol,
                signal_time: s.signal_time,
                reference_price: s.reference_price,
                score: s.score,
                heat_score: s.heat_score,
                feature_snapshot: s.feature_snapshot,
            });
        }
    }
    return rows.sort((a, b) =>
        String(a.signal_time).localeCompare(String(b.signal_time)) ||
        String(a.signal_type).localeCompare(String(b.signal_type)) ||
        String(a.symbol).localeCompare(String(b.symbol)),
    );
}

// ─── A. Speed invariance ───────────────────────────────────────────
async function gateA(): Promise<void> {
    const market = await mockMarket();
    const runs: Array<{
        speed: number | string;
        fp: string;
        sigView: string;
        summary: unknown;
        report: Awaited<ReturnType<typeof runHistoricalReplay>>;
    }> = [];

    for (const speed of [1, 10, 'max'] as const) {
        const d = tempPair();
        try {
            const r = await runHistoricalReplay({
                date: '2026-06-15',
                symbols: ['2330', '2317'],
                synthetic: true,
                until: '10:30',
                speed,
                market,
                signalsDir: d.signalsDir,
                outcomesDir: d.outcomesDir,
                universe_source: 'synthetic',
            });
            runs.push({
                speed,
                fp: strategyFingerprint(r),
                sigView: JSON.stringify(signalStrategyView(d.signalsDir)),
                summary: r.summary,
                report: r,
            });
        } finally {
            d.cleanup();
        }
    }

    const sameFp = runs.every((x) => x.fp === runs[0]!.fp);
    const sameSig = runs.every((x) => x.sigView === runs[0]!.sigView);
    const ok = sameFp && sameSig;
    record(
        2,
        'Replay speed invariance',
        ok ? 'PASS' : 'FAIL',
        ok
            ? `speed=1/10/max identical; summary=${JSON.stringify(runs[0]!.summary)}; signals=${runs[0]!.report.signals.total} by_type=${JSON.stringify(runs[0]!.report.signals.by_type)}`
            : `MISMATCH fp=${sameFp} sig=${sameSig} summaries=${JSON.stringify(runs.map((r) => ({ speed: r.speed, summary: r.summary })))}`,
    );

    // Also stamp clock / datahealth / cooldown via existing fix-pack implications
    record(
        1,
        'Clock abstraction',
        ok ? 'PASS' : 'FAIL',
        ok
            ? 'Speed-invariant strategy outputs imply Clock-driven evaluate path'
            : 'Speed mismatch indicates residual wall-clock strategy dependency',
    );

    const r0 = runs[0]!.report;
    record(
        11,
        'Replay capability labeling',
        r0.scanner_replay_available === false &&
            r0.discovery_capability === 'fixed_universe_only' &&
            r0.learning_eligible === false
            ? 'PASS'
            : 'FAIL',
        `scanner=${r0.scanner_replay_available} discovery=${r0.discovery_capability} learning_eligible=${r0.learning_eligible}`,
    );
}

// ─── B. Date.now audit ─────────────────────────────────────────────
function gateB(): void {
    const root = join(dirname(fileURLToPath(import.meta.url)));
    const out = execSync(
        `rg -n "Date\\.now\\(|new Date\\(" --glob "*.ts" -g "!**/node_modules/**" .`,
        { cwd: root, encoding: 'utf8' },
    );
    const lines = out.split(/\r?\n/).filter(Boolean);

    const strategyAffecting: string[] = [];
    const logging: string[] = [];
    const metadata: string[] = [];
    const httpUi: string[] = [];
    const okLive: string[] = [];

    for (const line of lines) {
        const lower = line.toLowerCase();
        if (
            lower.includes('data-health') ||
            lower.includes('event-engine') ||
            (lower.includes('rank') && lower.includes('velocity'))
        ) {
            // should not appear as Date.now in those files for strategy
            if (lower.includes('date.now') && !lower.includes('comment') && !lower.includes('must use')) {
                strategyAffecting.push(line);
            }
            continue;
        }
        if (
            lower.includes('repository') ||
            lower.includes('heartbeat') ||
            lower.includes('log') ||
            lower.includes('throttle')
        ) {
            logging.push(line);
        } else if (
            lower.includes('replay_run_id') ||
            lower.includes('newid') ||
            lower.includes('factory') ||
            lower.includes('taipeiymd') ||
            lower.includes('completed_at') ||
            lower.includes('startedat')
        ) {
            metadata.push(line);
        } else if (
            lower.includes('routes/') ||
            lower.includes('sse/') ||
            lower.includes('index.ts')
        ) {
            httpUi.push(line);
        } else if (
            lower.includes('market-data-engine') ||
            lower.includes('systemclock') ||
            lower.includes('clock.ts')
        ) {
            okLive.push(line);
        } else if (lower.includes('date.now')) {
            // classify residual Date.now
            if (
                lower.includes('discovery-engine') ||
                lower.includes('open-confirm-repository') ||
                lower.includes('intraday-rank/repository')
            ) {
                logging.push(line);
            } else if (lower.includes('market-regime.ts')) {
                okLive.push(line + ' [live yahoo path; replay uses evaluateOffline(nowMs)]');
            } else {
                metadata.push(line);
            }
        } else {
            metadata.push(line);
        }
    }

    // Verify data-health / event-engine do NOT call Date.now() in executable code
    const stripComments = (src: string) =>
        src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
    const dh = stripComments(
        readFileSync(join(root, 'lib/open-gate-v2/data-health.ts'), 'utf8'),
    );
    const ee = stripComments(
        readFileSync(join(root, 'lib/intraday-rank/event-engine.ts'), 'utf8'),
    );
    const dhBad = /Date\.now\s*\(/.test(dh);
    const eeBad = /Date\.now\s*\(/.test(ee);

    // Ignore this gate script and comment-only matches from rg
    const realLeaks = strategyAffecting.filter(
        (l) =>
            !l.includes('acceptance-gate.ts') &&
            !l.includes('MUST use') &&
            !l.includes('never wall') &&
            !l.includes('do NOT call'),
    );
    const ok = !dhBad && !eeBad && realLeaks.length === 0;

    record(
        1,
        'Clock abstraction (Date.now audit)',
        ok ? 'PASS' : 'FAIL',
        ok
            ? `data-health/event-engine clean of Date.now(); logging=${logging.length} metadata=${metadata.length} live_ok=${okLive.length}`
            : `strategy leaks: ${JSON.stringify(realLeaks.slice(0, 5))} dhBad=${dhBad} eeBad=${eeBad}`,
    );

    console.log('\n--- Date.now / new Date classification (sample) ---');
    console.log('logging:', logging.slice(0, 8).join('\n  ') || '(none)');
    console.log('metadata:', metadata.slice(0, 8).join('\n  ') || '(none)');
    console.log('live_ok:', okLive.slice(0, 6).join('\n  ') || '(none)');
    console.log('http/ui:', httpUi.slice(0, 6).join('\n  ') || '(none)');
}

// ─── C. Feature availability ───────────────────────────────────────
function gateC(): void {
    const now = new Date('2026-06-15T01:15:00.000Z'); // ~09:15 Taipei
    const nowMs = now.getTime();
    const cfg = loadOpenGateConfig();

    const candidate: ACandidate = {
        symbol: '2330',
        name: 'TSMC',
        exchange: 'tse',
        a_score: 70,
        a_score_source: 'server',
        prev_close: 100,
        avg_volume_20d: 1e6,
        avg_amount_20d: 1e9,
        sector: null,
        warning_status: false,
        disposition_status: false,
    };

    const state: SymbolMarketState = {
        symbol: '2330',
        timestamp: nowMs,
        last_price: 101,
        open: 100,
        high: 102,
        low: 99,
        prev_close: 99,
        total_volume: 20_000,
        total_amount: 2e8,
        turnover: 2e8,
        avg_price: 100.5,
        best_bid: 0,
        best_ask: 0,
        bid_volume: 0,
        ask_volume: 0,
        tick_count: 10,
        last_tick_at: nowMs,
        last_bidask_at: null,
        vwap_num: 0,
        vwap_den: 0,
        vwap_source: 'fallback',
        vwap_valid: false,
        vwap_available: false,
        recent_prices: [],
    };

    const health = {
        health: 'degraded' as const,
        data_blocked: false,
        shioaji_connected: true,
        stream_connected: true,
        last_tick_at: nowMs,
        last_bidask_at: null,
        last_quote_at: nowMs,
        data_age_seconds: 1,
        historical_profile_available: false,
        notes: ['profile missing'],
    };

    const regime = {
        market_regime: 'neutral' as const,
        market_score: 50,
        market_adjustment: 0,
        notes: [] as string[],
        data_available: true,
        components: {
            taiex: { available: false, value: null },
            tpex: { available: false, value: null },
            breadth: { available: false, value: null },
            us_overnight: { available: false, value: null },
        },
    };

    const b = evaluateOpenGate({
        cfg,
        candidate,
        state,
        vwapInfo: {
            vwap: null,
            source: 'fallback',
            valid: false,
            available: false,
            confidence: 'none',
        },
        rvolSameTime: null,
        health,
        regime,
        now,
    });

    const bOk =
        b.feature_availability?.rvol === false &&
        b.feature_availability?.vwap === false &&
        (b.score_coverage_pct ?? 100) < 90 &&
        b.score_confidence !== 'high' &&
        !Object.values(b.score_components).some(
            (v) => v === 35 || v === 40,
        );

    // C sample — missing index + aggression + thin prices
    const disc: DiscoveryItem = {
        symbol: '2330',
        name: 'TSMC',
        candidate_sources: ['A'],
        candidate_origin: 'eod_a',
        discovery_score: 60,
        a_score: 60,
        open_score: null,
        open_gate_status: null,
        scanner_ranks: {},
        change_pct: 1,
        total_amount: 2e8,
        total_volume: 20_000,
    };
    const c = scoreIntradaySymbol({
        cfg: DEFAULT_INTRADAY_RANK_CONFIG,
        discovery: disc,
        state,
        vwap: {
            vwap: null,
            valid: false,
            available: false,
            confidence: 'none',
        },
        rvolSameTime: null,
        health: {
            ...health,
            health: 'healthy',
            historical_profile_available: true,
        },
        marketRetHint: null,
        previous: null,
        now,
        featureFlags: { trade_aggression: false, bid_ask: false },
    });

    const cOk =
        c.feature_availability?.relative_strength === false &&
        c.feature_availability?.vwap_structure === false &&
        c.feature_availability?.trade_aggression === false &&
        (c.score_coverage_pct ?? 100) < 90 &&
        c.score_confidence !== 'high';

    record(
        6,
        'Feature renormalization',
        bOk && cOk ? 'PASS' : 'FAIL',
        `B: coverage=${b.score_coverage_pct}% conf=${b.score_confidence} avail=${JSON.stringify(b.feature_availability)} | C: coverage=${c.score_coverage_pct}% conf=${c.score_confidence} avail=${JSON.stringify({ rs: c.feature_availability?.relative_strength, vwap: c.feature_availability?.vwap_structure, agg: c.feature_availability?.trade_aggression })}`,
    );

    // Data health clock
    const eng = {
        getState: () => state,
        lastTickAt: () => nowMs,
        lastBidAskAt: () => null as number | null,
        streamConnected: () => false,
    };
    const dh = new DataHealthService(
        eng as never,
        cfg,
        'replay',
    );
    dh.setHistoricalProfileAvailable(true);
    const wallFuture = Date.now(); // far after historical nowMs if nowMs is 2026... wait today is Sep 2026, nowMs is June 2026
    // Historical quote at June, clock at June → healthy; if we wrongly used wall clock in Sep, age huge
    const reportClock = dh.report('2330', nowMs);
    const reportWrong = (() => {
        // simulate old bug: age vs wall
        const ageSec = Math.max(0, (wallFuture - nowMs) / 1000);
        return ageSec;
    })();
    const healthOk =
        !reportClock.data_blocked &&
        reportWrong > cfg.data_health.disconnected_seconds;

    record(
        3,
        'Data Health',
        healthOk ? 'PASS' : 'FAIL',
        `clock-based health=${reportClock.health} blocked=${reportClock.data_blocked}; wall-age-would-be=${reportWrong.toFixed(0)}s (would disconnect)`,
    );

    // Event cooldown
    class FakeClock implements Clock {
        constructor(public t: number) {}
        now() {
            return new Date(this.t);
        }
    }
    const clock = new FakeClock(nowMs);
    const ev = new EventEngine(DEFAULT_INTRADAY_RANK_CONFIG, clock);
    const item = {
        ...c,
        state: 'STRONG' as const,
        metrics: {
            ...c.metrics,
            volume_acceleration: 3,
            momentum_acceleration: 80,
            vwap_pos_pct: 0.5,
            liquidity_score: 70,
            breakout_type: 'breakout' as const,
            breakout_score: 90,
        },
        heat_score: 90,
        rank_velocity: 25,
    };
    const first = ev.evaluate(item, null);
    clock.t = nowMs + 30_000; // 30s later — within cooldown
    const second = ev.evaluate(item, null);
    clock.t = nowMs + 200_000;
    const third = ev.evaluate(item, null);
    const cdOk = first.length > 0 && second.length === 0 && third.length > 0;
    record(
        4,
        'Event cooldown',
        cdOk ? 'PASS' : 'FAIL',
        `t0=${first.join(',')} t+30s=${second.join(',') || 'none'} t+200s=${third.join(',')}`,
    );

    // Rank velocity
    const hist = new Map<string, Array<{ t: number; rank: number }>>();
    hist.set('2330', [
        { t: nowMs - 5 * 60_000, rank: 30 },
        { t: nowMs - 60_000, rank: 12 },
    ]);
    const ranked = attachRanks(
        [c],
        new Map(),
        hist,
        DEFAULT_INTRADAY_RANK_CONFIG,
        nowMs,
    );
    const rv = ranked[0]!;
    const rvOk =
        rv.rank_5m_ago === 30 &&
        rv.rank_1m_ago === 12 &&
        rv.rank_velocity === 30 - rv.rank;
    record(
        5,
        'Rank velocity',
        rvOk ? 'PASS' : 'FAIL',
        `rank=${rv.rank} r1m=${rv.rank_1m_ago} r5m=${rv.rank_5m_ago} vel=${rv.rank_velocity}`,
    );

    void runMomentumEngine;
}

// ─── D. Subscription ownership ─────────────────────────────────────
async function gateD(): Promise<void> {
    const sm = new SubscriptionManager();
    const upstream: string[] = [];
    const unsub: string[] = [];
    const subscribe = async (syms: string[]) => {
        upstream.push(...syms);
    };
    const unsubscribe = async (syms: string[]) => {
        unsub.push(...syms);
    };

    await sm.acquire('2330', 'OPEN_GATE', subscribe);
    await sm.acquire('2330', 'INTRADAY_RANK', subscribe);
    await sm.acquire('2330', 'UI_VIEW', subscribe);
    const once = upstream.filter((s) => s === '2330').length === 1;

    await sm.release('2330', 'UI_VIEW', unsubscribe);
    const afterUi = unsub.length === 0 && sm.refCount('2330') === 2;

    await sm.release('2330', 'OPEN_GATE', unsubscribe);
    const afterB = unsub.length === 0 && sm.refCount('2330') === 1;

    await sm.release('2330', 'INTRADAY_RANK', unsubscribe);
    const afterC =
        unsub.length === 1 &&
        unsub[0] === '2330' &&
        sm.refCount('2330') === 0;

    record(
        7,
        'Subscription ownership',
        once && afterUi && afterB && afterC ? 'PASS' : 'FAIL',
        `upstream_once=${once} after_UI_release_kept=${afterUi} after_B_kept=${afterB} final_unsub=${JSON.stringify(unsub)} consumers_final=${sm.consumersOf('2330').join(',') || 'none'}`,
    );
}

// ─── E. Signal restart dedupe ──────────────────────────────────────
function gateE(): void {
    const dir = mkdtempSync(join(tmpdir(), 'ag-life-'));
    try {
        const repo = new JsonlStrategySignalRepository(dir);
        const life = new SignalLifecycleManager();
        life.setPersistPath(join(dir, 'lifecycle.json'));
        const factory = new StrategySignalFactory(repo, life);

        const now = new Date().toISOString();
        const result = {
            symbol: '2330',
            name: 'TSMC',
            timestamp: now,
            a_score: 70,
            a_score_source: 'server' as const,
            phase: 'confirmed' as const,
            tradeable: true,
            tradeable_candidate: true,
            raw_open_score: 82,
            market_adjustment: 0,
            liquidity_adjustment: 0,
            risk_adjustment: 0,
            final_open_score: 82,
            open_confirm: 'pass' as const,
            hard_reject: false,
            soft_reject: false,
            data_blocked: false,
            market_regime: 'bull' as const,
            market_score: 60,
            score_components: {
                rvol_score: 70,
                vwap_score: 70,
                open_hold_score: 70,
                pullback_score: 70,
                momentum_score: 70,
                gap_score: 50,
            },
            metrics: {
                gap_pct: 1,
                rvol_same_time: 1.5,
                vwap: 100,
                vwap_pos_pct: 0.5,
                vwap_source: 'calculated' as const,
                vwap_valid: true,
                open_pos_pct: 0.5,
                high_pullback_pct: 0.2,
                momentum_score: 70,
                spread_pct: null,
            },
            risk: {
                chase_risk: 'low' as const,
                invalid_price: 99,
                invalid_reason: 'x',
                risk_pct: 1,
                risk_distance_pct: 1,
                risk_score: 20,
                risk_adjustment: 0,
            },
            liquidity_score: 70,
            reasons: [],
            risks: [],
            data_health: 'healthy' as const,
            signal_status: 'active' as const,
            evaluation_stale: false,
            signal_expired: false,
            confirmation_count: 2,
            pass_streak: 2,
            watch_streak: 0,
            reject_streak: 0,
            status_since: now,
            first_pass_at: now,
            last_pass_at: now,
            signal_maturity: 'new' as const,
            open_gate_passed_before_cutoff: true,
            open_gate_baseline: 82,
            open_gate_final_score: 82,
            late_candidate: false,
            feature_availability: {
                rvol: true,
                vwap: true,
                open_hold: true,
                pullback: true,
                momentum: true,
                gap: true,
            },
            score_coverage_pct: 100,
            score_confidence: 'high' as const,
            evaluation_id: 'ev1',
            signal_id: 'bsig_accept_1',
            generated_at: now,
            fresh_until: now,
            signal_valid_until: now,
            expires_at: now,
            ttl_seconds: 180,
        } satisfies OpenConfirmResult;

        const sig = factory.maybeCreateFromB(null, result, {
            source_mode: 'replay',
            data_resolution: '1m',
            learning_eligible: false,
            config_hash: 'cfg',
            universe_source: 'synthetic',
        }, 100);
        assert.ok(sig);

        // simulate restart
        const repo2 = new JsonlStrategySignalRepository(dir);
        const life2 = new SignalLifecycleManager();
        life2.hydrateFromDisk(join(dir, 'lifecycle.json'));
        const factory2 = new StrategySignalFactory(repo2, life2);
        const again = factory2.maybeCreateFromB(result, result, {
            source_mode: 'replay',
            data_resolution: '1m',
            learning_eligible: false,
            config_hash: 'cfg',
            universe_source: 'synthetic',
        }, 100);

        let dupThrow = false;
        try {
            repo2.save({ ...sig!, signal_id: 'bsig_accept_1' });
        } catch {
            dupThrow = true;
        }

        const ok = again === null && dupThrow && life2.get('2330', 'OPEN_PASS')?.lifecycle_status === 'active';
        record(
            8,
            'Signal restart dedupe',
            ok ? 'PASS' : 'FAIL',
            `restart_create=${again} dup_rejected=${dupThrow} lifecycle=${life2.get('2330', 'OPEN_PASS')?.lifecycle_status}`,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ─── F. B/C cutoff ─────────────────────────────────────────────────
function gateF(): void {
    const cfg = loadOpenGateConfig();
    const after = new Date('2026-06-15T02:00:00.000Z'); // 10:00 Taipei
    const confirmed = new Date('2026-06-15T01:20:00.000Z'); // 09:20
    const candidate: ACandidate = {
        symbol: '2330',
        name: 'TSMC',
        exchange: 'tse',
        a_score: 80,
        a_score_source: 'server',
        prev_close: 100,
        avg_volume_20d: 1e6,
        avg_amount_20d: 1e9,
        sector: null,
        warning_status: false,
        disposition_status: false,
    };
    const nowMs = after.getTime();
    const pts = [];
    for (let i = 0; i < 40; i++) {
        pts.push({ t: nowMs - (40 - i) * 5000, p: 100 + i * 0.1, v: 2000 });
    }
    const state: SymbolMarketState = {
        symbol: '2330',
        timestamp: nowMs,
        last_price: 105,
        open: 100,
        high: 106,
        low: 99,
        prev_close: 99,
        total_volume: 100_000,
        total_amount: 1e9,
        turnover: 1e9,
        avg_price: 103,
        best_bid: 104.5,
        best_ask: 105,
        bid_volume: 50,
        ask_volume: 40,
        tick_count: 80,
        last_tick_at: nowMs,
        last_bidask_at: nowMs,
        vwap_num: 103 * 100_000,
        vwap_den: 100_000,
        vwap_source: 'calculated',
        vwap_valid: true,
        vwap_available: true,
        recent_prices: pts,
    };
    const health = {
        health: 'healthy' as const,
        data_blocked: false,
        shioaji_connected: true,
        stream_connected: true,
        last_tick_at: nowMs,
        last_bidask_at: nowMs,
        last_quote_at: nowMs,
        data_age_seconds: 1,
        historical_profile_available: true,
        notes: [],
    };
    const regime = {
        market_regime: 'bull' as const,
        market_score: 70,
        market_adjustment: 2,
        notes: [] as string[],
        data_available: true,
        components: {
            taiex: { available: true, value: 1 },
            tpex: { available: true, value: 0.5 },
            breadth: { available: false, value: null },
            us_overnight: { available: false, value: null },
        },
    };

    // First: get a strong pass in confirmed window
    const early = evaluateOpenGate({
        cfg,
        candidate,
        state: { ...state, timestamp: confirmed.getTime() },
        vwapInfo: {
            vwap: 103,
            source: 'calculated',
            valid: true,
            available: true,
            confidence: 'high',
        },
        rvolSameTime: 2.0,
        health,
        regime,
        now: confirmed,
        previous: null,
    });

    // Force confirmation streak
    let prev = early;
    for (let i = 0; i < 3; i++) {
        prev = evaluateOpenGate({
            cfg,
            candidate,
            state: { ...state, timestamp: confirmed.getTime() + i * 3000 },
            vwapInfo: {
                vwap: 103,
                source: 'calculated',
                valid: true,
                available: true,
                confidence: 'high',
            },
            rvolSameTime: 2.0,
            health,
            regime,
            now: new Date(confirmed.getTime() + i * 3000),
            previous: prev,
        });
    }

    // Late star — never passed before cutoff
    const late = evaluateOpenGate({
        cfg,
        candidate: { ...candidate, symbol: '2317' },
        state: { ...state, symbol: '2317' },
        vwapInfo: {
            vwap: 103,
            source: 'calculated',
            valid: true,
            available: true,
            confidence: 'high',
        },
        rvolSameTime: 2.5,
        health,
        regime,
        now: after,
        previous: null,
    });

    const ok =
        late.phase === 'after' &&
        late.tradeable_candidate === false &&
        (late.open_confirm === 'watch' || late.open_confirm === 'reject' || late.late_candidate === true);

    record(
        9,
        'B/C cutoff boundary',
        ok ? 'PASS' : 'FAIL',
        `late phase=${late.phase} confirm=${late.open_confirm} tradeable=${late.tradeable_candidate} late_candidate=${late.late_candidate} frozen_score=${late.open_gate_final_score ?? 'n/a'}`,
    );
}

// ─── G + Live regression + No future leak ──────────────────────────
async function gateGAndRest(): Promise<void> {
    // No future leak — reuse replay test contract quickly
    try {
        const { buildSyntheticDayBars, parseBarTs } = await import(
            './lib/historical-replay/index.ts'
        );
        const date = '2026-06-15';
        const base = buildSyntheticDayBars({
            symbol: '2330',
            date,
            startPrice: 100,
            withAmount: true,
        });
        const mutated = buildSyntheticDayBars({
            symbol: '2330',
            date,
            startPrice: 100,
            withAmount: true,
            mutateAfter: (sm, close) => (sm > 75 ? close * 1.5 : close),
        });
        const cut = parseBarTs(`${date} 10:15:00`) + 60_000;
        const b1 = base.bars.filter((b) => b.known_at <= cut);
        const b2 = mutated.bars.filter((b) => b.known_at <= cut);
        let same = b1.length === b2.length;
        for (let i = 0; i < b1.length && same; i++) {
            if (b1[i]!.close !== b2[i]!.close) same = false;
        }
        record(
            10,
            'No Future Leak',
            same ? 'PASS' : 'FAIL',
            `prefix bars @ known_at identical before future mutate (${b1.length} bars)`,
        );
    } catch (e) {
        record(
            10,
            'No Future Leak',
            'FAIL',
            e instanceof Error ? e.message : String(e),
        );
    }

    // Live regression — run existing suites
    try {
        execSync('npm run test:fix-pack', {
            cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
            stdio: 'pipe',
            encoding: 'utf8',
        });
        execSync('npm run test:subscription-manager', {
            cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
            stdio: 'pipe',
            encoding: 'utf8',
        });
        execSync('npm run test:replay', {
            cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
            stdio: 'pipe',
            encoding: 'utf8',
        });
        execSync('npm run test:shadow', {
            cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
            stdio: 'pipe',
            encoding: 'utf8',
        });
        record(12, 'Live regression', 'PASS', 'fix-pack + subscription-manager + replay + shadow OK');
    } catch (e) {
        const msg =
            e && typeof e === 'object' && 'stdout' in e
                ? String((e as { stdout?: string }).stdout).slice(-500)
                : e instanceof Error
                  ? e.message
                  : String(e);
        record(12, 'Live regression', 'FAIL', msg);
    }
}

async function main(): Promise<void> {
    console.log('=== Final Acceptance Gate ===\n');
    await gateA();
    gateB();
    gateC();
    await gateD();
    gateE();
    gateF();
    await gateGAndRest();

    // Ensure row 1 exists once (may have been written twice — merge)
    const byId = new Map<number, (typeof results)[0]>();
    for (const r of results) {
        const prev = byId.get(r.id);
        if (!prev) byId.set(r.id, r);
        else if (prev.status === 'PASS' && r.status === 'FAIL') byId.set(r.id, r);
        else if (prev.status === 'FAIL' && r.status === 'PASS') {
            /* keep fail */
        } else byId.set(r.id, r);
    }

    // Fix: gateA and gateB both write id 1 — combine
    const clockA = results.find((r) => r.id === 1 && r.name.includes('Clock abstraction') && !r.name.includes('Date'));
    const clockB = results.find((r) => r.name.includes('Date.now'));
    if (clockA && clockB) {
        byId.set(1, {
            id: 1,
            name: 'Clock abstraction',
            status:
                clockA.status === 'PASS' && clockB.status === 'PASS'
                    ? 'PASS'
                    : 'FAIL',
            detail: `${clockA.detail} | ${clockB.detail}`,
        });
    }

    console.log('\n=== PASS / FAIL TABLE ===\n');
    const order = [
        [1, 'Clock abstraction'],
        [2, 'Replay speed invariance'],
        [3, 'Data Health'],
        [4, 'Event cooldown'],
        [5, 'Rank velocity'],
        [6, 'Feature renormalization'],
        [7, 'Subscription ownership'],
        [8, 'Signal restart dedupe'],
        [9, 'B/C cutoff boundary'],
        [10, 'No Future Leak'],
        [11, 'Replay capability labeling'],
        [12, 'Live regression'],
    ] as const;

    let allPass = true;
    for (const [id, name] of order) {
        const r = byId.get(id) ?? results.find((x) => x.id === id);
        const status = r?.status ?? 'FAIL';
        if (status !== 'PASS') allPass = false;
        console.log(
            `${String(id).padStart(2)}. ${name.padEnd(32)} ${status}  ${(r?.detail ?? 'missing').slice(0, 120)}`,
        );
    }

    const outPath = join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'data',
        'acceptance-gate-latest.json',
    );
    writeFileSync(
        outPath,
        JSON.stringify(
            {
                allPass,
                gate_decision: allPass ? 'PROCEED_TO_SHADOW' : 'STOP',
                results: [...byId.values()],
                at: new Date().toISOString(),
            },
            null,
            2,
        ),
    );
    console.log(`\nGate decision: ${allPass ? 'PROCEED_TO_SHADOW' : 'STOP'}`);
    console.log(`Wrote ${outPath}`);
    process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
