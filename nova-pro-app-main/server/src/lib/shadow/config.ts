// Shadow multi-experiment config loader — never writes production yaml.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
    ShadowConfig,
    ShadowExperimentDef,
    ShadowPromotionConfig,
} from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PROMOTION: ShadowPromotionConfig = {
    auto_promote: false,
    max_mae_worsen_abs: 0.4,
    max_invalid_rate_worsen_pp: 5,
    min_days_improved_ratio: 0.6,
    max_signal_coverage_drop_pct: 35,
    min_stability_score: 0.45,
};

/** Round-1 fixed experiments (B 78→81, C 80/74→82/76). */
export const DEFAULT_EXPERIMENTS: ShadowExperimentDef[] = [
    {
        experiment_id: 'shadow_b_pass81_v1',
        label: 'SHADOW_B',
        open_gate: { pass_enter_threshold: 81 },
    },
    {
        experiment_id: 'shadow_c_82_76_v1',
        label: 'SHADOW_C',
        intraday_rank: { strong_enter: 82, strong_exit: 76 },
    },
    {
        experiment_id: 'shadow_bc_v1',
        label: 'SHADOW_BC',
        open_gate: { pass_enter_threshold: 81 },
        intraday_rank: { strong_enter: 82, strong_exit: 76 },
    },
];

export const DEFAULT_SHADOW_CONFIG: ShadowConfig = {
    enabled: true,
    min_shadow_days: 10,
    min_shadow_signals: 200,
    promotion_require_both_gates: true,
    require_learning_eligible: true,
    exclude_low_confidence_from_promotion: true,
    min_promotion_coverage_pct: 50,
    experiments: DEFAULT_EXPERIMENTS,
    promotion: { ...DEFAULT_PROMOTION },
};

function coerceNum(v: unknown, fallback: number): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
        return Number(v);
    }
    return fallback;
}

function coerceBool(v: unknown, fallback: boolean): boolean {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 'yes' || v === 1) return true;
    if (v === 'false' || v === 'no' || v === 0) return false;
    return fallback;
}

/** Minimal nested YAML (maps only — experiments as named map). */
function parseSimpleYaml(text: string): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
        { indent: -1, obj: root },
    ];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '');
        if (!line.trim()) continue;
        const indent = line.match(/^\s*/)?.[0].length ?? 0;
        const trimmed = line.trim();
        const m = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
        if (!m) continue;
        const key = m[1]!;
        const valRaw = m[2]!.trim();
        while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
            stack.pop();
        }
        const parent = stack[stack.length - 1]!.obj;
        if (valRaw === '') {
            const child: Record<string, unknown> = {};
            parent[key] = child;
            stack.push({ indent, obj: child });
        } else if (
            (valRaw.startsWith('"') && valRaw.endsWith('"')) ||
            (valRaw.startsWith("'") && valRaw.endsWith("'"))
        ) {
            parent[key] = valRaw.slice(1, -1);
        } else if (valRaw === 'true' || valRaw === 'false') {
            parent[key] = valRaw === 'true';
        } else if (/^-?\d+(\.\d+)?$/.test(valRaw)) {
            parent[key] = Number(valRaw);
        } else {
            parent[key] = valRaw;
        }
    }
    return root;
}

function parseExperiments(
    raw: unknown,
): ShadowExperimentDef[] {
    if (!raw || typeof raw !== 'object') return [...DEFAULT_EXPERIMENTS];
    const map = raw as Record<string, unknown>;
    const out: ShadowExperimentDef[] = [];
    for (const [id, body] of Object.entries(map)) {
        if (!body || typeof body !== 'object') continue;
        const b = body as Record<string, unknown>;
        const og = (b.open_gate ?? {}) as Record<string, unknown>;
        const ir = (b.intraday_rank ?? {}) as Record<string, unknown>;
        const open_gate: Record<string, number> = {};
        const intraday_rank: Record<string, number> = {};
        for (const [k, v] of Object.entries(og)) {
            if (typeof v === 'number') open_gate[k] = v;
        }
        for (const [k, v] of Object.entries(ir)) {
            if (typeof v === 'number') intraday_rank[k] = v;
        }
        out.push({
            experiment_id: id,
            label: String(b.label ?? id),
            ...(Object.keys(open_gate).length ? { open_gate } : {}),
            ...(Object.keys(intraday_rank).length ? { intraday_rank } : {}),
        });
    }
    return out.length ? out : [...DEFAULT_EXPERIMENTS];
}

export function resolveShadowConfigPath(custom?: string): string {
    if (custom) return resolve(custom);
    return resolve(__dirname, '../../../config/shadow_config.yaml');
}

let testOverride: ShadowConfig | null = null;

export function setShadowConfigForTest(cfg: ShadowConfig | null): void {
    testOverride = cfg;
}

export function reloadShadowConfig(path?: string): ShadowConfig {
    return loadShadowConfig(path);
}

export function loadShadowConfig(path?: string): ShadowConfig {
    if (testOverride) {
        return {
            ...testOverride,
            experiments: testOverride.experiments.map((e) => ({
                ...e,
                open_gate: e.open_gate ? { ...e.open_gate } : undefined,
                intraday_rank: e.intraday_rank
                    ? { ...e.intraday_rank }
                    : undefined,
            })),
            promotion: { ...testOverride.promotion, auto_promote: false },
        };
    }
    const p = resolveShadowConfigPath(path);
    const base: ShadowConfig = {
        ...DEFAULT_SHADOW_CONFIG,
        experiments: DEFAULT_EXPERIMENTS.map((e) => ({
            ...e,
            open_gate: e.open_gate ? { ...e.open_gate } : undefined,
            intraday_rank: e.intraday_rank
                ? { ...e.intraday_rank }
                : undefined,
        })),
        promotion: { ...DEFAULT_PROMOTION, auto_promote: false },
    };
    if (!existsSync(p)) return base;

    const raw = parseSimpleYaml(readFileSync(p, 'utf8'));
    const promoRaw = (raw.promotion ?? {}) as Record<string, unknown>;

    base.enabled = coerceBool(raw.enabled, base.enabled);
    base.min_shadow_days = coerceNum(
        raw.min_shadow_days,
        base.min_shadow_days,
    );
    base.min_shadow_signals = coerceNum(
        raw.min_shadow_signals,
        base.min_shadow_signals,
    );
    base.promotion_require_both_gates = coerceBool(
        raw.promotion_require_both_gates,
        true,
    );
    base.require_learning_eligible = coerceBool(
        raw.require_learning_eligible,
        true,
    );
    base.exclude_low_confidence_from_promotion = coerceBool(
        raw.exclude_low_confidence_from_promotion,
        true,
    );
    base.min_promotion_coverage_pct = coerceNum(
        raw.min_promotion_coverage_pct,
        base.min_promotion_coverage_pct,
    );

    if (raw.experiments) {
        base.experiments = parseExperiments(raw.experiments);
    }

    base.promotion = {
        auto_promote: false,
        max_mae_worsen_abs: coerceNum(
            promoRaw.max_mae_worsen_abs,
            DEFAULT_PROMOTION.max_mae_worsen_abs,
        ),
        max_invalid_rate_worsen_pp: coerceNum(
            promoRaw.max_invalid_rate_worsen_pp,
            DEFAULT_PROMOTION.max_invalid_rate_worsen_pp,
        ),
        min_days_improved_ratio: coerceNum(
            promoRaw.min_days_improved_ratio,
            DEFAULT_PROMOTION.min_days_improved_ratio,
        ),
        max_signal_coverage_drop_pct: coerceNum(
            promoRaw.max_signal_coverage_drop_pct,
            DEFAULT_PROMOTION.max_signal_coverage_drop_pct,
        ),
        min_stability_score: coerceNum(
            promoRaw.min_stability_score,
            DEFAULT_PROMOTION.min_stability_score,
        ),
    };

    return base;
}

export function mergeNumericOverlay<T extends Record<string, unknown>>(
    base: T,
    overlay?: Record<string, number>,
): T {
    if (!overlay || !Object.keys(overlay).length) {
        return structuredClone(base);
    }
    const out = structuredClone(base) as Record<string, unknown>;
    for (const [k, v] of Object.entries(overlay)) {
        if (k in out && typeof v === 'number' && Number.isFinite(v)) {
            out[k] = v;
        }
    }
    return out as T;
}

/** Shallow+nested object merge (compat for tests / overlays). */
export function deepMerge<T extends Record<string, unknown>>(
    base: T,
    overlay?: Record<string, unknown> | null,
): T {
    if (!overlay) return structuredClone(base);
    const out = structuredClone(base) as Record<string, unknown>;
    for (const [k, v] of Object.entries(overlay)) {
        if (
            v &&
            typeof v === 'object' &&
            !Array.isArray(v) &&
            out[k] &&
            typeof out[k] === 'object' &&
            !Array.isArray(out[k])
        ) {
            out[k] = deepMerge(
                out[k] as Record<string, unknown>,
                v as Record<string, unknown>,
            );
        } else if (v !== undefined) {
            out[k] = v;
        }
    }
    return out as T;
}
