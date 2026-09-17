// server/src/lib/signal-outcome/live-tracker.ts
// Samples live price after each StrategySignal and settles SignalOutcome.
// Read-only observer: never mutates A/B/C state, never feeds future data back.

import type { SymbolMarketState } from '../open-gate-v2/types.ts';
import type { StrategySignal } from '../strategy-signal/types.ts';
import { calculateOutcome } from './outcome-calculator.ts';
import type { SignalOutcomeRepository } from './repository.ts';
import type { PriceBar, SignalOutcome } from './types.ts';
import { FORWARD_HORIZONS_MIN } from './types.ts';

export interface LiveOutcomeTrackerDeps {
    getState(symbol: string): SymbolMarketState | undefined;
}

export interface LiveOutcomeTrackerConfig {
    /** How often to sample tracked symbols. */
    sample_interval_sec: number;
    /** Stop tracking a signal this long after signal_time. */
    max_track_minutes: number;
    /** Hard cap on concurrently tracked signals (memory guard). */
    max_tracked: number;
    /** Skip signals whose reference_price is missing/zero. */
    require_reference_price: boolean;
    /**
     * Append a row every time a forward horizon fills. Off by default —
     * one signal would cost ~7 writes and blow the Firestore daily quota.
     */
    write_partials: boolean;
}

export function loadLiveOutcomeTrackerConfig(
    env: NodeJS.ProcessEnv = process.env,
): LiveOutcomeTrackerConfig {
    const num = (key: string, fallback: number): number => {
        const raw = Number(env[key]);
        return Number.isFinite(raw) && raw > 0 ? raw : fallback;
    };
    return {
        sample_interval_sec: num('OUTCOME_SAMPLE_INTERVAL_SEC', 10),
        max_track_minutes: num('OUTCOME_MAX_TRACK_MIN', 65),
        max_tracked: num('OUTCOME_MAX_TRACKED', 600),
        require_reference_price: true,
        write_partials: env.OUTCOME_WRITE_PARTIALS === '1',
    };
}

interface TrackedSignal {
    signal: StrategySignal;
    signalMs: number;
    bars: PriceBar[];
    lastSampleMs: number;
    /** Signature of what has already been written, to avoid duplicate rows. */
    writtenSignature: string;
    settled: boolean;
}

export interface LiveOutcomeTrackerHealth {
    enabled: boolean;
    tracked: number;
    settled_total: number;
    written_total: number;
    dropped_no_reference: number;
    dropped_capacity: number;
    last_sample_at: string | null;
    last_write_at: string | null;
    last_error: string | null;
    sample_interval_sec: number;
}

/**
 * Turns live ticks into the forward-path bars that `calculateOutcome` needs.
 * One bar per sample window; high/low come from runtime `recent_prices` so a
 * spike between two samples is not lost.
 */
export class LiveOutcomeTracker {
    readonly cfg: LiveOutcomeTrackerConfig;
    private tracked = new Map<string, TrackedSignal>();
    private timer: NodeJS.Timeout | null = null;
    private settledTotal = 0;
    private writtenTotal = 0;
    private droppedNoReference = 0;
    private droppedCapacity = 0;
    private lastSampleAt: string | null = null;
    private lastWriteAt: string | null = null;
    private lastError: string | null = null;

    constructor(
        private deps: LiveOutcomeTrackerDeps,
        private repo: SignalOutcomeRepository,
        cfg?: Partial<LiveOutcomeTrackerConfig>,
    ) {
        this.cfg = { ...loadLiveOutcomeTrackerConfig(), ...cfg };
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(
            () => this.sampleOnce(),
            this.cfg.sample_interval_sec * 1000,
        );
        this.timer.unref?.();
    }

    stop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    track(signal: StrategySignal): void {
        if (this.tracked.has(signal.signal_id)) return;
        if (this.cfg.require_reference_price && !(signal.reference_price > 0)) {
            this.droppedNoReference += 1;
            return;
        }
        if (this.tracked.size >= this.cfg.max_tracked) {
            this.droppedCapacity += 1;
            return;
        }
        const signalMs = Date.parse(signal.signal_time);
        if (!Number.isFinite(signalMs)) return;
        this.tracked.set(signal.signal_id, {
            signal,
            signalMs,
            bars: [],
            lastSampleMs: signalMs,
            writtenSignature: '',
            settled: false,
        });
    }

    /** Exposed for tests and for a manual settle at session close. */
    sampleOnce(nowMs = Date.now()): void {
        try {
            for (const [id, t] of this.tracked) {
                this.appendBar(t, nowMs);
                const expired =
                    nowMs - t.signalMs >= this.cfg.max_track_minutes * 60_000;
                const outcome = this.flush(t, nowMs, expired);
                if (t.settled || (outcome && outcome.status === 'invalid_data')) {
                    this.tracked.delete(id);
                    this.settledTotal += 1;
                }
            }
            this.lastSampleAt = new Date(nowMs).toISOString();
        } catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
        }
    }

    /** Force-settle everything still open, e.g. at session close. */
    settleAll(nowMs = Date.now()): number {
        let n = 0;
        for (const [id, t] of this.tracked) {
            this.appendBar(t, nowMs);
            this.flush(t, nowMs, true);
            this.tracked.delete(id);
            this.settledTotal += 1;
            n += 1;
        }
        return n;
    }

    getHealth(): LiveOutcomeTrackerHealth {
        return {
            enabled: this.timer != null,
            tracked: this.tracked.size,
            settled_total: this.settledTotal,
            written_total: this.writtenTotal,
            dropped_no_reference: this.droppedNoReference,
            dropped_capacity: this.droppedCapacity,
            last_sample_at: this.lastSampleAt,
            last_write_at: this.lastWriteAt,
            last_error: this.lastError,
            sample_interval_sec: this.cfg.sample_interval_sec,
        };
    }

    private appendBar(t: TrackedSignal, nowMs: number): void {
        const st = this.deps.getState(t.signal.symbol);
        if (!st || !(st.last_price > 0)) return;
        // Ticks that arrived since the previous sample give the true
        // intra-window high/low; without them the bar is flat at last_price.
        const window = (st.recent_prices ?? []).filter(
            (p) => p.t > t.lastSampleMs && p.t <= nowMs && p.p > 0,
        );
        const prices = window.length
            ? window.map((p) => p.p)
            : [st.last_price];
        t.bars.push({
            t: nowMs,
            open: prices[0]!,
            high: Math.max(...prices),
            low: Math.min(...prices),
            close: st.last_price,
        });
        t.lastSampleMs = nowMs;
    }

    private flush(
        t: TrackedSignal,
        nowMs: number,
        forceComplete: boolean,
    ): SignalOutcome | null {
        if (!t.bars.length) {
            if (forceComplete) t.settled = true;
            return null;
        }
        const outcome = calculateOutcome({
            signal: t.signal,
            futureBars: t.bars,
            nowMs,
        });
        const bag = outcome as unknown as Record<string, unknown>;
        const filledHorizons = FORWARD_HORIZONS_MIN.filter(
            (h) => bag[`forward_return_${h}m`] != null,
        ).length;
        const signature = `${filledHorizons}|${outcome.invalid_hit ? 'x' : '-'}`;

        const isComplete =
            outcome.status === 'complete' || outcome.status === 'ambiguous';
        if (forceComplete && !isComplete) {
            outcome.event_kind = 'COMPLETE';
            outcome.status =
                outcome.status === 'pending' ? 'partial' : outcome.status;
        }

        // Default: one row at settle, plus one the first time the signal
        // breaks its invalid price — that is the risk fact worth keeping.
        const changed = signature !== t.writtenSignature;
        const invalidJustHit =
            Boolean(outcome.invalid_hit) && !t.writtenSignature.endsWith('x');
        const shouldWrite =
            isComplete ||
            forceComplete ||
            invalidJustHit ||
            (this.cfg.write_partials && changed && filledHorizons > 0);
        if (!shouldWrite) return outcome;

        try {
            this.repo.appendUpdate(outcome);
            this.writtenTotal += 1;
            this.lastWriteAt = new Date(nowMs).toISOString();
            t.writtenSignature = signature;
        } catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
        }
        if (isComplete || forceComplete) t.settled = true;
        return outcome;
    }
}
