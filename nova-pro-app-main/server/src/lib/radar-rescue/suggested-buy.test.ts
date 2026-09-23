// server/src/lib/radar-rescue/suggested-buy.test.ts
import { computeSuggestedBuy } from './suggested-buy.ts';

function assert(cond: boolean, msg: string): void {
    if (!cond) throw new Error(`FAIL: ${msg}`);
    console.log(`PASS: ${msg}`);
}

{
    const s = computeSuggestedBuy({
        state: 'EARLY',
        dataStale: false,
        lastPrice: 100.5,
        vwap: 99.8,
        breakoutPrice: null,
        triggerPrice: 100,
        chaseRisk: 'LOW',
    });
    assert(s != null && s.price > 0, 'EARLY has suggested buy');
    assert(!!s!.note.includes('漲3%前') || !!s!.note.includes('VWAP'), 'EARLY note');
}

{
    const s = computeSuggestedBuy({
        state: 'PRE_ATTACK',
        dataStale: false,
        lastPrice: 101.2,
        vwap: 100,
        breakoutPrice: 101,
        triggerPrice: 100,
        chaseRisk: 'MEDIUM',
    });
    assert(s != null, 'PRE_ATTACK has buy');
    assert(s!.price >= 101, 'PRE_ATTACK >= breakout');
    assert(s!.note.includes('突破'), 'PRE_ATTACK note');
}

{
    const s = computeSuggestedBuy({
        state: 'ACTIVE',
        dataStale: false,
        lastPrice: 105,
        vwap: 100,
        breakoutPrice: 101,
        triggerPrice: 100,
        chaseRisk: 'HIGH',
    });
    assert(s != null && s.price <= 105, 'ACTIVE pullback <= last');
    assert(s!.note.includes('回檔') || s!.note.includes('勿追'), 'ACTIVE note');
}

{
    const s = computeSuggestedBuy({
        state: 'EARLY_FAILED',
        dataStale: false,
        lastPrice: 100,
        vwap: 99,
        breakoutPrice: null,
        triggerPrice: 100,
        chaseRisk: 'LOW',
    });
    assert(s == null, 'FAILED → no buy');
}

{
    const s = computeSuggestedBuy({
        state: 'ACTIVE',
        dataStale: true,
        lastPrice: 105,
        vwap: 100,
        breakoutPrice: 101,
        triggerPrice: 100,
        chaseRisk: 'LOW',
    });
    assert(s == null, 'stale → no buy');
}

console.log('suggested-buy checks done');
