// src/lib/trigger-engine.ts — browser wiring for client-side stop-loss / take-profit.
// Core lifecycle lives in trigger-engine-core.ts (mock-testable, no Vite imports).
// IMPORTANT: monitoring only runs while this page is open — broker does NOT host stops.

import { useSyncExternalStore } from 'react';
import { getCapabilities } from './capabilities';
import { ensureContract } from './contracts-cache';
import { fetchPositions, fetchTrades } from './backend';
import { onAnyTick } from './stream';
import { notify, placeQuickOrder } from './trade';
import {
    TriggerEngineCore,
    type TriggerEngineDeps,
    type TriggerOrder,
    type TriggerEngineStatus,
    type TriggerLifecycle,
    TRIGGER_ENGINE_DISCLAIMER,
    BROKER_IDEMPOTENT_SUBMIT,
    SUBMIT_TIMEOUT_MS,
} from './trigger-engine-core';

export type {
    TriggerOrder,
    TriggerEngineStatus,
    TriggerLifecycle,
    TriggerEngineDeps,
};
export {
    TriggerEngineCore,
    TRIGGER_ENGINE_DISCLAIMER,
    BROKER_IDEMPOTENT_SUBMIT,
    SUBMIT_TIMEOUT_MS,
};

const STORAGE_KEY = 'sj-pro-triggers-v2';
const LEGACY_STORAGE_KEY = 'sj-pro-triggers';

function migrateLegacy(raw: unknown): TriggerOrder[] {
    if (!Array.isArray(raw)) return [];
    const now = Date.now();
    return raw.map((item, i) => {
        const t = item as Partial<TriggerOrder>;
        const created_at_ms = t.created_at_ms ?? now - i;
        const id =
            t.id && String(t.id).startsWith('tg-')
                ? String(t.id)
                : `tg-${t.code ?? 'UNK'}-${t.kind ?? 'stop'}-${created_at_ms}`;
        return {
            id,
            client_order_key: t.client_order_key ?? id,
            code: String(t.code ?? ''),
            condition: t.condition === 'above' ? 'above' : 'below',
            price: Number(t.price) || 0,
            action: t.action === 'Buy' ? 'Buy' : 'Sell',
            quantity: Math.max(1, Number(t.quantity) || 1),
            kind: t.kind === 'take' || t.kind === 'alert' ? t.kind : 'stop',
            group: t.group,
            status: (t.status as TriggerLifecycle) ?? 'armed',
            fail_reason: t.fail_reason ?? null,
            broker_order_id: t.broker_order_id ?? null,
            submitted_at_ms: t.submitted_at_ms ?? null,
            last_query_at_ms: t.last_query_at_ms ?? null,
            created_at_ms,
        };
    });
}

function loadFromStorage(): TriggerOrder[] {
    if (typeof localStorage === 'undefined') return [];
    try {
        const v2 = localStorage.getItem(STORAGE_KEY);
        if (v2) return migrateLegacy(JSON.parse(v2));
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy) {
            const migrated = migrateLegacy(JSON.parse(legacy));
            localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
            return migrated;
        }
    } catch {
        /* start clean */
    }
    return [];
}

function defaultDeps(): TriggerEngineDeps {
    return {
        placeOrder: async (contract, action, price, qty, opts) =>
            placeQuickOrder(contract, action, price, qty, {
                bypassRisk: opts?.bypassRisk,
            }),
        queryTrades: async () => {
            const [st, fu] = await Promise.allSettled([
                fetchTrades('S'),
                fetchTrades('F'),
            ]);
            return [
                ...(st.status === 'fulfilled' ? st.value : []),
                ...(fu.status === 'fulfilled' ? fu.value : []),
            ];
        },
        flattenableQty: async (code, action) => {
            try {
                const [sp, fp] = await Promise.allSettled([
                    fetchPositions('S'),
                    fetchPositions('F'),
                ]);
                let qty = 0;
                const stock = sp.status === 'fulfilled' ? sp.value : [];
                for (const p of stock) {
                    if (p.code !== code) continue;
                    const q = Number(p.quantity) || 0;
                    if (action === 'Sell' && p.direction === 'Buy') qty += q;
                    if (action === 'Buy' && p.direction === 'Sell') qty += q;
                }
                const fut = fp.status === 'fulfilled' ? fp.value : [];
                for (const p of fut) {
                    if (p.code !== code) continue;
                    const q = Number(p.quantity) || 0;
                    if (action === 'Sell' && p.direction === 'Buy') qty += q;
                    if (action === 'Buy' && p.direction === 'Sell') qty += q;
                }
                return qty;
            } catch {
                return null;
            }
        },
        ensureContract,
        notify,
        now: () => Date.now(),
        futuresTrading: () => getCapabilities().futures_trading,
        submitTimeoutMs: SUBMIT_TIMEOUT_MS,
    };
}

let core = new TriggerEngineCore(defaultDeps(), loadFromStorage());
core.setPersist((rows) => {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
    } catch {
        /* ignore quota */
    }
});

const listeners = new Set<() => void>();
core.subscribe(() => listeners.forEach((l) => l()));

/** Replace core (tests only). */
export function __setTriggerEngineForTests(next: TriggerEngineCore): void {
    core = next;
    core.subscribe(() => listeners.forEach((l) => l()));
}

export function getTriggerEngine(): TriggerEngineCore {
    return core;
}

export function addTrigger(
    t: Omit<
        TriggerOrder,
        'id' | 'client_order_key' | 'status' | 'created_at_ms'
    > &
        Partial<
            Pick<
                TriggerOrder,
                'id' | 'client_order_key' | 'status' | 'created_at_ms'
            >
        >,
): TriggerOrder {
    return core.add(t);
}

export function removeTrigger(id: string) {
    core.remove(id);
}

export function rearmTrigger(id: string): boolean {
    return core.rearm(id);
}

export function acknowledgeLockedTrigger(
    id: string,
    resumeArmed: boolean,
): boolean {
    return core.acknowledgeLocked(id, resumeArmed);
}

export function getTriggers(): TriggerOrder[] {
    return core.getAll();
}

export function getTriggerEngineStatus(): TriggerEngineStatus {
    return core.status();
}

export function useTriggers(): TriggerOrder[] {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => core.getAll(),
    );
}

export function useTriggerEngineStatus(): TriggerEngineStatus {
    return useSyncExternalStore(
        (l) => {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => core.status(),
    );
}

let engineStarted = false;
export function startTriggerEngine() {
    if (engineStarted) return;
    engineStarted = true;
    core.setRunning(true);
    void core.reconcileOnResume();
    onAnyTick((tick) => {
        const price = Number(tick.close);
        if (!Number.isFinite(price)) return;
        void core.onTick(tick.code, price);
    });
}
