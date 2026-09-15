// server/src/lib/broker-intelligence/bi.test.ts
// Run: npx tsx src/lib/broker-intelligence/bi.test.ts

import assert from 'node:assert/strict';
import { computeAlignment } from './alignment.ts';
import { computeConcentration } from './branch/branch-concentration-engine.ts';
import { buildBranchHistory } from './branch/branch-history-engine.ts';
import {
    MemoryBrokerBranchProvider,
    UnavailableBrokerBranchProvider,
} from './broker-provider.ts';
import { DEFAULT_BI_CONFIG } from './config.ts';
import { estimateMainForce } from './main-force/main-force-engine.ts';
import type { BranchDayBundle, BranchTradeRow } from './types.ts';

function row(
    partial: Partial<BranchTradeRow> & {
        broker_id: string;
        branch_id: string;
        net_volume: number;
    },
): BranchTradeRow {
    const buy = partial.buy_volume ?? Math.max(0, partial.net_volume);
    const sell = partial.sell_volume ?? Math.max(0, -partial.net_volume);
    return {
        symbol: partial.symbol ?? '2367',
        trade_date: partial.trade_date ?? '2026-03-10',
        broker_id: partial.broker_id,
        broker_name: partial.broker_name ?? `B${partial.broker_id}`,
        branch_id: partial.branch_id,
        branch_name: partial.branch_name ?? `Br${partial.branch_id}`,
        buy_volume: buy,
        sell_volume: sell,
        net_volume: partial.net_volume,
        buy_amount: partial.buy_amount ?? null,
        sell_amount: partial.sell_amount ?? null,
        net_amount: partial.net_amount ?? null,
        amount_available: partial.amount_available ?? false,
        source: partial.source ?? 'memory_test',
        updated_at: partial.updated_at ?? new Date().toISOString(),
        freshness: partial.freshness ?? 'EOD',
    };
}

function day(date: string, rows: BranchTradeRow[]): BranchDayBundle {
    return {
        symbol: '2367',
        trade_date: date,
        freshness: 'EOD',
        source: 'memory_test',
        rows,
        available: true,
        error: null,
    };
}

async function testA_unavailable(): Promise<void> {
    const p = new UnavailableBrokerBranchProvider();
    const b = await p.getBranchTrading('2367');
    assert.equal(b.available, false);
    assert.equal(b.rows.length, 0);
    assert.ok(b.error?.includes('尚未接入'));
    console.log('PASS Test A (unavailable no fake names)');
}

function testB_eodNotLive(): void {
    const bundle = day('2026-03-10', [
        row({ broker_id: '1', branch_id: 'a', net_volume: 1000 }),
    ]);
    assert.equal(bundle.freshness, 'EOD');
    assert.notEqual(bundle.freshness, 'INTRADAY');
    console.log('PASS Test B (EOD not LIVE)');
}

function testC_noIdentityClaim(): void {
    const align = computeAlignment({
        mainForce: {
            score: null,
            label: 'UNKNOWN',
            method: 'branch_concentration_estimate',
            inferred: true,
            confidence: 'LOW',
            reasons: [],
        },
        cScore: 90,
        state: 'STRONG',
        events: ['SURGE'],
        stockHeat: 95,
        cfg: DEFAULT_BI_CONFIG,
        branchAvailable: false,
    });
    assert.equal(align.alignment, 'UNKNOWN');
    assert.ok(!/法人正在買|主力正在買/.test(align.note));
    console.log('PASS Test C (no false identity)');
}

function testD_consecutive(): void {
    const days = [
        day('2026-03-10', [
            row({
                broker_id: '1',
                branch_id: 'a',
                net_volume: 500,
                trade_date: '2026-03-10',
            }),
        ]),
        day('2026-03-09', [
            row({
                broker_id: '1',
                branch_id: 'a',
                net_volume: 400,
                trade_date: '2026-03-09',
            }),
        ]),
        day('2026-03-08', [
            row({
                broker_id: '1',
                branch_id: 'a',
                net_volume: 300,
                trade_date: '2026-03-08',
            }),
        ]),
        day('2026-03-07', [
            row({
                broker_id: '1',
                branch_id: 'a',
                net_volume: 200,
                trade_date: '2026-03-07',
            }),
        ]),
        day('2026-03-06', [
            row({
                broker_id: '1',
                branch_id: 'a',
                net_volume: 100,
                trade_date: '2026-03-06',
            }),
        ]),
    ];
    const hist = buildBranchHistory('2367', days, 5, DEFAULT_BI_CONFIG);
    assert.equal(hist.insufficient, false);
    assert.equal(hist.rows[0]!.consecutive_buy_days, 5);
    console.log('PASS Test D (consecutive 5)');
}

function testE_insufficient(): void {
    const days = [
        day('2026-03-10', [
            row({ broker_id: '1', branch_id: 'a', net_volume: 100 }),
        ]),
        day('2026-03-09', [
            row({ broker_id: '1', branch_id: 'a', net_volume: 100 }),
        ]),
    ];
    const hist10 = buildBranchHistory('2367', days, 10, DEFAULT_BI_CONFIG);
    assert.equal(hist10.insufficient, true);
    const hist20 = buildBranchHistory('2367', days, 20, DEFAULT_BI_CONFIG);
    assert.equal(hist20.insufficient, true);
    console.log('PASS Test E (insufficient 10D/20D)');
}

function testF_lowVolumeConfidence(): void {
    const tiny = day('2026-03-10', [
        row({ broker_id: '1', branch_id: 'a', net_volume: 10, buy_volume: 10 }),
        row({ broker_id: '2', branch_id: 'b', net_volume: 1, buy_volume: 1 }),
        row({ broker_id: '3', branch_id: 'c', net_volume: 1, buy_volume: 1 }),
    ]);
    const conc = computeConcentration(tiny, DEFAULT_BI_CONFIG);
    assert.equal(conc.eligible_for_ranking, false);
    const mf = estimateMainForce({
        concentration: conc,
        history: null,
        cfg: DEFAULT_BI_CONFIG,
    });
    assert.notEqual(mf.confidence, 'HIGH');
    console.log('PASS Test F (low volume → not HIGH)');
}

function testJ_alignmentNoBuy(): void {
    const align = computeAlignment({
        mainForce: {
            score: 85,
            label: 'HIGH',
            method: 'branch_concentration_estimate',
            inferred: true,
            confidence: 'HIGH',
            reasons: [],
        },
        cScore: 89,
        state: 'STRONG',
        events: ['REBREAK'],
        stockHeat: 94,
        cfg: DEFAULT_BI_CONFIG,
        branchAvailable: true,
    });
    assert.equal(align.alignment, 'BULLISH_ALIGNMENT');
    assert.ok(!/建議買進|必漲|進場點|BUY signal/i.test(align.note));
    assert.ok(align.note.includes('非進場'));
    console.log('PASS Test J (alignment not buy signal)');
}

async function testMemoryProvider(): Promise<void> {
    const mem = new MemoryBrokerBranchProvider([
        day('2026-03-10', [
            row({ broker_id: '1', branch_id: 'a', net_volume: 1000 }),
        ]),
    ]);
    const t = await mem.getTopBranches('2367', '2026-03-10', 'buy', 5);
    assert.equal(t.available, true);
    assert.equal(t.rows[0]!.broker_name.length > 0, true);
    console.log('PASS memory provider smoke');
}

await testA_unavailable();
testB_eodNotLive();
testC_noIdentityClaim();
testD_consecutive();
testE_insufficient();
testF_lowVolumeConfidence();
testJ_alignmentNoBuy();
await testMemoryProvider();
console.log('\nBI unit tests passed.');
