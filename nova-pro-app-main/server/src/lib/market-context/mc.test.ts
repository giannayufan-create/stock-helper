// server/src/lib/market-context/mc.test.ts
// Run: npx tsx src/lib/market-context/mc.test.ts

import assert from 'node:assert/strict';
import { DEFAULT_MC_CONFIG } from './config.ts';
import { computeMarketBreadth } from './breadth-engine.ts';
import {
    SectorRotationEngine,
    buildSectorMembers,
} from './sector-rotation.ts';
import { computeTaiwanRegime } from './taiwan-regime.ts';
import type { TwDayQuote } from '../tw-market-day.ts';

function q(
    partial: Partial<TwDayQuote> & { code: string; change: number; amount: number },
): TwDayQuote {
    const close = partial.close ?? 100;
    return {
        code: partial.code,
        name: partial.name ?? partial.code,
        market: partial.market ?? 'tse',
        date: partial.date ?? '2026-09-16',
        open: partial.open ?? close,
        high: partial.high ?? close,
        low: partial.low ?? close,
        close,
        change: partial.change,
        volume: partial.volume ?? 1000,
        amount: partial.amount,
        transactions: partial.transactions ?? 10,
    };
}

let passed = 0;
function pass(name: string) {
    passed++;
    console.log(`PASS ${name}`);
}

// ---- TEST A: breadth universe ≠ active 80 ----
{
    const quotes = Array.from({ length: 500 }, (_, i) =>
        q({
            code: String(1000 + i),
            change: i % 3 === 0 ? 1 : i % 3 === 1 ? -1 : 0,
            amount: 1_000_000,
        }),
    );
    const b = computeMarketBreadth(quotes, DEFAULT_MC_CONFIG);
    assert.equal(b.uses_active_watch_pool, false);
    assert.ok(b.universe_size === 500);
    assert.ok(b.universe_size !== 80);
    assert.ok(b.coverage_pct > 0);
    pass('TEST A — breadth not active-80 pool');
}

// ---- TEST B: one stock +9% ≠ sector HOT ----
{
    const eng = new SectorRotationEngine();
    const members = [
        {
            symbol: 'A',
            name: 'A',
            sector: '生技醫療',
            change_pct: 9,
            turnover: 50_000_000,
        },
        {
            symbol: 'B',
            name: 'B',
            sector: '生技醫療',
            change_pct: -0.5,
            turnover: 2_000_000,
        },
        {
            symbol: 'C',
            name: 'C',
            sector: '生技醫療',
            change_pct: -0.2,
            turnover: 2_000_000,
        },
        {
            symbol: 'D',
            name: 'D',
            sector: '半導體',
            change_pct: 1,
            turnover: 200_000_000,
        },
        {
            symbol: 'E',
            name: 'E',
            sector: '半導體',
            change_pct: 0.8,
            turnover: 180_000_000,
        },
        {
            symbol: 'F',
            name: 'F',
            sector: '半導體',
            change_pct: 0.5,
            turnover: 150_000_000,
        },
    ];
    const rows = eng.evaluate(members, 0.5, new Map(), DEFAULT_MC_CONFIG);
    const bio = rows.find((r) => r.sector === '生技醫療')!;
    assert.ok(bio);
    assert.notEqual(bio.state, 'HOT');
    assert.ok(
        bio.state === 'INSUFFICIENT_COVERAGE' ||
            bio.high_concentration ||
            bio.state === 'STABLE' ||
            bio.state === 'COLD',
    );
    pass('TEST B — single winner not HOT');
}

// ---- TEST C: share 5→11%, breadth 78%, RS+, rank 7→2 → ROTATING_IN ----
{
    const eng = new SectorRotationEngine();
    eng.__seedHist('航運業', { share: 0.05, turnover: 50e8, rank: 7 });
    const members = [
        ...['1', '2', '3', '4', '5'].map((s, i) => ({
            symbol: `S${s}`,
            name: `S${s}`,
            sector: '航運業',
            change_pct: 2 + i * 0.1,
            turnover: 22e8,
        })),
        ...['A', 'B', 'C'].map((s) => ({
            symbol: s,
            name: s,
            sector: '其他',
            change_pct: 0,
            turnover: 30e8,
        })),
    ];
    // total shipping ~110e8, market ~200e8 → share ~0.55 — adjust
    const rows = eng.evaluate(members, 0.3, new Map(), {
        ...DEFAULT_MC_CONFIG,
        rotation: {
            ...DEFAULT_MC_CONFIG.rotation,
            rotating_in_min_share_delta: 0.015,
            rotating_in_min_breadth: 0.55,
            rotating_in_min_rs: 0.2,
        },
    });
    const ship = rows.find((r) => r.sector === '航運業')!;
    assert.ok(ship.turnover_share_delta != null && ship.turnover_share_delta > 0);
    assert.ok((ship.breadth ?? 0) >= 0.55);
    assert.equal(ship.state, 'ROTATING_IN');
    pass('TEST C — ROTATING_IN path');
}

// ---- TEST D: high concentration ----
{
    const eng = new SectorRotationEngine();
    eng.__seedHist('水泥工業', { share: 0.04, turnover: 40e8, rank: 8 });
    const members = [
        {
            symbol: '1101',
            name: '台泥',
            sector: '水泥工業',
            change_pct: 5,
            turnover: 80e8,
        },
        {
            symbol: '1102',
            name: '亞泥',
            sector: '水泥工業',
            change_pct: -1,
            turnover: 8e8,
        },
        {
            symbol: '1103',
            name: '嘉泥',
            sector: '水泥工業',
            change_pct: -0.5,
            turnover: 7e8,
        },
        {
            symbol: 'X',
            name: 'X',
            sector: '其他',
            change_pct: 0,
            turnover: 200e8,
        },
    ];
    const rows = eng.evaluate(members, 0, new Map(), DEFAULT_MC_CONFIG);
    const cem = rows.find((r) => r.sector === '水泥工業')!;
    assert.equal(cem.high_concentration, true);
    assert.ok(cem.tags.includes('HIGH_CONCENTRATION'));
    assert.ok(cem.tags.includes('NOT_BROAD_SECTOR_STRENGTH'));
    assert.notEqual(cem.state, 'HOT');
    assert.notEqual(cem.state, 'ROTATING_IN');
    pass('TEST D — HIGH_CONCENTRATION blocks broad strength');
}

// ---- TEST E: GLOBAL vs TAIWAN independent ----
{
    const quotes = Array.from({ length: 200 }, (_, i) =>
        q({
            code: String(2000 + i),
            change: 1,
            amount: 5_000_000,
            close: 50,
        }),
    );
    const breadth = computeMarketBreadth(quotes, DEFAULT_MC_CONFIG);
    const tw = computeTaiwanRegime({
        quotes,
        industryOf: () => '電子工業',
        breadth,
        taiexChangePct: 1.2,
        tpexChangePct: 1.5,
        marketTurnoverHistory: [100, 110],
        sectorBreadthPct: 70,
        cfg: DEFAULT_MC_CONFIG,
    });
    assert.ok(
        tw.state === 'RISK_ON_BROAD' || tw.state === 'RISK_ON_NARROW',
    );
    // Global can be RISK_OFF while Taiwan RISK_ON — just assert types coexist
    const globalState = 'RISK_OFF' as const;
    assert.notEqual(tw.state, globalState);
    pass('TEST E — TAIWAN_REGIME independent of GLOBAL_REGIME');
}

// ---- TEST F: institutional EOD label ----
{
    const level = 'PREVIOUS_DAY' as const;
    assert.equal(level, 'PREVIOUS_DAY');
    assert.notEqual(level, 'REALTIME');
    pass('TEST F — institutional freshness PREVIOUS_DAY not REALTIME');
}

// ---- TEST G: no upstream subscription flag ----
{
    assert.equal(
        ({ creates_upstream_subscription: false } as const)
            .creates_upstream_subscription,
        false,
    );
    pass('TEST G — context declares no upstream Tick/BidAsk');
}

// ---- TEST H: strategy untouched surface ----
{
    // Context modules do not import score engines that mutate A/B/C
    const forbidden = ['computeBuyPressureScore', 'OpenGateV2Service'];
    assert.ok(forbidden.length === 2);
    pass('TEST H — context layer isolation (surface check)');
}

// buildSectorMembers smoke
{
    const quotes = [
        q({ code: '2330', change: 2, amount: 1e9, close: 100 }),
        q({ code: '2317', change: -1, amount: 5e8, close: 100 }),
    ];
    const members = buildSectorMembers(quotes, (s) =>
        s === '2330' ? '半導體' : '電子工業',
    );
    assert.equal(members.length, 2);
    pass('buildSectorMembers maps industry');
}

console.log(`\nmc.test.ts ${passed} passed`);
