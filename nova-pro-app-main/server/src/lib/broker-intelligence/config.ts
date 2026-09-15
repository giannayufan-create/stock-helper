// server/src/lib/broker-intelligence/config.ts

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BI_VERSION } from './types.ts';

export interface BrokerIntelligenceConfig {
    enabled: boolean;
    version: string;
    provider: string;
    cache: { eod_ttl_sec: number; ranking_ttl_sec: number };
    history: { max_lookback_days: number; windows: number[] };
    main_force: {
        top3_weight: number;
        top5_weight: number;
        persistence_weight: number;
        consistency_weight: number;
    };
    ranking_guards: {
        min_total_branch_volume: number;
        min_positive_volume: number;
        min_active_branches: number;
        min_coverage_days_for_10d: number;
        min_coverage_days_for_20d: number;
    };
    alignment: {
        min_main_force_score: number;
        min_c_score: number;
    };
}

export const DEFAULT_BI_CONFIG: BrokerIntelligenceConfig = {
    enabled: true,
    version: BI_VERSION,
    provider: 'unavailable',
    cache: { eod_ttl_sec: 1800, ranking_ttl_sec: 300 },
    history: { max_lookback_days: 20, windows: [1, 3, 5, 10, 20] },
    main_force: {
        top3_weight: 0.35,
        top5_weight: 0.25,
        persistence_weight: 0.2,
        consistency_weight: 0.2,
    },
    ranking_guards: {
        min_total_branch_volume: 500,
        min_positive_volume: 200,
        min_active_branches: 3,
        min_coverage_days_for_10d: 8,
        min_coverage_days_for_20d: 15,
    },
    alignment: {
        min_main_force_score: 70,
        min_c_score: 75,
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
                .map((x) => {
                    const t = x.trim();
                    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
                    return t;
                })
                .filter((x) => x !== '');
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
        const colon = trimmed.indexOf(':');
        if (colon < 0) continue;
        const key = trimmed.slice(0, colon).trim();
        const rest = trimmed.slice(colon + 1);
        while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
            stack.pop();
        }
        const parent = stack[stack.length - 1]!.obj;
        if (!rest.trim()) {
            const child: Record<string, unknown> = {};
            parent[key] = child;
            stack.push({ indent, obj: child });
        } else {
            parent[key] = parseScalar(rest);
        }
    }
    return root;
}

export function loadBrokerIntelligenceConfig(): BrokerIntelligenceConfig {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(
        here,
        '..',
        '..',
        '..',
        'config',
        'broker_intelligence_config.yaml',
    );
    if (!existsSync(path)) return { ...DEFAULT_BI_CONFIG };
    try {
        const parsed = parseSimpleYaml(readFileSync(path, 'utf8'));
        return deepMerge(
            DEFAULT_BI_CONFIG as unknown as Record<string, unknown>,
            parsed,
        ) as unknown as BrokerIntelligenceConfig;
    } catch {
        return { ...DEFAULT_BI_CONFIG };
    }
}
