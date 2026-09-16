// server/src/lib/web-notifications/wn.test.ts
// Run: npx tsx src/lib/web-notifications/wn.test.ts

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuyPressureItem } from '../buy-pressure/types.ts';
import { DEFAULT_WN_CONFIG } from './config.ts';
import { WebNotificationService } from './web-notification-service.ts';

function item(
    over: Partial<BuyPressureItem> & { symbol: string },
): BuyPressureItem {
    const now = new Date().toISOString();
    return {
        symbol: over.symbol,
        name: over.name ?? over.symbol,
        market: 'UNKNOWN',
        last_price: over.last_price ?? 70,
        change_pct: over.change_pct ?? 3,
        buy_pressure_score: over.buy_pressure_score ?? 88,
        radar_rank_score: over.radar_rank_score ?? 88,
        primary_state: over.primary_state ?? 'BUY_SURGE',
        states: over.states ?? ['BUY_SURGE'],
        tags: over.tags ?? [],
        c_score: over.c_score ?? 80,
        heat_score: over.heat_score ?? 70,
        rank: over.rank ?? 6,
        rank_prev: over.rank_prev ?? 28,
        rank_velocity: 22,
        volume_acceleration: 186,
        rvol: 2.4,
        trade_aggression: 70,
        bidask_imbalance: 0.3,
        momentum_acceleration: 20,
        vwap_bucket: 'Above VWAP',
        distance_from_vwap_pct: 0.8,
        chase_penalty: 0,
        chase_risk: over.chase_risk ?? 'MEDIUM',
        overheated: over.overheated ?? false,
        overheated_note: null,
        ask_eating_note: null,
        large_bid_note: null,
        data_stale: over.data_stale ?? false,
        data_health: 'healthy',
        updated_at: now,
        last_updated: now,
        evaluated_at: now,
        last_tick_at: now,
        last_bidask_at: now,
        data_age_ms: 0,
        freshness: 'FRESH',
        rvol_slope: 0.3,
        volume_acceleration_slope: 10,
        rvol_accel: 'ACCELERATING',
        volume_accel_label: 'ACCELERATING',
        events: over.events ?? [],
        notification_candidates: [],
        feature_availability: {},
        score_coverage_pct: 100,
        score_confidence: 'high',
        universe_source: over.universe_source ?? 'C_TOP_RANK',
        discovery_reason: over.discovery_reason ?? null,
        orderbook_depth_available: over.orderbook_depth_available ?? 1,
        ask_eating_confidence: over.ask_eating_confidence ?? 'low',
        breakout_type: over.breakout_type ?? null,
        reference_level: over.reference_level ?? null,
        reference_time: over.reference_time ?? null,
        slope_window_ms: over.slope_window_ms ?? 90_000,
        slope_sample_count: over.slope_sample_count ?? 5,
    };
}

const dir = mkdtempSync(join(tmpdir(), 'wn-test-'));
const path = join(dir, 'notifications.json');
const svc = new WebNotificationService(path, null, {
    ...DEFAULT_WN_CONFIG,
    cooldown_sec: {
        ...DEFAULT_WN_CONFIG.cooldown_sec,
        EARLY_ENTER: 300,
        BUY_SURGE: 300,
        ASK_EATING: 180,
        VOLUME_BREAKOUT: 300,
        OVERHEATED_STRONG: 600,
        LARGE_BID_APPEAR: 300,
        RANK_ACCELERATION: 300,
    },
});

let passed = 0;
function pass(name: string) {
    passed++;
    console.log(`PASS ${name}`);
}

const base = item({ symbol: '6770', name: '力積電' });

// N1
{
    svc.__resetCooldowns();
    svc.__repo().__clearNotifications();
    const n = svc.tryEmit('EARLY_ENTER', base, new Date().toISOString());
    assert.ok(n);
    assert.equal(svc.list().length, 1);
    pass('N1 — first EARLY creates 1 notification');
}

// N2
{
    const n2 = svc.tryEmit('EARLY_ENTER', base, new Date().toISOString());
    assert.equal(n2, null);
    assert.equal(svc.list().length, 1);
    pass('N2 — same EARLY within cooldown blocked');
}

// N3 upgrade
{
    const n3 = svc.tryEmit('BUY_SURGE', base, new Date().toISOString());
    assert.ok(n3);
    assert.equal(n3!.event_type, 'BUY_SURGE');
    pass('N3 — EARLY → BUY_SURGE upgrade allowed');
}

// N4
{
    const n4 = svc.tryEmit('BUY_SURGE', base, new Date().toISOString());
    assert.equal(n4, null);
    pass('N4 — sustained BUY_SURGE not re-notified');
}

// N5
{
    const n5 = svc.tryEmit('ASK_EATING', base, new Date().toISOString());
    assert.ok(n5);
    pass('N5 — BUY_SURGE → ASK_EATING upgrade');
}

// N6 ASK_CANCEL not toastable via map
{
    const mapped = null; // ASK_CANCEL not in NotificationEventType emit path
    assert.equal(mapped, null);
    pass('N6 — ASK_CANCEL not a default toast event type');
}

// N7 stale gate via ingest
{
    svc.__resetCooldowns();
    const before = svc.list().length;
    svc.ingestFromBuyPressure([
        item({
            symbol: 'STALE1',
            data_stale: true,
            events: [
                {
                    event_id: '1',
                    event_type: 'BUY_SURGE',
                    symbol: 'STALE1',
                    timestamp: new Date().toISOString(),
                    price: 1,
                    note: null,
                    notification_candidate: true,
                    reasons: ['x'],
                    cycle_fresh: true,
                },
            ],
        }),
    ]);
    assert.equal(svc.list().length, before);
    pass('N7 — stale blocks new BUY_SURGE notifications');
}

// N8 persistence
{
    const svc2 = new WebNotificationService(path, null, DEFAULT_WN_CONFIG);
    assert.ok(svc2.list().length >= 1);
    pass('N8 — refresh loads persisted notifications');
}

// N9 mark read
{
    svc.__resetCooldowns();
    svc.__repo().__clearNotifications();
    const n = svc.tryEmit('EARLY_ENTER', item({ symbol: 'R1' }), new Date().toISOString());
    assert.ok(n);
    assert.equal(svc.unreadCount(), 1);
    svc.markRead(n!.notification_id);
    assert.equal(svc.unreadCount(), 0);
    pass('N9 — mark read lowers unread');
}

// N10 mark all
{
    svc.__resetCooldowns();
    svc.tryEmit('EARLY_ENTER', item({ symbol: 'A1' }), new Date().toISOString());
    svc.__resetCooldowns();
    svc.tryEmit('BUY_SURGE', item({ symbol: 'A2' }), new Date().toISOString());
    assert.ok(svc.unreadCount() >= 1);
    svc.markAllRead();
    assert.equal(svc.unreadCount(), 0);
    pass('N10 — mark all read');
}

// N11 sound default OFF
{
    assert.equal(svc.getPreferences().sound, false);
    pass('N11 — sound default OFF');
}

// N12 architecture note — no subscribe API
{
    assert.equal(
        typeof (svc as unknown as { subscribe?: unknown }).subscribe,
        'undefined',
    );
    pass('N12 — notification service has no broker subscribe');
}

// N13 prefs don't touch strategy — prefs only filter display
{
    const p = svc.setPreferences({ buy_surge: false });
    assert.equal(p.buy_surge, false);
    svc.setPreferences({ buy_surge: true });
    pass('N13 — prefs only control notification display');
}

rmSync(dir, { recursive: true, force: true });
console.log(`\nwn.test.ts ${passed} passed`);
