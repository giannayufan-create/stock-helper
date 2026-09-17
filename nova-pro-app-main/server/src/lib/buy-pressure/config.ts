// server/src/lib/buy-pressure/config.ts

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BP_VERSION } from './types.ts';

export interface BuyPressureConfig {
    enabled: boolean;
    version: string;
    evaluate_interval_sec: number;
    bidask_history_len: number;
    score_weights: {
        volume_acceleration: number;
        trade_aggression: number;
        rvol: number;
        rank_velocity: number;
        momentum_acceleration: number;
        vwap_structure: number;
        bidask_imbalance: number;
    };
    early: {
        min_rank_improve: number;
        min_volume_accel: number;
        min_rvol: number;
        require_above_vwap: boolean;
        min_momentum: number;
        min_aggression: number;
    };
    buy_surge: {
        min_rvol: number;
        min_volume_accel: number;
        min_momentum: number;
        min_aggression: number;
        min_rank_velocity: number;
        min_score: number;
    };
    ask_eating: {
        min_ask_drop_pct: number;
        min_executed_ratio: number;
        min_snapshots: number;
    };
    ask_cancel: {
        max_executed_ratio: number;
    };
    large_bid: {
        min_multiple_of_avg: number;
        min_history: number;
    };
    bid_cancel: {
        min_bid_drop_pct: number;
        max_executed_ratio: number;
        min_snapshots: number;
        /** Deduction applied to the BP score when a spoofed bid is seen. */
        score_penalty: number;
    };
    volume_breakout: {
        min_volume_accel: number;
        min_aggression: number;
        require_rank_improving: boolean;
    };
    overheated: {
        min_change_pct: number;
        min_heat: number;
        min_vwap_distance_pct: number;
        chase_risks: string[];
    };
    cooling: {
        max_volume_accel: number;
        max_rank_velocity: number;
    };
    ranking: {
        early_bonus: number;
        rank_velocity_bonus_scale: number;
        fresh_accel_bonus_scale: number;
        /** Per chase-risk step (LOW=0 … EXTREME=3) deducted from radar_rank_score. */
        chase_penalty_scale: number;
        /** Flat deduction from radar_rank_score when OVERHEATED is present. */
        overheated_penalty: number;
    };
    notification_cooldown_sec: number;
    stale_block_states: boolean;
    /** Near VWAP band as abs % */
    near_vwap_pct: number;
    /** Timestamp window for EARLY / accel slopes (ms). */
    slope_window_ms: number;
    /**
     * Max symbols BP actively evaluates from Broad Discovery ∩ already-subscribed
     * runtime. Never creates new upstream subscriptions.
     */
    max_active_observation: number;
}

export const DEFAULT_BP_CONFIG: BuyPressureConfig = {
    enabled: true,
    version: BP_VERSION,
    evaluate_interval_sec: 2,
    bidask_history_len: 12,
    score_weights: {
        volume_acceleration: 0.25,
        trade_aggression: 0.2,
        rvol: 0.15,
        rank_velocity: 0.15,
        momentum_acceleration: 0.1,
        vwap_structure: 0.1,
        bidask_imbalance: 0.05,
    },
    early: {
        min_rank_improve: 8,
        min_volume_accel: 20,
        min_rvol: 1.5,
        require_above_vwap: true,
        min_momentum: 0,
        min_aggression: 40,
    },
    buy_surge: {
        min_rvol: 1.8,
        min_volume_accel: 40,
        min_momentum: 10,
        min_aggression: 55,
        min_rank_velocity: 5,
        min_score: 65,
    },
    ask_eating: {
        min_ask_drop_pct: 0.4,
        min_executed_ratio: 0.5,
        min_snapshots: 3,
    },
    ask_cancel: {
        max_executed_ratio: 0.15,
    },
    large_bid: {
        min_multiple_of_avg: 2.5,
        min_history: 4,
    },
    bid_cancel: {
        min_bid_drop_pct: 0.4,
        max_executed_ratio: 0.15,
        min_snapshots: 3,
        score_penalty: 8,
    },
    volume_breakout: {
        min_volume_accel: 30,
        min_aggression: 50,
        require_rank_improving: true,
    },
    overheated: {
        min_change_pct: 7,
        min_heat: 90,
        min_vwap_distance_pct: 3,
        chase_risks: ['high', 'extreme'],
    },
    cooling: {
        max_volume_accel: 0,
        max_rank_velocity: 0,
    },
    ranking: {
        early_bonus: 12,
        rank_velocity_bonus_scale: 0.35,
        fresh_accel_bonus_scale: 0.12,
        chase_penalty_scale: 3,
        overheated_penalty: 6,
    },
    notification_cooldown_sec: 90,
    stale_block_states: true,
    near_vwap_pct: 0.35,
    slope_window_ms: 90_000,
    max_active_observation: 80,
};

function deepMerge<T extends Record<string, unknown>>(
    base: T,
    over: Record<string, unknown> | null | undefined,
): T {
    if (!over || typeof over !== 'object') return base;
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) {
        if (
            v &&
            typeof v === 'object' &&
            !Array.isArray(v) &&
            typeof base[k] === 'object' &&
            base[k] &&
            !Array.isArray(base[k])
        ) {
            out[k] = deepMerge(
                base[k] as Record<string, unknown>,
                v as Record<string, unknown>,
            );
        } else if (v !== undefined) {
            out[k] = v;
        }
    }
    return out as T;
}

function parseSimpleYaml(text: string): Record<string, unknown> {
    // Minimal nested YAML (same style as BI/MI loaders).
    const root: Record<string, unknown> = {};
    const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
        { indent: -1, obj: root },
    ];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '');
        if (!line.trim()) continue;
        const m = line.match(/^(\s*)([^:]+):\s*(.*)$/);
        if (!m) continue;
        const indent = (m[1] ?? '').length;
        const key = (m[2] ?? '').trim();
        const valRaw = (m[3] ?? '').trim();
        while (stack.length > 1 && indent <= (stack[stack.length - 1]?.indent ?? -1)) {
            stack.pop();
        }
        const parent = stack[stack.length - 1]?.obj;
        if (!parent) continue;
        if (!valRaw) {
            const child: Record<string, unknown> = {};
            parent[key] = child;
            stack.push({ indent, obj: child });
            continue;
        }
        let val: unknown = valRaw;
        if (valRaw === 'true') val = true;
        else if (valRaw === 'false') val = false;
        else if (/^-?\d+(\.\d+)?$/.test(valRaw)) val = Number(valRaw);
        else if (
            (valRaw.startsWith('"') && valRaw.endsWith('"')) ||
            (valRaw.startsWith("'") && valRaw.endsWith("'"))
        ) {
            val = valRaw.slice(1, -1);
        } else if (valRaw.startsWith('[') && valRaw.endsWith(']')) {
            val = valRaw
                .slice(1, -1)
                .split(',')
                .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
                .filter(Boolean);
        }
        parent[key] = val;
    }
    return root;
}

export function loadBuyPressureConfig(): BuyPressureConfig {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, '../../../config/buy_pressure_config.yaml'),
        join(process.cwd(), 'config/buy_pressure_config.yaml'),
        join(process.cwd(), 'server/config/buy_pressure_config.yaml'),
    ];
    for (const p of candidates) {
        if (!existsSync(p)) continue;
        try {
            const parsed = parseSimpleYaml(readFileSync(p, 'utf8'));
            return deepMerge(
                DEFAULT_BP_CONFIG as unknown as Record<string, unknown>,
                parsed,
            ) as unknown as BuyPressureConfig;
        } catch {
            // fall through to defaults
        }
    }
    return { ...DEFAULT_BP_CONFIG, version: BP_VERSION };
}
