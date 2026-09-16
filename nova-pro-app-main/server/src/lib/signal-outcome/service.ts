// server/src/lib/signal-outcome/service.ts
// Updates SignalOutcome over horizons. Does NOT feed future data into B/C.

import type { StrategySignal } from '../strategy-signal/types.ts';
import { calculateOutcome } from './outcome-calculator.ts';
import type { SignalOutcomeRepository } from './repository.ts';
import type { PriceBar, SignalOutcome } from './types.ts';

export class SignalOutcomeService {
    constructor(private repo: SignalOutcomeRepository) {}

    /**
     * Compute and append outcome for one signal given future bars only.
     * Caller must ensure futureBars are AFTER signal_time (no leak into B/C).
     */
    updateFromBars(
        signal: StrategySignal,
        futureBars: PriceBar[],
        opts?: {
            closeBar?: PriceBar | null;
            nowMs?: number;
            corporateActionCrossed?: boolean;
        },
    ): SignalOutcome {
        const outcome = calculateOutcome({
            signal,
            futureBars,
            closeBar: opts?.closeBar,
            nowMs: opts?.nowMs,
            corporateActionCrossed: opts?.corporateActionCrossed,
        });
        this.repo.appendUpdate(outcome);
        return outcome;
    }

    /**
     * Replay helper: after full day bars known, settle all signals.
     */
    settleReplayDay(
        signals: StrategySignal[],
        dayBarsBySymbol: Map<string, PriceBar[]>,
        closeBarsBySymbol?: Map<string, PriceBar>,
    ): SignalOutcome[] {
        const out: SignalOutcome[] = [];
        for (const sig of signals) {
            const all = dayBarsBySymbol.get(sig.symbol) ?? [];
            const signalMs = Date.parse(sig.signal_time);
            const future = all.filter((b) => b.t > signalMs);
            const close = closeBarsBySymbol?.get(sig.symbol) ?? null;
            out.push(
                this.updateFromBars(sig, future, {
                    closeBar: close,
                    nowMs: signalMs + 6 * 60 * 60_000,
                }),
            );
        }
        return out;
    }

    find(signalId: string): SignalOutcome | null {
        return this.repo.findBySignalId(signalId);
    }
}
