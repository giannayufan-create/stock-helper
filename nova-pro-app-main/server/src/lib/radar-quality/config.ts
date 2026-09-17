// server/src/lib/radar-quality/config.ts

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RQ_VERSION } from './types.ts';

export interface RadarQualityConfig {
    enabled: boolean;
    version: string;
    evaluate_interval_sec: number;
    active_min_confirmations: number;
    active_bp_strong_min: number;
    active_momentum_accel_min: number;
    active_volume_accel_min: number;
    active_rank_velocity_min: number;
    active_rvol_min: number;
    active_vwap_above_min_pct: number;
    active_c_state_strong: string[];
    active_bp_states: string[];
    active_sector_states: string[];
    bp_weak_max: number;
    momentum_weak_max: number;
    volume_accel_weak_max: number;
    rank_velocity_weak_max: number;
    coverage_not_ready_below: number;
    block_stale_from_active: boolean;
    active_enter_confirmations: number;
    active_exit_confirmations: number;
    focus_leader_min_hold_seconds: number;
    focus_switch_confirmations: number;
    focus_switch_margin: number;
    focus_top_n: number;
    foreign_strong_accumulation_min_shares: number;
    foreign_accumulation_min_shares: number;
    foreign_distribution_max_shares: number;
    trust_accumulation_min_shares: number;
}

export const DEFAULT_RQ_CONFIG: RadarQualityConfig = {
    enabled: true,
    version: RQ_VERSION,
    evaluate_interval_sec: 5,
    active_min_confirmations: 2,
    active_bp_strong_min: 70,
    active_momentum_accel_min: 0,
    active_volume_accel_min: 0,
    active_rank_velocity_min: 1,
    active_rvol_min: 1.2,
    active_vwap_above_min_pct: 0,
    active_c_state_strong: ['STRONG', 'HEATING'],
    active_bp_states: ['BUY_SURGE', 'ASK_EATING', 'VOLUME_BREAKOUT', 'EARLY'],
    active_sector_states: ['ROTATING_IN', 'HOT', 'LEADING'],
    bp_weak_max: 40,
    momentum_weak_max: 0,
    volume_accel_weak_max: 0,
    rank_velocity_weak_max: 0,
    coverage_not_ready_below: 40,
    block_stale_from_active: true,
    active_enter_confirmations: 2,
    active_exit_confirmations: 3,
    focus_leader_min_hold_seconds: 60,
    focus_switch_confirmations: 3,
    focus_switch_margin: 5,
    focus_top_n: 3,
    foreign_strong_accumulation_min_shares: 500_000,
    foreign_accumulation_min_shares: 100_000,
    foreign_distribution_max_shares: -100_000,
    trust_accumulation_min_shares: 50_000,
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
        join(here, '../../../../config/radar_quality_config.yaml'),
        join(process.cwd(), 'config/radar_quality_config.yaml'),
        join(process.cwd(), 'server/config/radar_quality_config.yaml'),
    ];
    for (const p of candidates) {
        if (existsSync(p)) return p;
    }
    return null;
}

export function loadRadarQualityConfig(): RadarQualityConfig {
    const path = resolveConfigPath();
    if (!path) return { ...DEFAULT_RQ_CONFIG };
    try {
        const raw = parseSimpleYaml(readFileSync(path, 'utf8'));
        return {
            ...DEFAULT_RQ_CONFIG,
            ...raw,
            active_c_state_strong: Array.isArray(raw.active_c_state_strong)
                ? (raw.active_c_state_strong as string[])
                : DEFAULT_RQ_CONFIG.active_c_state_strong,
            active_bp_states: Array.isArray(raw.active_bp_states)
                ? (raw.active_bp_states as string[])
                : DEFAULT_RQ_CONFIG.active_bp_states,
            active_sector_states: Array.isArray(raw.active_sector_states)
                ? (raw.active_sector_states as string[])
                : DEFAULT_RQ_CONFIG.active_sector_states,
            version: RQ_VERSION,
        } as RadarQualityConfig;
    } catch {
        return { ...DEFAULT_RQ_CONFIG };
    }
}
