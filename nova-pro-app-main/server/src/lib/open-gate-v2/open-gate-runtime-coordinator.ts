// server/src/lib/open-gate-v2/open-gate-runtime-coordinator.ts
// Backend-owned A Candidate / OpenGate lifecycle — no frontend POST / EventSource.

import type { OpenGateV2Service } from './service.ts';

export type OpenGateLifecycleReason =
    | 'boot'
    | 'preopen'
    | 'premarket'
    | 'restart'
    | 'manual';

/**
 * Session / boot hooks for OpenGate headless autonomy.
 * Business evaluation stays in OpenGateV2Service; this only owns lifecycle.
 */
export class OpenGateRuntimeCoordinator {
    private lastEnsureAt: string | null = null;
    private lastEnsureResult: {
        count: number;
        source: string;
        hydrated: boolean;
        reason: OpenGateLifecycleReason;
    } | null = null;

    constructor(private openGate: OpenGateV2Service) {}

    /** Boot / restart recovery — hydrate A pool + restore OPEN_GATE subs. */
    async onBoot() {
        return this.ensure('boot');
    }

    /** PREMARKET / overnight prep — prefer persisted EOD A. */
    async onPremarket() {
        return this.ensure('premarket');
    }

    /** PREOPEN — load today's pool before 09:00 evaluation window. */
    async onPreopen() {
        return this.ensure('preopen');
    }

    /** Explicit restart recovery (e.g. 09:08 process restart). */
    async onRestart() {
        return this.ensure('restart');
    }

    async ensure(reason: OpenGateLifecycleReason) {
        const r = await this.openGate.ensureAPoolHeadless(reason);
        this.lastEnsureAt = new Date().toISOString();
        this.lastEnsureResult = { ...r, reason };
        console.log(
            `[open-gate-runtime] ensure reason=${reason} count=${r.count} source=${r.source} hydrated=${r.hydrated} post_required=false`,
        );
        return r;
    }

    getHealth() {
        const meta = this.openGate.getAPoolMeta();
        return {
            version: 'open-gate-runtime-v1',
            post_required: false as const,
            frontend_dependency_core: false as const,
            ui_required: false as const,
            last_ensure_at: this.lastEnsureAt,
            last_ensure: this.lastEnsureResult,
            a_pool: meta,
        };
    }
}
