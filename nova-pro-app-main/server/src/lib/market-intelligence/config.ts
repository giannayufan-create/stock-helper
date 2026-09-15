// server/src/lib/market-intelligence/config.ts

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MI_VERSION } from './types.ts';

export interface MiHeatWeights {
    breadth: number;
    participation: number;
    leader_strength: number;
    volume_acceleration: number;
    rank_momentum: number;
    event_density: number;
}

export interface MarketIntelligenceConfig {
    enabled: boolean;
    version: string;
    refresh: {
        global_sec: number;
        sector_heat_sec: number;
        theme_heat_sec: number;
        news_sec: number;
        company_events_sec: number;
        ai_brief_sec: number;
        persist_heat_sec: number;
    };
    sector_heat: MiHeatWeights;
    theme_heat: MiHeatWeights;
    coverage: {
        high_min_covered: number;
        high_min_pct: number;
        medium_min_covered: number;
        medium_min_pct: number;
        min_eligible_covered: number;
        leader_top_pct: number;
        leader_top_max: number;
    };
    news: {
        symbol_ttl_sec: number;
        sector_ttl_sec: number;
        theme_ttl_sec: number;
        global_ttl_sec: number;
        max_per_query: number;
        max_headlines_overview: number;
    };
    ai_brief: {
        enabled: boolean;
        ttl_sec: number;
    };
    snapshot_history_minutes: number;
}

export const DEFAULT_MI_CONFIG: MarketIntelligenceConfig = {
    enabled: true,
    version: MI_VERSION,
    refresh: {
        global_sec: 60,
        sector_heat_sec: 15,
        theme_heat_sec: 15,
        news_sec: 600,
        company_events_sec: 600,
        ai_brief_sec: 600,
        persist_heat_sec: 180,
    },
    sector_heat: {
        breadth: 0.25,
        participation: 0.25,
        leader_strength: 0.2,
        volume_acceleration: 0.15,
        rank_momentum: 0.1,
        event_density: 0.05,
    },
    theme_heat: {
        breadth: 0.25,
        participation: 0.25,
        leader_strength: 0.2,
        volume_acceleration: 0.15,
        rank_momentum: 0.1,
        event_density: 0.05,
    },
    coverage: {
        high_min_covered: 10,
        high_min_pct: 70,
        medium_min_covered: 5,
        medium_min_pct: 50,
        min_eligible_covered: 3,
        leader_top_pct: 0.2,
        leader_top_max: 5,
    },
    news: {
        symbol_ttl_sec: 480,
        sector_ttl_sec: 600,
        theme_ttl_sec: 600,
        global_ttl_sec: 720,
        max_per_query: 8,
        max_headlines_overview: 12,
    },
    ai_brief: {
        enabled: true,
        ttl_sec: 600,
    },
    snapshot_history_minutes: 20,
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

export function loadMarketIntelligenceConfig(): MarketIntelligenceConfig {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = join(here, '..', '..', '..', 'config', 'market_intelligence_config.yaml');
    if (!existsSync(path)) return { ...DEFAULT_MI_CONFIG };
    try {
        const parsed = parseSimpleYaml(readFileSync(path, 'utf8'));
        return deepMerge(
            DEFAULT_MI_CONFIG as unknown as Record<string, unknown>,
            parsed,
        ) as unknown as MarketIntelligenceConfig;
    } catch {
        return { ...DEFAULT_MI_CONFIG };
    }
}

export function miConfigHash(cfg: MarketIntelligenceConfig): string {
    return createHash('sha256')
        .update(JSON.stringify(cfg))
        .digest('hex')
        .slice(0, 12);
}
