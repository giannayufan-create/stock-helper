// server/src/lib/intraday-rank/config.ts

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface IntradayRankConfig {
    scanner_interval_sec: number;
    evaluate_interval_sec: number;
    scanner_top_n: {
        change_percent: number;
        volume: number;
        amount: number;
        tick_count: number;
        day_range: number;
    };
    max_discovery_pool: number;
    max_active_watch_pool: number;
    max_ranked_pool: number;
    weights: {
        momentum: number;
        volume_acceleration: number;
        relative_strength: number;
        vwap_structure: number;
        breakout: number;
        trade_aggression: number;
        pullback_quality: number;
        liquidity: number;
    };
    discovery_weights: {
        amount_rank: number;
        tick_rank: number;
        volume_rank: number;
        change_rank: number;
        day_range_rank: number;
        b_bonus: number;
        a_bonus: number;
    };
    strong_enter: number;
    strong_exit: number;
    heating_enter: number;
    heating_exit: number;
    emerging_enter: number;
    min_confirm_evaluations: number;
    rank_jump_threshold: number;
    score_log_delta: number;
    heartbeat_sec: number;
    chase_penalties: {
        low: number;
        medium: number;
        high: number;
        extreme: number;
    };
    b_pass_confidence_bonus: number;
    b_watch_confidence_bonus: number;
    event_cooldowns_sec: Record<string, number>;
    eligibility: {
        max_spread_pct: number;
        min_turnover: number;
        min_tick_count: number;
    };
}

export const DEFAULT_INTRADAY_RANK_CONFIG: IntradayRankConfig = {
    scanner_interval_sec: 15,
    evaluate_interval_sec: 3,
    scanner_top_n: {
        change_percent: 50,
        volume: 50,
        amount: 50,
        tick_count: 50,
        day_range: 30,
    },
    max_discovery_pool: 200,
    max_active_watch_pool: 100,
    max_ranked_pool: 30,
    weights: {
        momentum: 20,
        volume_acceleration: 20,
        relative_strength: 15,
        vwap_structure: 15,
        breakout: 10,
        trade_aggression: 10,
        pullback_quality: 5,
        liquidity: 5,
    },
    discovery_weights: {
        amount_rank: 25,
        tick_rank: 25,
        volume_rank: 20,
        change_rank: 10,
        day_range_rank: 5,
        b_bonus: 10,
        a_bonus: 5,
    },
    strong_enter: 80,
    strong_exit: 74,
    heating_enter: 70,
    heating_exit: 65,
    emerging_enter: 60,
    min_confirm_evaluations: 2,
    rank_jump_threshold: 20,
    score_log_delta: 3,
    heartbeat_sec: 60,
    chase_penalties: { low: 0, medium: 4, high: 10, extreme: 18 },
    b_pass_confidence_bonus: 3,
    b_watch_confidence_bonus: 1,
    event_cooldowns_sec: {
        SURGE: 180,
        BREAKOUT: 120,
        REBREAK: 120,
        PULLBACK_READY: 180,
        RANK_JUMP: 300,
        COOLING: 120,
        INVALID: 60,
    },
    eligibility: {
        max_spread_pct: 0.8,
        min_turnover: 3_000_000,
        min_tick_count: 5,
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
        if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
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

let cached: IntradayRankConfig | null = null;

export function loadIntradayRankConfig(force = false): IntradayRankConfig {
    if (cached && !force) return cached;
    const here = dirname(fileURLToPath(import.meta.url));
    const yamlPath = join(
        here,
        '..',
        '..',
        '..',
        'config',
        'intraday_rank_config.yaml',
    );
    let over: Record<string, unknown> = {};
    if (existsSync(yamlPath)) {
        try {
            over = parseSimpleYaml(readFileSync(yamlPath, 'utf8'));
        } catch (err) {
            console.warn(
                'intraday_rank_config.yaml parse failed:',
                err instanceof Error ? err.message : err,
            );
        }
    }
    cached = deepMerge(
        DEFAULT_INTRADAY_RANK_CONFIG as unknown as Record<string, unknown>,
        over,
    ) as unknown as IntradayRankConfig;
    return cached;
}
