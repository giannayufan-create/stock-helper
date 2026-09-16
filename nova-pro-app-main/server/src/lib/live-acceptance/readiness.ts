// Readiness timeline markers — set once from boot path; never changes strategy.

import type { ReadinessTimeline } from './types.ts';

function nowIso(): string {
    return new Date().toISOString();
}

const markers: ReadinessTimeline = {
    server_started_at: null,
    firebase_ready_at: null,
    shioaji_connected_at: null,
    contracts_ready_at: null,
    market_runtime_ready_at: null,
    index_ready_at: null,
    broad_market_ready_at: null,
    corporate_action_ready_at: null,
    context_ready_at: null,
    C_ready_at: null,
    BP_ready_at: null,
    DATA_HEALTHY_at: null,
    time_to_data_healthy_ms: null,
    time_to_radar_ready_ms: null,
};

function setOnce(
    key: keyof Omit<
        ReadinessTimeline,
        'time_to_data_healthy_ms' | 'time_to_radar_ready_ms'
    >,
    at?: string,
): void {
    if (markers[key] != null) return;
    (markers as Record<string, string | null>)[key] = at ?? nowIso();
    recompute();
}

function recompute(): void {
    const start = markers.server_started_at
        ? Date.parse(markers.server_started_at)
        : NaN;
    if (!Number.isFinite(start)) return;
    if (markers.DATA_HEALTHY_at) {
        markers.time_to_data_healthy_ms =
            Date.parse(markers.DATA_HEALTHY_at) - start;
    }
    const radarReady =
        markers.C_ready_at && markers.BP_ready_at && markers.context_ready_at
            ? Math.max(
                  Date.parse(markers.C_ready_at),
                  Date.parse(markers.BP_ready_at),
                  Date.parse(markers.context_ready_at),
              )
            : NaN;
    if (Number.isFinite(radarReady)) {
        markers.time_to_radar_ready_ms = radarReady - start;
    }
}

export const ReadinessTracker = {
    markServerStarted: (at?: string) => setOnce('server_started_at', at),
    markFirebaseReady: (at?: string) => setOnce('firebase_ready_at', at),
    markShioajiConnected: (at?: string) => setOnce('shioaji_connected_at', at),
    markContractsReady: (at?: string) => setOnce('contracts_ready_at', at),
    markMarketRuntimeReady: (at?: string) =>
        setOnce('market_runtime_ready_at', at),
    markIndexReady: (at?: string) => setOnce('index_ready_at', at),
    markBroadMarketReady: (at?: string) => setOnce('broad_market_ready_at', at),
    markCorporateActionReady: (at?: string) =>
        setOnce('corporate_action_ready_at', at),
    markContextReady: (at?: string) => setOnce('context_ready_at', at),
    markCReady: (at?: string) => setOnce('C_ready_at', at),
    markBPReady: (at?: string) => setOnce('BP_ready_at', at),
    markDataHealthy: (at?: string) => setOnce('DATA_HEALTHY_at', at),
    snapshot(): ReadinessTimeline {
        return { ...markers };
    },
    /** Test helper */
    _resetForTest(): void {
        for (const k of Object.keys(markers) as (keyof ReadinessTimeline)[]) {
            (markers as Record<string, unknown>)[k] = null;
        }
    },
};
