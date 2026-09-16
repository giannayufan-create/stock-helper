// server/src/lib/web-notifications/config.ts

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NotificationEventType } from './types.ts';
import { WN_VERSION } from './types.ts';

export interface WebNotificationConfig {
    enabled: boolean;
    version: string;
    max_stored: number;
    cooldown_sec: Record<NotificationEventType, number>;
    /** Events that never toast by default */
    no_toast: string[];
}

export const DEFAULT_WN_CONFIG: WebNotificationConfig = {
    enabled: true,
    version: WN_VERSION,
    max_stored: 200,
    cooldown_sec: {
        EARLY_ENTER: 300,
        BUY_SURGE: 300,
        ASK_EATING: 180,
        VOLUME_BREAKOUT: 300,
        OVERHEATED_STRONG: 600,
        LARGE_BID_APPEAR: 300,
        RANK_ACCELERATION: 300,
    },
    no_toast: ['ASK_CANCEL', 'COOLING', 'LARGE_BID_CANCEL'],
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
        while (
            stack.length > 1 &&
            indent <= (stack[stack.length - 1]?.indent ?? -1)
        ) {
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

export function loadWebNotificationConfig(): WebNotificationConfig {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, '../../../config/web_notification_config.yaml'),
        join(process.cwd(), 'config/web_notification_config.yaml'),
        join(process.cwd(), 'server/config/web_notification_config.yaml'),
    ];
    for (const p of candidates) {
        if (!existsSync(p)) continue;
        try {
            const parsed = parseSimpleYaml(readFileSync(p, 'utf8'));
            return deepMerge(
                DEFAULT_WN_CONFIG as unknown as Record<string, unknown>,
                parsed,
            ) as unknown as WebNotificationConfig;
        } catch {
            // fallthrough
        }
    }
    return { ...DEFAULT_WN_CONFIG };
}
