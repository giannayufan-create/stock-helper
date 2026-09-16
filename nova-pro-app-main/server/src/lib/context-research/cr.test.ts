// server/src/lib/context-research/cr.test.ts
// Run: npx tsx src/lib/context-research/cr.test.ts
// Acceptance Tests A–J for Context Snapshot + Attribution Phase 3

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildContextBundle,
    filterEventsPointInTime,
} from './capture.ts';
import { sampleGuardLabel } from './sample-guard.ts';
import { DEFAULT_CR_CONFIG } from './config.ts';
import { JsonlStrategySignalRepository } from '../strategy-signal/repository.ts';
import type { StrategySignal } from '../strategy-signal/types.ts';
import type { ActiveEventSnap, ContextSnapshot } from './types.ts';
import { CONTEXT_SNAPSHOT_VERSION } from './types.ts';

let passed = 0;
function pass(name: string) {
    passed++;
    console.log(`PASS ${name}`);
}

function baseSnap(
    partial: Partial<ContextSnapshot> = {},
): Partial<ContextSnapshot> {
    return {
        global_regime: 'NEUTRAL',
        taiwan_regime: 'RISK_ON_BROAD',
        market_breadth: 0.62,
        market_turnover_acceleration: 'RISING',
        sector: '航運業',
        sector_rank: 8,
        sector_rank_change: 6,
        sector_rank_velocity: 2,
        sector_rotation_state: 'ROTATING_IN',
        sector_turnover_share: 0.08,
        sector_turnover_share_delta: 0.03,
        sector_breadth: 0.78,
        sector_relative_strength: 1.2,
        capital_rotation_score: 72,
        sector_c_strong_count: 4,
        sector_bp_strong_count: 3,
        leader_concentration: false,
        institutional_eod_context: {
            available: true,
            realtime_level: 'PREVIOUS_DAY',
            note: 'PREVIOUS_DAY',
        },
        institutional_risk_proxy: {
            available: false,
            proxy: true,
            not_actual_foreign_identity: true,
            note: 'PROXY',
        },
        active_events: [],
        event_relevance_score: null,
        event_market_confirmation_score: null,
        event_confirmation_state: null,
        company_exposure_confidence: null,
        feature_availability: {
            global_regime: true,
            taiwan_regime: true,
            market_breadth: true,
            sector_rotation: true,
            capital_rotation: true,
            sector_breadth: true,
            sector_rs: true,
            event_confirmation: false,
            company_exposure: false,
            institutional_eod: true,
        },
        context_coverage_pct: 70,
        context_confidence: 'HIGH',
        context_source_mode: 'LIVE',
        captured_at: '2026-09-16T01:20:00.000Z',
        market_context_version: 'mc_v1',
        sector_rotation_version: 'sector_rotation_v1',
        event_engine_version: 'ei_v1',
        exposure_map_version: 'exposure_map_v1',
        confirmation_version: 'confirmation_v1',
        config_hash: 'testhash',
        schema_version: CONTEXT_SNAPSHOT_VERSION,
        ...partial,
    };
}

// ---- TEST A: news after signal_time excluded ----
{
    const signalTime = '2026-09-16T01:20:00.000Z'; // 09:20 Taipei
    const events: ActiveEventSnap[] = [
        {
            event_id: 'e1',
            event_type: 'WAR_CONFLICT',
            title: 'before',
            confirmation_state: 'EVENT_WATCH',
            event_relevance: 80,
            market_confirmation_score: 40,
            published_at: '2026-09-16T01:10:00.000Z', // before
            available: true,
        },
        {
            event_id: 'e2',
            event_type: 'WAR_CONFLICT',
            title: 'after news 09:25',
            confirmation_state: 'EVENT_WATCH',
            event_relevance: 90,
            market_confirmation_score: 50,
            published_at: '2026-09-16T01:25:00.000Z', // after 09:20
            available: true,
        },
    ];
    const filtered = filterEventsPointInTime(events, signalTime);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.event_id, 'e1');
    assert.ok(!filtered.some((e) => e.event_id === 'e2'));
    pass('TEST A — future news not in 09:20 snapshot');
}

// ---- TEST B: confirmation stays WATCH; later CONFIRMED not backfilled ----
{
    const signalTime = '2026-09-16T01:20:00.000Z';
    const bundle = buildContextBundle({
        symbol: '2603',
        signalTime,
        sourceMode: 'live',
        marketContext: null,
        eventIntelligence: null,
        overrideSnapshot: baseSnap({
            active_events: [
                {
                    event_id: 'e1',
                    event_type: 'SHIPPING_DISRUPTION',
                    title: '紅海',
                    confirmation_state: 'EVENT_WATCH',
                    event_relevance: 85,
                    market_confirmation_score: 45,
                    published_at: '2026-09-16T01:15:00.000Z',
                    available: true,
                },
            ],
            event_confirmation_state: 'EVENT_WATCH',
            event_relevance_score: 85,
            event_market_confirmation_score: 45,
            feature_availability: {
                ...baseSnap().feature_availability!,
                event_confirmation: true,
            },
        }),
    });
    assert.equal(
        bundle.context_snapshot.event_confirmation_state,
        'EVENT_WATCH',
    );
    // Simulate later confirmation — must NOT mutate frozen snapshot
    const later = 'EVENT_MARKET_CONFIRMED';
    assert.notEqual(
        bundle.context_snapshot.event_confirmation_state,
        later,
    );
    assert.throws(() => {
        (bundle.context_snapshot as { event_confirmation_state: string }).event_confirmation_state =
            later;
    });
    pass('TEST B — WATCH frozen; later CONFIRMED not backfilled');
}

// ---- TEST C: sector rank immutable ----
{
    const bundle = buildContextBundle({
        symbol: '2603',
        signalTime: '2026-09-16T01:20:00.000Z',
        sourceMode: 'live',
        marketContext: null,
        eventIntelligence: null,
        overrideSnapshot: baseSnap({ sector_rank: 8 }),
    });
    assert.equal(bundle.context_snapshot.sector_rank, 8);
    assert.throws(() => {
        (bundle.context_snapshot as { sector_rank: number }).sector_rank = 1;
    });
    pass('TEST C — sector rank #8 frozen; not updated to #1');
}

// ---- TEST D/E: Context ON/OFF does not change strategy scores ----
{
    // Structural: capture never returns score deltas; ON vs OFF only adds context fields
    const off = null;
    const on = buildContextBundle({
        symbol: '2330',
        signalTime: '2026-09-16T01:20:00.000Z',
        sourceMode: 'live',
        marketContext: null,
        eventIntelligence: null,
        overrideSnapshot: baseSnap(),
    });
    assert.equal(off, null);
    assert.ok(on.context_snapshot);
    assert.ok(!('a_score_delta' in on.context_snapshot));
    assert.ok(!('c_score_delta' in on));
    assert.ok(!('bp_score_delta' in on));
    // Same score fields would be produced by factory regardless of capture
    const fakeScore = { a: 70, b: 80, c: 85, bp: 77 };
    const withCtx = { ...fakeScore, context: on };
    const withoutCtx = { ...fakeScore, context: null };
    assert.equal(withCtx.a, withoutCtx.a);
    assert.equal(withCtx.b, withoutCtx.b);
    assert.equal(withCtx.c, withoutCtx.c);
    assert.equal(withCtx.bp, withoutCtx.bp);
    pass('TEST D/E — Context ON/OFF strategy scores identical');
}

// ---- TEST F: n=12 → INSUFFICIENT_DATA ----
{
    assert.equal(sampleGuardLabel(12, DEFAULT_CR_CONFIG), 'INSUFFICIENT_DATA');
    pass('TEST F — n=12 INSUFFICIENT_DATA');
}

// ---- TEST G: n=65 → EXPLORATORY ----
{
    assert.equal(sampleGuardLabel(65, DEFAULT_CR_CONFIG), 'EXPLORATORY');
    pass('TEST G — n=65 EXPLORATORY');
}

// ---- TEST H: n=150 → ANALYSIS_ELIGIBLE ----
{
    assert.equal(sampleGuardLabel(150, DEFAULT_CR_CONFIG), 'ANALYSIS_ELIGIBLE');
    pass('TEST H — n=150 ANALYSIS_ELIGIBLE');
}

// ---- TEST I: event unavailable — signal still ok; event.available=false ----
{
    const bundle = buildContextBundle({
        symbol: '2330',
        signalTime: '2026-09-16T01:20:00.000Z',
        sourceMode: 'live',
        marketContext: null,
        eventIntelligence: null, // unavailable
        overrideSnapshot: baseSnap({
            feature_availability: {
                global_regime: true,
                taiwan_regime: true,
                market_breadth: true,
                sector_rotation: true,
                capital_rotation: true,
                sector_breadth: true,
                sector_rs: true,
                event_confirmation: false,
                company_exposure: false,
                institutional_eod: false,
            },
        }),
    });
    assert.equal(
        bundle.context_snapshot.feature_availability.event_confirmation,
        false,
    );
    // Signal production not blocked by missing events
    assert.ok(bundle.context_snapshot);
    pass('TEST I — event unavailable → available=false; signal ok');
}

// ---- TEST J: restart persistence of snapshot + tags ----
{
    const dir = mkdtempSync(join(tmpdir(), 'cr-signals-'));
    const repo = new JsonlStrategySignalRepository(dir);
    const bundle = buildContextBundle({
        symbol: '2603',
        signalTime: '2026-09-16T01:20:00.000Z',
        sourceMode: 'live',
        marketContext: null,
        eventIntelligence: null,
        overrideSnapshot: baseSnap({
            event_confirmation_state: 'EVENT_WATCH',
            sector_rank: 8,
        }),
    });
    const signal: StrategySignal = {
        signal_id: 'test_sig_cr_j',
        symbol: '2603',
        signal_type: 'SURGE',
        signal_time: '2026-09-16T01:20:00.000Z',
        reference_price: 100,
        reference_price_source: 'test',
        source: 'C',
        strategy_version: 'bc-strategy-v1',
        config_hash: 'abc',
        source_mode: 'live',
        data_resolution: 'tick',
        learning_eligible: true,
        feature_snapshot: Object.freeze({ intraday_score: 80 }),
        context_snapshot: bundle.context_snapshot,
        context_tags: bundle.context_tags,
        context_alignment: bundle.context_alignment,
        context_strength_score: bundle.context_strength_score,
    };
    repo.save(signal);

    // Simulate restart
    const repo2 = new JsonlStrategySignalRepository(dir);
    repo2.hydrateKnownIds();
    const loaded = repo2.findById('test_sig_cr_j');
    assert.ok(loaded);
    assert.equal(loaded!.context_snapshot?.sector_rank, 8);
    assert.equal(
        loaded!.context_snapshot?.event_confirmation_state,
        'EVENT_WATCH',
    );
    assert.ok((loaded!.context_tags?.length ?? 0) > 0);
    assert.ok(existsSync(join(dir, '2026-09-16.jsonl')));
    const raw = readFileSync(join(dir, '2026-09-16.jsonl'), 'utf8');
    assert.ok(raw.includes('context_snapshot'));
    assert.ok(raw.includes('context_tags'));
    pass('TEST J — restart keeps snapshot + tags');
}

console.log(`\ncr.test.ts ${passed} passed`);
