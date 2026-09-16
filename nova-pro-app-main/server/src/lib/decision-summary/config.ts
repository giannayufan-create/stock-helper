// server/src/lib/decision-summary/config.ts

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DS_VERSION } from './types.ts';

export interface DecisionSummaryConfig {
    enabled: boolean;
    version: string;
    evaluate_interval_sec: number;
    c_min_watch: number;
    c_min_confirmed: number;
    bp_min_confirmed: number;
    rank_strong_max: number;
    rank_improve_min: number;
    rvol_strong_min: number;
    volume_accel_positive_min: number;
    vwap_above_min_pct: number;
    vwap_extended_pct: number;
    confirm_streak_required: number;
    coverage_not_ready_below: number;
    require_price: boolean;
    require_vwap: boolean;
    coverage_confidence_high_min: number;
    coverage_confidence_medium_min: number;
    context_coverage_weight: number;
    sector_breadth_strong_min: number;
    sector_rs_positive_min: number;
    chase_extended: string[];
}

export const DEFAULT_DS_CONFIG: DecisionSummaryConfig = {
    enabled: true,
    version: DS_VERSION,
    evaluate_interval_sec: 5,
    c_min_watch: 80,
    c_min_confirmed: 80,
    bp_min_confirmed: 70,
    rank_strong_max: 30,
    rank_improve_min: 5,
    rvol_strong_min: 1.5,
    volume_accel_positive_min: 0,
    vwap_above_min_pct: 0,
    vwap_extended_pct: 4,
    confirm_streak_required: 2,
    coverage_not_ready_below: 40,
    require_price: true,
    require_vwap: true,
    coverage_confidence_high_min: 75,
    coverage_confidence_medium_min: 55,
    context_coverage_weight: 0.25,
    sector_breadth_strong_min: 0.55,
    sector_rs_positive_min: 0,
    chase_extended: ['high', 'extreme', 'HIGH', 'EXTREME'],
};

function parseSimpleYaml(text: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let listKey: string | null = null;
    const list: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trimEnd();
        if (!line.trim()) continue;
        const listMatch = line.match(/^\s*-\s+(.+)$/);
        if (listMatch && listKey) {
            list.push(listMatch[1]!.trim().replace(/^["']|["']$/g, ''));
            continue;
        }
        if (listKey) {
            out[listKey] = [...list];
            list.length = 0;
            listKey = null;
        }
        const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (!m) continue;
        const key = m[1]!;
        const val = m[2]!.trim();
        if (val === '') {
            listKey = key;
            continue;
        }
        if (val === 'true') out[key] = true;
        else if (val === 'false') out[key] = false;
        else if (/^-?\d+(\.\d+)?$/.test(val)) out[key] = Number(val);
        else out[key] = val.replace(/^["']|["']$/g, '');
    }
    if (listKey) out[listKey] = [...list];
    return out;
}

function resolveConfigPath(): string | null {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, '../../../../config/decision_summary_config.yaml'),
        join(process.cwd(), 'config/decision_summary_config.yaml'),
        join(process.cwd(), 'server/config/decision_summary_config.yaml'),
    ];
    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    return null;
}

export function loadDecisionSummaryConfig(
    overridePath?: string,
): DecisionSummaryConfig {
    const path = overridePath ?? resolveConfigPath();
    if (!path) return { ...DEFAULT_DS_CONFIG };
    try {
        const raw = parseSimpleYaml(readFileSync(path, 'utf8'));
        const chase = Array.isArray(raw.chase_extended)
            ? (raw.chase_extended as string[])
            : DEFAULT_DS_CONFIG.chase_extended;
        return {
            ...DEFAULT_DS_CONFIG,
            ...Object.fromEntries(
                Object.entries(raw).filter(([k]) => k !== 'chase_extended'),
            ),
            chase_extended: chase,
            version: DS_VERSION,
        } as DecisionSummaryConfig;
    } catch {
        return { ...DEFAULT_DS_CONFIG };
    }
}
