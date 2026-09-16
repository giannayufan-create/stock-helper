// server/src/lib/ai-interpretation/config.ts

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_INTERPRETATION_VERSION } from './types.ts';

export interface AiInterpretationWeights {
    core_strength: number;
    buy_volume: number;
    sector_context: number;
    market_context: number;
    structure_rank: number;
    data_confidence: number;
}

export interface AiInterpretationConfig {
    version: string;
    weights: AiInterpretationWeights;
    bp_confirmed_min: number;
    c_strong_min: number;
    c_watch_min: number;
    rvol_strong_min: number;
    vwap_above_min_pct: number;
    volume_accel_positive_min: number;
    rank_strong_max: number;
    rank_improve_min: number;
    sector_breadth_strong_min: number;
    sector_rs_positive_min: number;
    stale_score_cap: number;
    severe_missing_score_cap: number;
    coverage_severe_below: number;
    coverage_confidence_high_min: number;
    coverage_confidence_medium_min: number;
    radar_bp_confirmed_min: number;
    radar_sector_concentration_min: number;
    chase_extended: string[];
}

export const DEFAULT_AI_INTERPRETATION_CONFIG: AiInterpretationConfig = {
    version: AI_INTERPRETATION_VERSION,
    weights: {
        core_strength: 0.35,
        buy_volume: 0.25,
        sector_context: 0.15,
        market_context: 0.1,
        structure_rank: 0.1,
        data_confidence: 0.05,
    },
    bp_confirmed_min: 70,
    c_strong_min: 80,
    c_watch_min: 70,
    rvol_strong_min: 1.5,
    vwap_above_min_pct: 0,
    volume_accel_positive_min: 0,
    rank_strong_max: 30,
    rank_improve_min: 5,
    sector_breadth_strong_min: 0.55,
    sector_rs_positive_min: 0,
    stale_score_cap: 5.0,
    severe_missing_score_cap: 4.0,
    coverage_severe_below: 40,
    coverage_confidence_high_min: 75,
    coverage_confidence_medium_min: 55,
    radar_bp_confirmed_min: 70,
    radar_sector_concentration_min: 0.7,
    chase_extended: ['HIGH', 'EXTREME', 'high', 'extreme'],
};

function parseSimpleYaml(text: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    let listKey: string | null = null;
    const list: string[] = [];
    let nestKey: string | null = null;
    const nest: Record<string, unknown> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trimEnd();
        if (!line.trim()) continue;
        const listMatch = line.match(/^\s*-\s+(.+)$/);
        if (listMatch && listKey) {
            list.push(listMatch[1]!.trim().replace(/^["']|["']$/g, ''));
            continue;
        }
        const nestMatch = line.match(/^\s{2,}([A-Za-z0-9_]+):\s*(.*)$/);
        if (nestMatch && nestKey) {
            const k = nestMatch[1]!;
            const v = nestMatch[2]!.trim();
            nest[k] = Number.isFinite(Number(v)) ? Number(v) : v;
            continue;
        }
        if (listKey) {
            out[listKey] = [...list];
            list.length = 0;
            listKey = null;
        }
        if (nestKey && !nestMatch) {
            out[nestKey] = { ...nest };
            for (const k of Object.keys(nest)) delete nest[k];
            nestKey = null;
        }
        const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (!m) continue;
        const key = m[1]!;
        const val = m[2]!.trim();
        if (val === '') {
            if (key === 'weights') nestKey = key;
            else listKey = key;
            continue;
        }
        if (val === 'true') out[key] = true;
        else if (val === 'false') out[key] = false;
        else if (Number.isFinite(Number(val))) out[key] = Number(val);
        else out[key] = val.replace(/^["']|["']$/g, '');
    }
    if (listKey) out[listKey] = [...list];
    if (nestKey) out[nestKey] = { ...nest };
    return out;
}

export function loadAiInterpretationConfig(): AiInterpretationConfig {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, '..', '..', '..', 'config', 'ai_interpretation.yaml'),
        join(process.cwd(), 'config', 'ai_interpretation.yaml'),
    ];
    const base = { ...DEFAULT_AI_INTERPRETATION_CONFIG };
    for (const p of candidates) {
        if (!existsSync(p)) continue;
        try {
            const raw = parseSimpleYaml(readFileSync(p, 'utf8'));
            if (raw.weights && typeof raw.weights === 'object') {
                base.weights = {
                    ...base.weights,
                    ...(raw.weights as AiInterpretationWeights),
                };
            }
            for (const [k, v] of Object.entries(raw)) {
                if (k === 'weights') continue;
                if (k in base) (base as Record<string, unknown>)[k] = v;
            }
        } catch {
            /* keep defaults */
        }
        break;
    }
    return base;
}

export function configHash(cfg: AiInterpretationConfig): string {
    return createHash('sha256')
        .update(JSON.stringify(cfg))
        .digest('hex')
        .slice(0, 16);
}
