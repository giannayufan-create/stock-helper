/** Confirm-layer + freshness helpers — UI only, no strategy mutation. */

export type ConfirmLayerKey = 'stock' | 'sector' | 'market' | 'event';

export interface ConfirmLayers {
    stock: boolean;
    sector: boolean;
    market: boolean;
    event: boolean;
}

export const CONFIRM_LAYER_LABEL: Record<ConfirmLayerKey, string> = {
    stock: '個股',
    sector: '產業',
    market: '市場',
    event: '事件',
};

export function emptyConfirmLayers(): ConfirmLayers {
    return { stock: false, sector: false, market: false, event: false };
}

/** Derive four-layer dots from available client context (no invented signals). */
export function deriveConfirmLayers(opts: {
    state?: string | null;
    bpStates?: string[] | null;
    sectorState?: string | null;
    sectorHeat?: number | null;
    taiwanRegime?: string | null;
    eventConfirmed?: boolean | null;
}): ConfirmLayers {
    const stock =
        opts.state === 'STRONG' ||
        opts.state === 'HEATING' ||
        Boolean(
            opts.bpStates?.some(
                (s) =>
                    s === 'BUY_SURGE' ||
                    s === 'VOLUME_BREAKOUT' ||
                    s === 'ASK_EATING',
            ),
        );
    const sector =
        opts.sectorState === 'ROTATING_IN' ||
        opts.sectorState === 'HOT' ||
        (opts.sectorHeat != null && opts.sectorHeat >= 65);
    const market =
        (opts.taiwanRegime ?? '').startsWith('RISK_ON') ||
        opts.taiwanRegime === 'NEUTRAL';
    const event = Boolean(opts.eventConfirmed);
    return { stock, sector, market, event };
}

export type FreshnessLevel =
    | 'REALTIME'
    | 'NEAR_REALTIME'
    | 'DELAYED'
    | 'EOD'
    | 'PREVIOUS_DAY'
    | 'UNKNOWN'
    | 'STALE';

export function normalizeFreshness(
    raw: string | null | undefined,
    stale?: boolean,
): FreshnessLevel {
    if (stale) return 'STALE';
    const u = (raw ?? '').toUpperCase().replace(/\s+/g, '_');
    if (u.includes('PREVIOUS') || u === 'PREVIOUS_DAY') return 'PREVIOUS_DAY';
    if (u === 'EOD') return 'EOD';
    if (u === 'DELAYED') return 'DELAYED';
    if (u.includes('NEAR')) return 'NEAR_REALTIME';
    if (u === 'REALTIME' || u === 'LIVE') return 'REALTIME';
    if (u.includes('STALE')) return 'STALE';
    return 'UNKNOWN';
}

export const FRESHNESS_LABEL: Record<FreshnessLevel, string> = {
    REALTIME: 'REALTIME',
    NEAR_REALTIME: 'NEAR REALTIME',
    DELAYED: 'DELAYED',
    EOD: 'EOD',
    PREVIOUS_DAY: 'PREVIOUS DAY',
    UNKNOWN: 'UNKNOWN',
    STALE: 'STALE',
};

export type NotifPriority = 'HIGH' | 'MEDIUM' | 'INFO';

export function notificationPriority(
    eventType: string,
    extras?: { sectorConfirmed?: boolean; eventConfirmed?: boolean },
): NotifPriority {
    const t = eventType.toUpperCase();
    if (
        (t === 'BUY_SURGE' && extras?.sectorConfirmed) ||
        t === 'VOLUME_BREAKOUT' ||
        extras?.eventConfirmed ||
        (t === 'RANK_ACCELERATION' && extras?.sectorConfirmed)
    ) {
        return 'HIGH';
    }
    if (
        t === 'EARLY_ENTER' ||
        t === 'ASK_EATING' ||
        t === 'BUY_SURGE' ||
        t === 'RANK_ACCELERATION'
    ) {
        return 'MEDIUM';
    }
    return 'INFO';
}

export const SECTOR_STATE_LABEL: Record<string, string> = {
    ROTATING_IN: '輪入',
    HOT: '熱門',
    STABLE: '穩定',
    ROTATING_OUT: '輪出',
    COLD: '冷門',
    INSUFFICIENT_COVERAGE: '覆蓋不足',
};
