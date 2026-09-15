// server/src/lib/open-gate-v2/data-health.ts
// Data issues → data_blocked only. NEVER hard_reject.
// Age/stale/disconnected MUST use injected nowMs (Clock) — never wall Date.now().

import type { OpenGateConfig } from './config.ts';
import type { MarketDataEngine } from './market-data-engine.ts';
import type { DataHealth } from './types.ts';

export interface DataHealthReport {
    health: DataHealth;
    data_blocked: boolean;
    shioaji_connected: boolean;
    stream_connected: boolean;
    last_tick_at: number | null;
    last_bidask_at: number | null;
    last_quote_at: number | null;
    data_age_seconds: number | null;
    historical_profile_available: boolean;
    notes: string[];
}

export class DataHealthService {
    private providerName: string;
    private profileReady = false;

    constructor(
        private engine: MarketDataEngine,
        private cfg: OpenGateConfig,
        providerName = 'unknown',
    ) {
        this.providerName = providerName;
    }

    setProviderName(name: string): void {
        this.providerName = name;
    }

    setHistoricalProfileAvailable(ok: boolean): void {
        this.profileReady = ok;
    }

    /**
     * @param symbol optional symbol for per-symbol last quote
     * @param nowMs strategy clock — Live=SystemClock, Replay=ReplayClock
     */
    report(symbol?: string, nowMs?: number): DataHealthReport {
        const now = nowMs ?? (() => {
            throw new Error(
                'DataHealth.report requires nowMs from Clock (no wall Date.now)',
            );
        })();
        const st = symbol ? this.engine.getState(symbol) : undefined;
        const lastTick = st?.last_tick_at ?? this.engine.lastTickAt();
        const lastBa = st?.last_bidask_at ?? this.engine.lastBidAskAt();
        const lastQuoteAt =
            lastTick != null || lastBa != null
                ? Math.max(lastTick ?? 0, lastBa ?? 0) || null
                : (st?.timestamp ?? null);

        const ageSec =
            lastQuoteAt != null
                ? Math.max(0, (now - lastQuoteAt) / 1000)
                : null;

        const stream = this.engine.streamConnected();
        const shioaji =
            this.providerName === 'shioaji' ||
            this.providerName === 'fugle' ||
            this.providerName === 'replay';

        const notes: string[] = [];
        let health: DataHealth = 'healthy';

        if (!stream && ageSec == null) {
            health = 'disconnected';
            notes.push('stream disconnected / no quotes');
        } else if (
            ageSec != null &&
            ageSec >= this.cfg.data_health.disconnected_seconds
        ) {
            health = 'disconnected';
            notes.push(`data age ${ageSec.toFixed(0)}s`);
        } else if (
            ageSec != null &&
            ageSec >= this.cfg.data_health.stale_seconds
        ) {
            health = 'stale';
            notes.push(`stale ${ageSec.toFixed(0)}s`);
        } else if (!this.profileReady) {
            health = 'degraded';
            notes.push('historical intraday profile not ready');
        } else if (!stream && this.providerName !== 'replay') {
            health = 'degraded';
            notes.push('stream flaky — using last known state');
        }

        // Replay: stream may be false; quotes arrive via applyCompletedBar
        if (
            this.providerName === 'replay' &&
            ageSec != null &&
            ageSec < this.cfg.data_health.stale_seconds
        ) {
            if (health === 'disconnected' && !this.profileReady) {
                health = 'degraded';
            } else if (health === 'disconnected' && lastQuoteAt != null) {
                health = 'healthy';
                notes.length = 0;
            }
        }

        const data_blocked =
            health === 'stale' || health === 'disconnected';

        return {
            health,
            data_blocked,
            shioaji_connected: shioaji,
            stream_connected: stream || this.providerName === 'replay',
            last_tick_at: lastTick,
            last_bidask_at: lastBa,
            last_quote_at: lastQuoteAt,
            data_age_seconds: ageSec,
            historical_profile_available: this.profileReady,
            notes,
        };
    }

    /** New PASS only when not data_blocked (+ optional profile). */
    allowsNewPass(report: DataHealthReport): boolean {
        if (report.data_blocked) return false;
        if (
            this.cfg.data_health.require_profile_for_pass &&
            !report.historical_profile_available
        ) {
            return false;
        }
        return report.health === 'healthy' || report.health === 'degraded';
    }
}
