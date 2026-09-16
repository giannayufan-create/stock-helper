// Market Calendar config — refresh cadence only; no strategy weights.

export interface MarketCalendarConfig {
    refresh_interval_ms: number;
    /** Prefetch calculation results window (calendar days). */
    calc_lookback_days: number;
    calc_lookahead_days: number;
    request_timeout_ms: number;
}

export const DEFAULT_MCAL_CONFIG: MarketCalendarConfig = {
    refresh_interval_ms: 6 * 60 * 60 * 1000, // 6h — not per-tick
    calc_lookback_days: 7,
    calc_lookahead_days: 45,
    request_timeout_ms: 20_000,
};

export function loadMarketCalendarConfig(
    env: NodeJS.ProcessEnv = process.env,
): MarketCalendarConfig {
    const cfg = { ...DEFAULT_MCAL_CONFIG };
    const refreshH = Number(env.MCAL_REFRESH_HOURS);
    if (Number.isFinite(refreshH) && refreshH > 0) {
        cfg.refresh_interval_ms = Math.round(refreshH * 60 * 60 * 1000);
    }
    return cfg;
}
