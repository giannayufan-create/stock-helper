// server/src/lib/radar-rescue/config.ts

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESCUE_VERSION, type RadarMode } from './types.ts';

export interface LaneQuotas {
    LIQUIDITY_LANE: number;
    ACCELERATION_LANE: number;
    REVERSAL_LANE: number;
    BREAKOUT_LANE: number;
    A_PRIOR_LANE: number;
    B_OPEN_LANE: number;
    SECTOR_LEADER_LANE: number;
    NEWS_EVENT_LANE: number;
}

export interface RadarRescueConfig {
    enabled: boolean;
    version: string;
    evaluate_interval_sec: number;
    mode: RadarMode;
    apply_lane_to_active_watch: boolean;
    lane_quotas: LaneQuotas;
    early_min_evidence: number;
    early_block_stale: boolean;
    early_block_low_confidence: boolean;
    opportunity_weights: Record<string, number>;
    chase_thresholds: {
        low_max_pct: number;
        medium_max_pct: number;
        high_max_pct: number;
        extreme_gap_pct: number;
        extreme_vwap_ext_pct: number;
    };
    news_adjustment_max: number;
    early_focus_top_n: number;
    confirmed_focus_top_n: number;
    focus_block_low_confidence: boolean;
    coverage_not_ready_below: number;
    stale_seconds: number;
    persist_transitions: boolean;
    eod_truth_enabled: boolean;
    trigger_weights: Record<string, number>;
    /** Rescue-only promotion (does not change C ranked pool). */
    rescue_disc_active_min_change_pct: number;
    rescue_disc_active_min_trigger: number;
    rescue_disc_active_min_discovery: number;
    /** Promote top WATCH cards into UI visibility when ACTIVE/EARLY empty. */
    ui_promote_watch_top_n: number;
    /** Top discovery by change_pct → Force into Rescue ACTIVE/Focus/UI (bypass C). 0 = no cap. */
    board_mover_top_n: number;
    board_mover_min_change_pct: number;
    /** Any discovery already ≥ this day-change gets ui_visible (comprehensive catch). */
    board_mover_ui_guarantee_pct: number;
    /** Catch before +3%: still-small day move + accelerating trigger. */
    pre_plus3_max_change_pct: number;
    pre_plus3_min_trigger: number;
    pre_plus3_min_vol_accel: number;
    pre_plus3_focus_top_n: number;
}

export const DEFAULT_RESCUE_CONFIG: RadarRescueConfig = {
    enabled: true,
    version: RESCUE_VERSION,
    evaluate_interval_sec: 5,
    mode: 'rescue',
    apply_lane_to_active_watch: false,
    lane_quotas: {
        LIQUIDITY_LANE: 25,
        ACCELERATION_LANE: 40,
        REVERSAL_LANE: 15,
        BREAKOUT_LANE: 20,
        A_PRIOR_LANE: 12,
        B_OPEN_LANE: 12,
        SECTOR_LEADER_LANE: 12,
        NEWS_EVENT_LANE: 12,
    },
    early_min_evidence: 1,
    early_block_stale: true,
    early_block_low_confidence: false,
    opportunity_weights: {
        momentum: 0.18,
        volume_acceleration: 0.18,
        relative_strength: 0.12,
        vwap: 0.12,
        breakout: 0.1,
        trade_aggression: 0.1,
        rank_velocity: 0.1,
        bp_trend: 0.05,
        sector_support: 0.05,
    },
    chase_thresholds: {
        low_max_pct: 2.0,
        medium_max_pct: 4.5,
        high_max_pct: 7.0,
        extreme_gap_pct: 5.0,
        extreme_vwap_ext_pct: 2.5,
    },
    news_adjustment_max: 5,
    early_focus_top_n: 8,
    confirmed_focus_top_n: 12,
    focus_block_low_confidence: false,
    coverage_not_ready_below: 30,
    stale_seconds: 60,
    persist_transitions: true,
    eod_truth_enabled: true,
    trigger_weights: {
        rank_velocity: 0.18,
        volume_acceleration: 0.18,
        momentum_acceleration: 0.15,
        short_return_acceleration: 0.12,
        turnover_acceleration: 0.1,
        relative_strength_change: 0.08,
        vwap_transition: 0.08,
        breakout_transition: 0.06,
        bp_slope: 0.05,
    },
    rescue_disc_active_min_change_pct: 1.5,
    rescue_disc_active_min_trigger: 40,
    rescue_disc_active_min_discovery: 45,
    ui_promote_watch_top_n: 80,
    board_mover_top_n: 0,
    board_mover_min_change_pct: 1.5,
    board_mover_ui_guarantee_pct: 3.0,
    pre_plus3_max_change_pct: 3.0,
    pre_plus3_min_trigger: 42,
    pre_plus3_min_vol_accel: 12,
    pre_plus3_focus_top_n: 15,
};

function parseSimpleYaml(text: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let objKey: string | null = null;
    let obj: Record<string, unknown> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trimEnd();
        if (!line.trim()) continue;
        const indent = (line.match(/^(\s*)/)?.[1] ?? '').length;
        const m = line.trim().match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (!m) continue;
        const key = m[1]!;
        const val = m[2]!.trim();
        if (indent === 0) {
            if (objKey) {
                out[objKey] = obj;
                obj = {};
            }
            if (val === '') {
                objKey = key;
                obj = {};
            } else {
                objKey = null;
                out[key] = coerce(val);
            }
        } else if (objKey) {
            obj[key] = coerce(val);
        }
    }
    if (objKey) out[objKey] = obj;
    return out;
}

function coerce(v: string): unknown {
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v.replace(/^["']|["']$/g, '');
}

function deepMerge(
    base: RadarRescueConfig,
    patch: Record<string, unknown>,
): RadarRescueConfig {
    const out = structuredClone(base);
    for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            (out as unknown as Record<string, unknown>)[k] = {
                ...((out as unknown as Record<string, unknown>)[k] as object),
                ...(v as object),
            };
        } else if (v !== undefined) {
            (out as unknown as Record<string, unknown>)[k] = v;
        }
    }
    return out;
}

let cached: RadarRescueConfig | null = null;

export function loadRadarRescueConfig(force = false): RadarRescueConfig {
    if (cached && !force) return cached;
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(here, '../../../config/radar_rescue_config.yaml');
    let cfg = { ...DEFAULT_RESCUE_CONFIG };
    if (existsSync(path)) {
        try {
            const raw = parseSimpleYaml(readFileSync(path, 'utf8'));
            cfg = deepMerge(cfg, raw);
        } catch {
            /* keep defaults */
        }
    }
    const envMode = (process.env.RADAR_MODE ?? '').trim().toLowerCase();
    if (envMode === 'legacy' || envMode === 'rescue') {
        cfg.mode = envMode;
    }
    cached = cfg;
    return cfg;
}
