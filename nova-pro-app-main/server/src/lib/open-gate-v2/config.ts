// server/src/lib/open-gate-v2/config.ts — load open_gate_config.yaml (Final Patch)

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OpenGateConfig {
    evaluate_interval_sec: number;
    fresh_ttl_sec: number;
    signal_ttl_sec: number;
    /** legacy alias → pass_enter */
    pass_threshold: number;
    /** legacy alias → watch_enter */
    watch_threshold: number;
    pass_enter_threshold: number;
    pass_exit_threshold: number;
    watch_enter_threshold: number;
    reject_exit_threshold: number;
    min_confirm_evaluations: number;
    early_tradeable: boolean;
    phase: {
        provisional_end_min: number;
        early_end_min: number;
        confirmed_end_min: number;
    };
    cutoff: {
        allow_new_tradeable_after_cutoff: boolean;
    };
    score_weights: {
        rvol: number;
        vwap: number;
        open_hold: number;
        pullback: number;
        momentum: number;
        gap: number;
    };
    rvol_thresholds: {
        excellent: number;
        good: number;
        ok: number;
        weak: number;
    };
    vwap_thresholds: {
        strong_above: number;
        above: number;
        soft_below: number;
        hard_below: number;
    };
    open_hold_thresholds: {
        strong_above: number;
        above: number;
        soft_below: number;
        hard_below: number;
    };
    pullback_thresholds: {
        ideal_max: number;
        ok_max: number;
        weak_max: number;
    };
    gap_thresholds: {
        ideal_low: number;
        ideal_high: number;
        hot: number;
        cold: number;
    };
    liquidity: {
        min_turnover_5m: number;
        min_turnover_10m: number;
        min_tick_count: number;
        max_spread_pct: number;
        min_rvol: number;
        hard_min_turnover: number;
        hard_max_spread_pct: number;
        score_to_adjustment: { adj_min: number; adj_max: number };
    };
    market_regime: {
        weights: {
            taiex: number;
            tpex: number;
            breadth: number;
            us_overnight: number;
        };
        adjustment_limits: { min: number; max: number };
    };
    risk: {
        max_chase_gap_pct: number;
        max_day_chg_pct: number;
        max_vwap_extension_pct: number;
        tick_buffer_ticks: number;
        bad_rr_soft_to_watch: boolean;
        adj_min: number;
        adj_max: number;
    };
    chase_risk_thresholds: {
        low_max: number;
        medium_max: number;
        high_max: number;
    };
    data_health: {
        stale_seconds: number;
        disconnected_seconds: number;
        require_profile_for_pass: boolean;
    };
    hard_reject: {
        disposition: boolean;
        attention_only_soft: boolean;
        structural_illiquidity: boolean;
        missing_essential_data: boolean;
    };
    logging: {
        log_score_delta_threshold: number;
        log_heartbeat_sec: number;
    };
    historical_profile: {
        lookback_days: number;
        anchor_minutes: number[];
        prefer_minute_curve: boolean;
    };
    outcome: {
        horizons_min: number[];
    };
}

export const DEFAULT_OPEN_GATE_CONFIG: OpenGateConfig = {
    evaluate_interval_sec: 3,
    fresh_ttl_sec: 10,
    signal_ttl_sec: 180,
    pass_threshold: 78,
    watch_threshold: 62,
    pass_enter_threshold: 78,
    pass_exit_threshold: 74,
    watch_enter_threshold: 62,
    reject_exit_threshold: 65,
    min_confirm_evaluations: 2,
    early_tradeable: false,
    phase: {
        provisional_end_min: 3,
        early_end_min: 10,
        confirmed_end_min: 30,
    },
    cutoff: {
        allow_new_tradeable_after_cutoff: false,
    },
    score_weights: {
        rvol: 30,
        vwap: 20,
        open_hold: 15,
        pullback: 15,
        momentum: 15,
        gap: 5,
    },
    rvol_thresholds: {
        excellent: 2.5,
        good: 1.8,
        ok: 1.2,
        weak: 0.8,
    },
    vwap_thresholds: {
        strong_above: 0.8,
        above: 0.15,
        soft_below: -0.4,
        hard_below: -1.2,
    },
    open_hold_thresholds: {
        strong_above: 0.6,
        above: 0.1,
        soft_below: -0.3,
        hard_below: -0.8,
    },
    pullback_thresholds: {
        ideal_max: 0.8,
        ok_max: 1.5,
        weak_max: 2.5,
    },
    gap_thresholds: {
        ideal_low: 0.5,
        ideal_high: 3.5,
        hot: 5.0,
        cold: -1.0,
    },
    liquidity: {
        min_turnover_5m: 8_000_000,
        min_turnover_10m: 15_000_000,
        min_tick_count: 8,
        max_spread_pct: 0.6,
        min_rvol: 0.5,
        hard_min_turnover: 500_000,
        hard_max_spread_pct: 3.0,
        score_to_adjustment: { adj_min: -10, adj_max: 5 },
    },
    market_regime: {
        weights: {
            taiex: 0.45,
            tpex: 0.25,
            breadth: 0.2,
            us_overnight: 0.1,
        },
        adjustment_limits: { min: -12, max: 8 },
    },
    risk: {
        max_chase_gap_pct: 5.0,
        max_day_chg_pct: 8.0,
        max_vwap_extension_pct: 2.5,
        tick_buffer_ticks: 2,
        bad_rr_soft_to_watch: true,
        adj_min: -12,
        adj_max: 4,
    },
    chase_risk_thresholds: {
        low_max: 2.0,
        medium_max: 4.0,
        high_max: 6.5,
    },
    data_health: {
        stale_seconds: 45,
        disconnected_seconds: 120,
        require_profile_for_pass: true,
    },
    hard_reject: {
        disposition: true,
        attention_only_soft: true,
        structural_illiquidity: true,
        missing_essential_data: true,
    },
    logging: {
        log_score_delta_threshold: 3,
        log_heartbeat_sec: 60,
    },
    historical_profile: {
        lookback_days: 20,
        anchor_minutes: [1, 3, 5, 10, 15, 20, 30],
        prefer_minute_curve: true,
    },
    outcome: {
        horizons_min: [5, 15, 30, 60],
    },
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
    const lines = text.split(/\r?\n/);
    const root: Record<string, unknown> = {};
    const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
        { indent: -1, obj: root },
    ];

    const parseScalar = (raw: string): unknown => {
        const s = raw.trim();
        if (!s) return '';
        if (s === 'true') return true;
        if (s === 'false') return false;
        if (s.startsWith('[') && s.endsWith(']')) {
            return s
                .slice(1, -1)
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean)
                .map((x) => {
                    const n = Number(x);
                    return Number.isFinite(n) ? n : x;
                });
        }
        if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
        if (
            (s.startsWith('"') && s.endsWith('"')) ||
            (s.startsWith("'") && s.endsWith("'"))
        ) {
            return s.slice(1, -1);
        }
        return s;
    };

    for (const line of lines) {
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const indent = line.match(/^\s*/)?.[0].length ?? 0;
        const trimmed = line.trim();
        const m = trimmed.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1] ?? '';
        const rest = (m[2] ?? '').replace(/\s+#.*$/, '').trim();
        if (!key) continue;

        while (
            stack.length > 1 &&
            indent <= (stack[stack.length - 1]?.indent ?? -1)
        ) {
            stack.pop();
        }
        const parent = stack[stack.length - 1]?.obj;
        if (!parent) continue;

        if (rest === '') {
            const child: Record<string, unknown> = {};
            parent[key] = child;
            stack.push({ indent, obj: child });
        } else {
            parent[key] = parseScalar(rest);
        }
    }
    return root;
}

/** Normalize legacy aliases after merge. */
export function normalizeOpenGateConfig(cfg: OpenGateConfig): OpenGateConfig {
    const out = { ...cfg };
    if (
        out.pass_enter_threshold == null ||
        Number.isNaN(out.pass_enter_threshold)
    ) {
        out.pass_enter_threshold = out.pass_threshold ?? 78;
    }
    if (
        out.watch_enter_threshold == null ||
        Number.isNaN(out.watch_enter_threshold)
    ) {
        out.watch_enter_threshold = out.watch_threshold ?? 62;
    }
    // keep legacy fields in sync for any leftover readers
    out.pass_threshold = out.pass_enter_threshold;
    out.watch_threshold = out.watch_enter_threshold;
    if (!out.cutoff) {
        out.cutoff = { allow_new_tradeable_after_cutoff: false };
    }
    if (!out.logging) {
        out.logging = {
            log_score_delta_threshold: 3,
            log_heartbeat_sec: 60,
        };
    }
    if (out.fresh_ttl_sec == null) out.fresh_ttl_sec = 10;
    if (out.min_confirm_evaluations == null) out.min_confirm_evaluations = 2;
    if (out.pass_exit_threshold == null) out.pass_exit_threshold = 74;
    if (out.reject_exit_threshold == null) out.reject_exit_threshold = 65;
    return out;
}

let cached: OpenGateConfig | null = null;

export function loadOpenGateConfig(force = false): OpenGateConfig {
    if (cached && !force) return cached;
    const here = dirname(fileURLToPath(import.meta.url));
    const yamlPath = join(
        here,
        '..',
        '..',
        '..',
        'config',
        'open_gate_config.yaml',
    );
    let over: Record<string, unknown> = {};
    if (existsSync(yamlPath)) {
        try {
            over = parseSimpleYaml(readFileSync(yamlPath, 'utf8'));
        } catch (err) {
            console.warn(
                'open_gate_config.yaml parse failed, using defaults:',
                err instanceof Error ? err.message : err,
            );
        }
    }
    cached = normalizeOpenGateConfig(
        deepMerge(
            DEFAULT_OPEN_GATE_CONFIG as unknown as Record<string, unknown>,
            over,
        ) as unknown as OpenGateConfig,
    );
    return cached;
}

export function reloadOpenGateConfig(): OpenGateConfig {
    return loadOpenGateConfig(true);
}
