// server/src/lib/learning/config.ts — load learning_config.yaml (simple YAML)

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LearningConfig } from './types.ts';

const DEFAULT: LearningConfig = {
    dataset: {
        signal_schema_version: 'strategy-signal-v1',
        outcome_schema_version: 'signal-outcome-v1',
        learning_schema_version: 'learning-dataset-v1',
        require_learning_eligible: true,
        exclude_universe_sources: ['synthetic', 'manual_test'],
        exclude_score_confidence: ['low'],
        exclude_outcome_status: ['invalid_data'],
        exclude_replay_quality_invalid: true,
    },
    sample_guards: {
        min_sample_warning: 30,
        min_sample_recommendation: 100,
        min_combo_sample: 40,
        insufficient_below: 30,
        exploratory_below: 100,
    },
    quality_score: {
        forward_return_15m_weight: 1.0,
        mfe_15m_weight: 0.6,
        mae_15m_penalty: 1.2,
        invalid_hit_penalty: 2.0,
        ambiguous_penalty: 0.5,
    },
    objective: {
        positive_15m_weight: 40,
        avg_mfe_15m_weight: 20,
        avg_mae_15m_penalty: 25,
        invalid_rate_penalty: 30,
        instability_penalty: 20,
        low_sample_penalty: 40,
        complexity_penalty: 15,
        count_drop_soft_penalty: 5,
    },
    walk_forward: {
        train_months_min: 2,
        validate_months: 1,
        holdout_months: 1,
        holdout_tail_months: 1,
    },
    search: {
        open_gate_pass_enter: [76, 78, 80, 82, 85],
        open_gate_pass_exit: [72, 74, 76],
        intraday_strong_enter: [76, 78, 80, 82, 85],
        intraday_strong_exit: [70, 74, 76],
        weight_perturb_pct: [-10, 0, 10],
        max_stage2_candidates: 12,
    },
    recommendation: {
        min_folds_improved_ratio: 0.6,
        max_mae_worsen_abs: 0.4,
        max_invalid_rate_worsen_pp: 5,
        min_stability_score: 0.45,
        max_count_drop_pct: 35,
    },
    shadow: {
        enabled: false,
        min_shadow_days: 10,
        min_shadow_signals: 200,
        reuse_market_runtime: true,
    },
    promotion: {
        auto_promote: false,
        status_when_ready: 'READY_FOR_MANUAL_REVIEW',
    },
    feature_buckets: {
        rvol: [
            { label: '<1.0', max: 1.0 },
            { label: '1.0-1.5', min: 1.0, max: 1.5 },
            { label: '1.5-2.0', min: 1.5, max: 2.0 },
            { label: '2.0-3.0', min: 2.0, max: 3.0 },
            { label: '3.0+', min: 3.0 },
        ],
        vwap_pos: [
            { label: '<0', max: 0 },
            { label: '0-0.5%', min: 0, max: 0.5 },
            { label: '0.5-1%', min: 0.5, max: 1.0 },
            { label: '1-2%', min: 1.0, max: 2.0 },
            { label: '2%+', min: 2.0 },
        ],
        heat: [
            { label: 'Heat <70', max: 70 },
            { label: '70-79', min: 70, max: 80 },
            { label: '80-89', min: 80, max: 90 },
            { label: '90+', min: 90 },
        ],
        open_score: [
            { label: '78-81', min: 78, max: 82 },
            { label: '82-85', min: 82, max: 86 },
            { label: '86-89', min: 86, max: 90 },
            { label: '90+', min: 90 },
        ],
        intraday_score: [
            { label: '60-69', min: 60, max: 70 },
            { label: '70-79', min: 70, max: 80 },
            { label: '80-84', min: 80, max: 85 },
            { label: '85-89', min: 85, max: 90 },
            { label: '90+', min: 90 },
        ],
    },
    time_of_day: [
        { label: '09:00-09:30', min_minute: 0, max_minute: 30 },
        { label: '09:30-10:30', min_minute: 30, max_minute: 90 },
        { label: '10:30-11:30', min_minute: 90, max_minute: 150 },
        { label: '11:30-12:30', min_minute: 150, max_minute: 210 },
        { label: '12:30-13:30', min_minute: 210, max_minute: 270 },
    ],
    regimes: [
        'strong_bull',
        'bull',
        'neutral',
        'bear',
        'strong_bear',
    ],
};

function parseScalar(raw: string): unknown {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null' || raw === '~') return null;
    if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
    ) {
        return raw.slice(1, -1);
    }
    const n = Number(raw);
    if (raw !== '' && !Number.isNaN(n)) return n;
    return raw;
}

function parseSimpleYaml(text: string): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    const stack: Array<{ indent: number; obj: Record<string, unknown> | unknown[] }> =
        [{ indent: -1, obj: root }];
    let pendingListKey: { parent: Record<string, unknown>; key: string } | null =
        null;

    for (const line of text.split(/\r?\n/)) {
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const indent = line.match(/^\s*/)?.[0].length ?? 0;
        const trimmed = line.trim();

        if (trimmed.startsWith('- ')) {
            while (
                stack.length > 1 &&
                indent <= (stack[stack.length - 1]?.indent ?? -1)
            ) {
                stack.pop();
            }
            const parent = stack[stack.length - 1]?.obj;
            let list: unknown[];
            if (Array.isArray(parent)) {
                list = parent;
            } else if (pendingListKey) {
                list = [];
                pendingListKey.parent[pendingListKey.key] = list;
                // Drop empty placeholder object pushed when `key:` was seen
                if (
                    stack.length > 1 &&
                    !Array.isArray(stack[stack.length - 1]!.obj)
                ) {
                    stack.pop();
                }
                // List indent must be < item indent so sibling `-` won't pop the list
                stack.push({ indent: Math.max(0, indent - 1), obj: list });
                pendingListKey = null;
            } else {
                continue;
            }
            const itemRaw = trimmed.slice(2).trim();
            const km = itemRaw.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
            if (km) {
                const obj: Record<string, unknown> = {};
                const rest = (km[2] ?? '').replace(/\s+#.*$/, '').trim();
                if (rest === '') {
                    list.push(obj);
                    stack.push({ indent, obj });
                } else {
                    obj[km[1]!] = parseScalar(rest);
                    list.push(obj);
                    // Keep object on stack so following indented keys attach (min/max).
                    stack.push({ indent, obj });
                }
            } else {
                list.push(parseScalar(itemRaw.replace(/\s+#.*$/, '').trim()));
            }
            continue;
        }

        const m = trimmed.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1] ?? '';
        const rest = (m[2] ?? '').replace(/\s+#.*$/, '').trim();

        while (
            stack.length > 1 &&
            indent <= (stack[stack.length - 1]?.indent ?? -1)
        ) {
            stack.pop();
        }
        const parent = stack[stack.length - 1]?.obj;
        if (!parent || Array.isArray(parent)) continue;

        if (rest === '') {
            const child: Record<string, unknown> = {};
            parent[key] = child;
            pendingListKey = { parent, key };
            stack.push({ indent, obj: child });
        } else {
            pendingListKey = null;
            parent[key] = parseScalar(rest);
        }
    }
    return root;
}

function deepMerge(
    base: Record<string, unknown>,
    over: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) {
        if (
            v &&
            typeof v === 'object' &&
            !Array.isArray(v) &&
            typeof out[k] === 'object' &&
            out[k] &&
            !Array.isArray(out[k])
        ) {
            out[k] = deepMerge(
                out[k] as Record<string, unknown>,
                v as Record<string, unknown>,
            );
        } else {
            out[k] = v;
        }
    }
    return out;
}

let cached: LearningConfig | null = null;

export function loadLearningConfig(force = false): LearningConfig {
    if (cached && !force) return cached;
    const here = dirname(fileURLToPath(import.meta.url));
    const yamlPath = join(
        here,
        '..',
        '..',
        '..',
        'config',
        'learning_config.yaml',
    );
    let over: Record<string, unknown> = {};
    if (existsSync(yamlPath)) {
        try {
            over = parseSimpleYaml(readFileSync(yamlPath, 'utf8'));
        } catch (err) {
            console.warn(
                'learning_config.yaml parse failed, using defaults:',
                err instanceof Error ? err.message : err,
            );
        }
    }
    cached = deepMerge(
        DEFAULT as unknown as Record<string, unknown>,
        over,
    ) as unknown as LearningConfig;
    // Hard rule: never auto-promote
    cached.promotion.auto_promote = false;
    return cached;
}

export function reloadLearningConfig(): LearningConfig {
    return loadLearningConfig(true);
}
