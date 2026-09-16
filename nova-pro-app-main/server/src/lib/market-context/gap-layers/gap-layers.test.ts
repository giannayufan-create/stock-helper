// server/src/lib/market-context/gap-layers/gap-layers.test.ts

import assert from 'node:assert/strict';
import { evaluateAsiaRegime } from './asia-regime.ts';
import { evaluateIndexConcentration } from './index-concentration.ts';
import { evaluateMacroEventCalendar } from './macro-calendar.ts';
import { evaluatePassiveFlowCalendar } from './passive-flow.ts';
import { evaluatePreOpenAuction } from './preopen-auction.ts';
import { PreOpenBuffer } from './preopen-buffer.ts';
import { evaluateIndustryDrivers } from './industry-drivers.ts';
import type { TwDayQuote } from '../../tw-market-day.ts';

let passed = 0;
function pass(name: string) {
    passed += 1;
    console.log(`  PASS  ${name}`);
}

console.log('gap-layers tests');

{
    PreOpenBuffer.clear();
    const out = evaluatePreOpenAuction(new Date().toISOString());
    assert.equal(out.layer, 'PreOpenAuctionContext');
    assert.ok(out.completeness === 'PARTIAL' || out.completeness === 'UNAVAILABLE' || out.available);
    // No fake prices when buffer empty
    if (!out.available) {
        assert.equal(out.data.simulated_match_price, null);
    }
    pass('PreOpen: no fabricated prices when empty');
}

{
    const quotes: TwDayQuote[] = [];
    for (let i = 0; i < 80; i++) {
        quotes.push({
            code: String(1000 + i),
            name: `T${i}`,
            market: i % 2 ? 'otc' : 'tse',
            date: '2026-03-16',
            open: 100,
            high: 105,
            low: 99,
            close: 100 + (i < 10 ? 5 : 0.5),
            change: i < 10 ? 5 : 0.5,
            volume: 1000,
            amount: 1_000_000 * (80 - i),
            transactions: 10,
        });
    }
    const out = evaluateIndexConcentration(quotes, 60, new Date().toISOString());
    assert.equal(out.proxy, true);
    assert.equal(out.data.weight_source, 'PROXY_TURNOVER');
    assert.ok(out.data.state !== 'UNAVAILABLE');
    pass('IndexConcentration: PROXY labeled');
}

{
    const out = evaluateAsiaRegime(
        [
            {
                id: 'nikkei',
                name: 'Nikkei',
                value: 1,
                change: 1,
                change_pct: 1.2,
                timestamp: null,
                source: 'yahoo',
                freshness: 'delayed',
                status: 'OK',
            },
            {
                id: 'kospi',
                name: 'KOSPI',
                value: 1,
                change: 1,
                change_pct: 0.8,
                timestamp: null,
                source: 'yahoo',
                freshness: 'delayed',
                status: 'OK',
            },
            {
                id: 'hsi',
                name: 'HSI',
                value: 1,
                change: 1,
                change_pct: 0.6,
                timestamp: null,
                source: 'yahoo',
                freshness: 'delayed',
                status: 'OK',
            },
        ],
        'RISK_ON_BROAD',
        new Date().toISOString(),
    );
    assert.equal(out.data.state, 'ASIA_RISK_ON');
    assert.equal(out.data.vs_taiwan, 'ASIA_CONFIRMED');
    pass('AsiaRegime vs Taiwan CONFIRMED');
}

{
    const out = evaluateMacroEventCalendar(new Date().toISOString());
    assert.ok(out.available);
    assert.ok(out.data.upcoming.length > 0);
    pass('MacroEventCalendar curated load');
}

{
    const out = evaluatePassiveFlowCalendar(new Date().toISOString());
    assert.ok(out.note?.includes('BuyPressure') || out.data.note.includes('BP'));
    pass('PassiveFlow: BP isolation note');
}

{
    const out = evaluateIndustryDrivers([], new Date().toISOString());
    const dram = out.data.drivers.find((d) => d.driver === 'DRAM');
    assert.equal(dram?.available, false);
    const scfi = out.data.drivers.find((d) => d.driver === 'SCFI');
    assert.equal(scfi?.available, false);
    pass('IndustryDrivers: DRAM/SCFI unavailable (no guess)');
}

console.log(`\ngap-layers: ${passed} passed`);
