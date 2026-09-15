// server/src/lib/intraday-rank/event-engine.ts
// Cooldown / last_event_time MUST use strategy Clock — never wall Date.now().

import type { Clock } from '../market-runtime/clock.ts';
import type { IntradayRankConfig } from './config.ts';
import type {
    IntradayEvent,
    IntradayEventType,
    IntradayRankItem,
} from './types.ts';

export class EventEngine {
    private lastFired = new Map<string, number>(); // `${symbol}:${type}` → ms
    private recent: IntradayEvent[] = [];
    private clock: Clock;

    constructor(cfg: IntradayRankConfig, clock: Clock) {
        this.cfg = cfg;
        this.clock = clock;
    }

    private cfg: IntradayRankConfig;

    setConfig(cfg: IntradayRankConfig): void {
        this.cfg = cfg;
    }

    setClock(clock: Clock): void {
        this.clock = clock;
    }

    getRecent(limit = 50): IntradayEvent[] {
        return this.recent.slice(-limit).reverse();
    }

    clear(): void {
        this.lastFired.clear();
        this.recent = [];
    }

    /** Hydrate cooldown map from persisted ms timestamps. */
    hydrateCooldowns(entries: Array<{ key: string; lastMs: number }>): void {
        for (const e of entries) this.lastFired.set(e.key, e.lastMs);
    }

    snapshotCooldowns(): Array<{ key: string; lastMs: number }> {
        return [...this.lastFired.entries()].map(([key, lastMs]) => ({
            key,
            lastMs,
        }));
    }

    private nowMs(): number {
        return this.clock.now().getTime();
    }

    private canFire(symbol: string, type: IntradayEventType): boolean {
        const key = `${symbol}:${type}`;
        const last = this.lastFired.get(key) ?? 0;
        const cd = (this.cfg.event_cooldowns_sec[type] ?? 120) * 1000;
        return this.nowMs() - last >= cd;
    }

    private fire(
        item: IntradayRankItem,
        type: IntradayEventType,
        strength: number,
    ): IntradayEvent | null {
        if (!this.canFire(item.symbol, type)) return null;
        if (item.data_blocked) {
            if (
                type === 'SURGE' ||
                type === 'BREAKOUT' ||
                type === 'REBREAK'
            ) {
                return null;
            }
        }
        const ts = this.nowMs();
        this.lastFired.set(`${item.symbol}:${type}`, ts);
        const ev: IntradayEvent = {
            event_id: `evt_${ts}_${item.symbol}_${type}`,
            event_type: type,
            symbol: item.symbol,
            name: item.name,
            strength,
            price_at_event: null,
            rank: item.rank,
            intraday_score: item.intraday_score,
            heat_score: item.heat_score,
            timestamp: new Date(ts).toISOString(),
            notification_candidate:
                type === 'SURGE' ||
                type === 'BREAKOUT' ||
                type === 'RANK_JUMP' ||
                type === 'PULLBACK_READY',
        };
        this.recent.push(ev);
        if (this.recent.length > 500) this.recent.shift();
        return ev;
    }

    evaluate(
        item: IntradayRankItem,
        previous: IntradayRankItem | null,
    ): IntradayEventType[] {
        const types: IntradayEventType[] = [];
        const push = (t: IntradayEventType, strength: number) => {
            const ev = this.fire(item, t, strength);
            if (ev) types.push(t);
        };

        const m = item.metrics;
        if (item.state === 'STRONG' || item.state === 'HEATING') {
            if (
                (m.volume_acceleration ?? 0) >= 2 &&
                m.momentum_acceleration >= 70 &&
                (m.vwap_pos_pct ?? -1) >= 0 &&
                (m.liquidity_score ?? 0) >= 50
            ) {
                push('SURGE', item.heat_score);
            }
        }

        if (m.breakout_type === 'breakout') {
            push('BREAKOUT', m.breakout_score ?? 0);
        }
        if (m.breakout_type === 'rebreak') {
            push('REBREAK', m.breakout_score ?? 0);
        }

        if (
            m.pullback_state === 'holding' ||
            m.pullback_state === 'reclaiming'
        ) {
            if (item.intraday_score >= 70) {
                push('PULLBACK_READY', m.pullback_quality_score ?? 0);
            }
        }

        if (
            item.rank_velocity != null &&
            item.rank_velocity >= this.cfg.rank_jump_threshold
        ) {
            push('RANK_JUMP', Math.min(100, item.rank_velocity));
        }

        if (
            previous &&
            (previous.state === 'STRONG' || previous.state === 'HEATING') &&
            (item.state === 'COOLING' || item.state === 'EMERGING')
        ) {
            push('COOLING', 60);
        }

        if (item.state === 'INVALID') {
            push('INVALID', 80);
        }

        return types;
    }
}
