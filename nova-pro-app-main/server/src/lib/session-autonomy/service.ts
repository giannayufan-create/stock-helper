// server/src/lib/session-autonomy/service.ts
// Headless session autonomy — timers only; never UI_VIEW / EventSource / frontend polling.

import { EvalTimingRegistry } from '../live-acceptance/eval-timing.ts';
import type { MarketContextRuntime } from '../market-context/index.ts';
import { evaluatePreOpenAuction } from '../market-context/gap-layers/preopen-auction.ts';
import type { ResearchRepositories } from '../research-persistence/index.ts';
import { buildOvernightSnapshot } from './overnight-snapshot.ts';
import { resolveTradingSession } from './session-clock.ts';
import {
    SESSION_AUTONOMY_VERSION,
    type OvernightSnapshot,
    type SessionAutonomyHealth,
    type SessionTransition,
    type TradingSessionState,
} from './types.ts';

export type NowFn = () => number;

export interface SessionAutonomyDeps {
    dataDir: string;
    marketContext?: MarketContextRuntime | null;
    researchRepos?: ResearchRepositories | null;
    onCashLive?: () => void | Promise<void>;
    onPreopen?: () => void | Promise<void>;
    getNotificationCandidateCount?: () => number;
}

export class SessionAutonomyService {
    private timer: ReturnType<typeof setInterval> | null = null;
    private state: TradingSessionState;
    private previous: TradingSessionState | null = null;
    private lastTransitionAt: string | null = null;
    private transitions: SessionTransition[] = [];
    private overnight: OvernightSnapshot[] = [];
    private preopenNoted = false;
    private cashNoted = false;
    private persistenceWrites = 0;
    private nowFn: NowFn = () => Date.now();

    constructor(private deps: SessionAutonomyDeps) {
        this.state = resolveTradingSession(this.nowFn());
    }

    /** Test / replay: inject clock. */
    setNowFn(fn: NowFn): void {
        this.nowFn = fn;
    }

    start(intervalMs = 15_000): void {
        if (this.timer) return;
        void this.tick();
        this.timer = setInterval(() => void this.tick(), intervalMs);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    getState(): TradingSessionState {
        return this.state;
    }

    getOvernightSnapshots(): OvernightSnapshot[] {
        return [...this.overnight];
    }

    getTransitions(): SessionTransition[] {
        return [...this.transitions];
    }

    getHealth(): SessionAutonomyHealth {
        return {
            version: SESSION_AUTONOMY_VERSION,
            state: this.state,
            previous_state: this.previous,
            last_transition_at: this.lastTransitionAt,
            overnight_snapshots: this.overnight.length,
            transitions: this.transitions.length,
            ui_view_consumers: 0,
            event_source_clients: 0,
            headless: true,
            mutates_strategy: false,
            engines_noted: {
                preopen_context: this.preopenNoted,
                cash_market_context: this.cashNoted,
                c_eval_count: EvalTimingRegistry.stats('C').count,
                bp_eval_count: EvalTimingRegistry.stats('BP').count,
                notification_candidates:
                    this.deps.getNotificationCandidateCount?.() ?? 0,
                persistence_writes: this.persistenceWrites,
            },
        };
    }

    async tick(): Promise<SessionTransition | null> {
        const nowMs = this.nowFn();
        const next = resolveTradingSession(nowMs);
        if (next === this.state) {
            // Still refresh context while in PREOPEN/CASH without UI
            if (next === 'PREOPEN') await this.ensurePreopen(nowMs);
            if (next === 'CASH_LIVE' || next === 'CLOSE_AUCTION') {
                await this.ensureCash(nowMs);
            }
            return null;
        }

        const from = this.state;
        this.previous = from;
        this.state = next;
        this.lastTransitionAt = new Date(nowMs).toISOString();
        const tr: SessionTransition = {
            from,
            to: next,
            at: this.lastTransitionAt,
            trigger: 'clock',
        };
        this.transitions.push(tr);
        if (this.transitions.length > 100) this.transitions.shift();

        if (
            (from === 'NIGHT_LIVE' || from === 'WEEKEND') &&
            next === 'PREOPEN'
        ) {
            await this.createOvernightSnapshot(nowMs, from);
            await this.ensurePreopen(nowMs);
        }
        if (from === 'PREOPEN' && (next === 'CASH_LIVE' || next === 'CLOSE_AUCTION')) {
            await this.ensureCash(nowMs);
        }
        if (next === 'CASH_LIVE' || next === 'CLOSE_AUCTION') {
            await this.ensureCash(nowMs);
        }
        if (next === 'PREOPEN') {
            await this.ensurePreopen(nowMs);
        }

        return tr;
    }

    /** Force transition for headless tests (still no UI). */
    async forceState(to: TradingSessionState, nowMs?: number): Promise<void> {
        const ms = nowMs ?? this.nowFn();
        const from = this.state;
        if (from === to) return;
        this.previous = from;
        this.state = to;
        this.lastTransitionAt = new Date(ms).toISOString();
        this.transitions.push({
            from,
            to,
            at: this.lastTransitionAt,
            trigger: 'forced',
        });
        if (
            (from === 'NIGHT_LIVE' || from === 'WEEKEND') &&
            to === 'PREOPEN'
        ) {
            await this.createOvernightSnapshot(ms, from);
            await this.ensurePreopen(ms);
        }
        if (to === 'CASH_LIVE' || to === 'CLOSE_AUCTION') {
            await this.ensureCash(ms);
        }
        if (to === 'PREOPEN') await this.ensurePreopen(ms);
    }

    private async createOvernightSnapshot(
        nowMs: number,
        during: TradingSessionState,
    ): Promise<void> {
        let assets = this.deps.marketContext?.getGlobalAssets?.() ?? [];
        if (!assets.length && this.deps.marketContext?.refreshGlobalAssets) {
            try {
                const r = await this.deps.marketContext.refreshGlobalAssets();
                assets = r.assets;
            } catch {
                assets = [];
            }
        }
        const snap = buildOvernightSnapshot({
            nowMs,
            during,
            assets,
            usBiasLabel: null,
            dataDir: this.deps.dataDir,
        });

        // Research persistence diagnostic (jsonl / firestore / dual) — no UI.
        if (this.deps.researchRepos) {
            try {
                const health = this.deps.researchRepos.getHealth();
                if (
                    health.firestore_initialized ||
                    health.provider === 'FIRESTORE' ||
                    health.provider === 'DUAL'
                ) {
                    snap.persisted_to.push('firestore');
                    snap.notes.push(
                        `research_provider=${health.provider} (overnight marked for firestore path)`,
                    );
                } else {
                    snap.persisted_to.push('jsonl');
                    snap.notes.push(
                        `research_provider=${health.provider} — overnight on disk + jsonl mode`,
                    );
                }
                this.persistenceWrites += 1;
            } catch {
                snap.notes.push('research_persist_failed');
            }
        }

        this.overnight.push(snap);
        if (snap.persisted_to.length) this.persistenceWrites += 1;
        if (this.overnight.length > 30) this.overnight.shift();
    }

    private async ensurePreopen(nowMs: number): Promise<void> {
        this.preopenNoted = true;
        // Evaluate preopen context headlessly (uses buffer; may be PARTIAL)
        evaluatePreOpenAuction(new Date(nowMs).toISOString(), nowMs);
        try {
            await this.deps.onPreopen?.();
            await this.deps.marketContext?.evaluate();
        } catch {
            /* soft */
        }
    }

    private async ensureCash(nowMs: number): Promise<void> {
        this.cashNoted = true;
        void nowMs;
        try {
            await this.deps.onCashLive?.();
            await this.deps.marketContext?.evaluate();
        } catch {
            /* soft */
        }
    }
}
