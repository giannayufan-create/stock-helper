// src/lib/trigger-engine-core.ts — pure trigger lifecycle (no broker/Vite imports).
// Mock tests import this file only.

import type { Action, Trade } from './types/order';
import type { ContractBase } from './types/contract';

function isFuturesLike(contract: ContractBase): boolean {
    return contract.security_type === 'FUT' || contract.security_type === 'OPT';
}

/** Explicit lifecycle — UI and recovery depend on these states. */
export type TriggerLifecycle =
    | 'armed' // 待觸發
    | 'submitting' // 送單中
    | 'accepted' // 已受理
    | 'partial_fill' // 部分成交
    | 'filled' // 已成交
    | 'rejected' // 明確拒單（保留設定，不每 tick 重送）
    | 'uncertain' // 逾時／斷線，狀態待確認
    | 'locked' // 無法確認 → 鎖組，需人工
    | 'oco_suspended' // OCO 同組另一側送單中，暫掛（非永久刪除）
    | 'done'; // 終態（成功後歸檔或人工取消）

export interface TriggerOrder {
    id: string;
    /** Stable per trigger instance — used for re-entry guards / correlation. */
    client_order_key: string;
    code: string;
    condition: 'below' | 'above';
    price: number;
    action: Action;
    quantity: number;
    kind: 'stop' | 'take' | 'alert';
    group?: string;
    status: TriggerLifecycle;
    fail_reason?: string | null;
    broker_order_id?: string | null;
    submitted_at_ms?: number | null;
    last_query_at_ms?: number | null;
    created_at_ms: number;
}

export interface TriggerEngineStatus {
    running: boolean;
    /** True only while startTriggerEngine has been called and tab is alive. */
    page_monitoring: boolean;
    disclaimer: string;
    armed_count: number;
    active_count: number;
    locked_count: number;
    rejected_count: number;
    broker_hosted: false;
}

export const TRIGGER_ENGINE_DISCLAIMER =
    '觸價監控僅在本頁面開啟時運作；券商未託管此停損／停利。關閉或重整頁面後監控即停止。';

/** Broker submit is not guaranteed idempotent — document for operators. */
export const BROKER_IDEMPOTENT_SUBMIT =
    false as const;

export const SUBMIT_TIMEOUT_MS = 15_000;

export type PlaceOrderFn = (
    contract: ContractBase,
    action: Action,
    price: number | null,
    quantity: number,
    opts?: { bypassRisk?: boolean; clientOrderKey?: string },
) => Promise<Trade>;

export type QueryTradesFn = () => Promise<Trade[]>;
export type FlattenableQtyFn = (
    code: string,
    action: Action,
) => Promise<number | null>;
export type EnsureContractFn = (code: string) => Promise<ContractBase>;
export type NotifyFn = (n: {
    kind: 'ok' | 'err' | 'info';
    title: string;
    body: string;
}) => void;

export interface TriggerEngineDeps {
    placeOrder: PlaceOrderFn;
    queryTrades: QueryTradesFn;
    flattenableQty: FlattenableQtyFn;
    ensureContract: EnsureContractFn;
    notify: NotifyFn;
    now: () => number;
    futuresTrading: () => boolean;
    submitTimeoutMs?: number;
}

const NON_FIREABLE: ReadonlySet<TriggerLifecycle> = new Set([
    'submitting',
    'accepted',
    'partial_fill',
    'filled',
    'rejected',
    'uncertain',
    'locked',
    'oco_suspended',
    'done',
]);

function newStableId(parts: {
    code: string;
    kind: string;
    group?: string;
    created_at_ms: number;
}): string {
    const g = parts.group ? parts.group.replace(/[^a-zA-Z0-9_-]/g, '') : 'solo';
    const rnd =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID().slice(0, 8)
            : Math.random().toString(36).slice(2, 10);
    return `tg-${parts.code}-${g}-${parts.kind}-${parts.created_at_ms}-${rnd}`;
}


/** Core engine — injectable for mock tests (no real broker). */
export class TriggerEngineCore {
    private triggers: TriggerOrder[] = [];
    private listeners = new Set<() => void>();
    /** In-flight fire guards by trigger id. */
    private firing = new Set<string>();
    /** Groups currently submitting — blocks OCO dual fire. */
    private groupInFlight = new Set<string>();
    private running = false;
    private persistFn: ((rows: TriggerOrder[]) => void) | null = null;

    constructor(
        private deps: TriggerEngineDeps,
        initial: TriggerOrder[] = [],
    ) {
        this.triggers = initial.map((t) => ({ ...t }));
    }

    setPersist(fn: (rows: TriggerOrder[]) => void): void {
        this.persistFn = fn;
    }

    subscribe(l: () => void): () => void {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
    }

    private emit(): void {
        this.persistFn?.(this.triggers.map((t) => ({ ...t })));
        this.listeners.forEach((l) => l());
    }

    getAll(): TriggerOrder[] {
        return this.triggers.map((t) => ({ ...t }));
    }

    getMonitorable(): TriggerOrder[] {
        return this.getAll().filter(
            (t) => t.status === 'armed' || t.status === 'oco_suspended',
        );
    }

    status(): TriggerEngineStatus {
        const all = this.triggers;
        return {
            running: this.running,
            page_monitoring: this.running,
            disclaimer: TRIGGER_ENGINE_DISCLAIMER,
            armed_count: all.filter((t) => t.status === 'armed').length,
            active_count: all.filter((t) =>
                ['submitting', 'accepted', 'partial_fill', 'uncertain'].includes(
                    t.status,
                ),
            ).length,
            locked_count: all.filter((t) => t.status === 'locked').length,
            rejected_count: all.filter((t) => t.status === 'rejected').length,
            broker_hosted: false,
        };
    }

    setRunning(v: boolean): void {
        this.running = v;
        this.emit();
    }

    add(t: Omit<TriggerOrder, 'id' | 'client_order_key' | 'status' | 'created_at_ms'> & {
        id?: string;
        client_order_key?: string;
        status?: TriggerLifecycle;
        created_at_ms?: number;
    }): TriggerOrder {
        const created_at_ms = t.created_at_ms ?? this.deps.now();
        const id =
            t.id ??
            newStableId({
                code: t.code,
                kind: t.kind,
                group: t.group,
                created_at_ms,
            });
        const row: TriggerOrder = {
            ...t,
            id,
            client_order_key: t.client_order_key ?? id,
            status: t.status ?? 'armed',
            fail_reason: t.fail_reason ?? null,
            broker_order_id: t.broker_order_id ?? null,
            submitted_at_ms: t.submitted_at_ms ?? null,
            last_query_at_ms: t.last_query_at_ms ?? null,
            created_at_ms,
        };
        this.triggers = [...this.triggers, row];
        this.emit();
        const kindLabel =
            row.kind === 'stop'
                ? '⛔ 停損單已掛'
                : row.kind === 'take'
                  ? '🎯 停利單已掛'
                  : '🔔 警示已設';
        this.deps.notify({
            kind: 'info',
            title: kindLabel,
            body:
                row.kind === 'alert'
                    ? `${row.code} 觸價 ${row.condition === 'below' ? '≤' : '≥'} ${row.price} 時通知`
                    : `${row.code} 觸價 ${row.condition === 'below' ? '≤' : '≥'} ${row.price} → 市價${row.action === 'Buy' ? '買' : '賣'} ${row.quantity}${row.group ? '（OCO）' : ''}｜${TRIGGER_ENGINE_DISCLAIMER}`,
        });
        return { ...row };
    }

    remove(id: string): void {
        this.triggers = this.triggers.filter((t) => t.id !== id);
        this.emit();
    }

    /** Manual recovery after explicit reject — re-arm without resubmitting blindly. */
    rearm(id: string): boolean {
        const t = this.triggers.find((x) => x.id === id);
        if (!t) return false;
        if (t.status !== 'rejected' && t.status !== 'locked') return false;
        t.status = 'armed';
        t.fail_reason = null;
        t.broker_order_id = null;
        t.submitted_at_ms = null;
        if (t.group) this.groupInFlight.delete(t.group);
        // Restore OCO siblings that were suspended/locked with this group
        if (t.group) {
            for (const sib of this.triggers) {
                if (
                    sib.group === t.group &&
                    sib.id !== t.id &&
                    (sib.status === 'oco_suspended' ||
                        sib.status === 'locked' ||
                        sib.status === 'rejected')
                ) {
                    sib.status = 'armed';
                    sib.fail_reason = null;
                }
            }
        }
        this.emit();
        this.deps.notify({
            kind: 'info',
            title: '觸價單已人工恢復',
            body: `${t.code} ${t.kind} 重新進入待觸發`,
        });
        return true;
    }

    /** Ack locked uncertain after human verified no duplicate order. */
    acknowledgeLocked(id: string, resumeArmed: boolean): boolean {
        const t = this.triggers.find((x) => x.id === id);
        if (!t || t.status !== 'locked') return false;
        if (resumeArmed) {
            return this.rearm(id);
        }
        t.status = 'done';
        if (t.group) this.groupInFlight.delete(t.group);
        this.emit();
        return true;
    }

    private patch(id: string, patch: Partial<TriggerOrder>): void {
        this.triggers = this.triggers.map((t) =>
            t.id === id ? { ...t, ...patch } : t,
        );
        this.emit();
    }

    private setGroupStatus(
        group: string,
        exceptId: string,
        status: TriggerLifecycle,
        fail_reason?: string | null,
    ): void {
        this.triggers = this.triggers.map((t) => {
            if (t.group !== group || t.id === exceptId) return t;
            return { ...t, status, fail_reason: fail_reason ?? t.fail_reason };
        });
        this.emit();
    }

    /**
     * On page restore / reconnect: reconcile submitting|uncertain|accepted
     * against broker trades before arming monitor again.
     */
    async reconcileOnResume(): Promise<void> {
        const pending = this.triggers.filter((t) =>
            ['submitting', 'uncertain', 'accepted', 'partial_fill'].includes(
                t.status,
            ),
        );
        if (!pending.length) return;
        let trades: Trade[] = [];
        try {
            trades = await this.deps.queryTrades();
        } catch {
            for (const t of pending) {
                this.patch(t.id, {
                    status: 'locked',
                    fail_reason:
                        '恢復時無法查詢委託；請人工核對後再恢復監控（不可自動重送）',
                });
                if (t.group) this.groupInFlight.add(t.group);
            }
            this.deps.notify({
                kind: 'err',
                title: '觸價狀態待人工確認',
                body: '斷線恢復後無法查詢委託／成交，已鎖定相關觸價組，不會自動重送。',
            });
            return;
        }
        for (const t of pending) {
            const match = trades.find(
                (tr) =>
                    tr.order.id === t.broker_order_id ||
                    tr.order.custom_field === t.client_order_key,
            );
            if (!match) {
                this.patch(t.id, {
                    status: 'locked',
                    fail_reason:
                        '送單結果不明且查無對應委託；已鎖定，禁止自動重送',
                    last_query_at_ms: this.deps.now(),
                });
                if (t.group) {
                    this.groupInFlight.add(t.group);
                    this.setGroupStatus(
                        t.group,
                        t.id,
                        'locked',
                        '同組觸價因狀態不明已鎖定',
                    );
                }
                continue;
            }
            this.applyTradeStatus(t.id, match);
        }
    }

    private applyTradeStatus(id: string, trade: Trade): void {
        const st = trade.status.status;
        const deal = trade.status.deal_quantity ?? 0;
        const qty = trade.order.quantity;
        const t = this.triggers.find((x) => x.id === id);
        if (!t) return;
        if (st === 'Failed' || st === 'Inactive' || st === 'Cancelled') {
            this.patch(id, {
                status: 'rejected',
                fail_reason: trade.status.msg || st,
                broker_order_id: trade.order.id,
                last_query_at_ms: this.deps.now(),
            });
            if (t.group) {
                this.groupInFlight.delete(t.group);
                this.setGroupStatus(t.group, id, 'armed', null);
            }
            return;
        }
        if (st === 'Filled' || (deal > 0 && deal >= qty)) {
            this.patch(id, {
                status: 'filled',
                broker_order_id: trade.order.id,
                last_query_at_ms: this.deps.now(),
            });
            if (t.group) this.finalizeOcoSuccess(t.group, id);
            return;
        }
        if (deal > 0) {
            this.patch(id, {
                status: 'partial_fill',
                broker_order_id: trade.order.id,
                last_query_at_ms: this.deps.now(),
            });
            return;
        }
        if (
            st === 'Submitted' ||
            st === 'PendingSubmit' ||
            st === 'PreSubmitted'
        ) {
            this.patch(id, {
                status: 'accepted',
                broker_order_id: trade.order.id,
                last_query_at_ms: this.deps.now(),
            });
            if (t.group) {
                // Keep siblings suspended until fill/cancel settles
                this.setGroupStatus(t.group, id, 'oco_suspended', null);
            }
        }
    }

    private finalizeOcoSuccess(group: string, winnerId: string): void {
        this.groupInFlight.delete(group);
        this.triggers = this.triggers.map((t) => {
            if (t.group !== group) return t;
            if (t.id === winnerId) return { ...t, status: 'filled' as const };
            return { ...t, status: 'done' as const, fail_reason: 'OCO 已由另一側成交' };
        });
        this.emit();
    }

    /** Process one tick price for monitoring. */
    async onTick(code: string, lastPrice: number): Promise<void> {
        if (!this.running) return;
        if (!Number.isFinite(lastPrice)) return;
        const candidates = this.triggers.filter(
            (t) =>
                t.code === code &&
                t.status === 'armed' &&
                !NON_FIREABLE.has(t.status),
        );
        for (const t of candidates) {
            const hit =
                (t.condition === 'below' && lastPrice <= t.price) ||
                (t.condition === 'above' && lastPrice >= t.price);
            if (!hit) continue;
            await this.fire(t.id, lastPrice);
        }
    }

    async fire(id: string, lastPrice: number): Promise<void> {
        const t0 = this.triggers.find((x) => x.id === id);
        if (!t0) return;
        if (t0.status !== 'armed') return;
        if (this.firing.has(id)) return;
        if (t0.group && this.groupInFlight.has(t0.group)) return;

        this.firing.add(id);
        if (t0.group) this.groupInFlight.add(t0.group);

        // Soft-suspend OCO siblings — do NOT permanently delete yet.
        if (t0.group) {
            this.setGroupStatus(t0.group, id, 'oco_suspended', null);
        }
        this.patch(id, {
            status: 'submitting',
            submitted_at_ms: this.deps.now(),
            fail_reason: null,
        });

        if (t0.kind === 'alert') {
            this.deps.notify({
                kind: 'info',
                title: '🔔 到價警示',
                body: `${t0.code} 現價 ${lastPrice} 已${t0.condition === 'below' ? '跌破' : '突破'} ${t0.price}`,
            });
            this.patch(id, { status: 'done' });
            if (t0.group) this.groupInFlight.delete(t0.group);
            this.firing.delete(id);
            return;
        }

        try {
            const contract = await this.deps.ensureContract(t0.code);
            if (
                isFuturesLike(contract) &&
                !this.deps.futuresTrading()
            ) {
                this.deps.notify({
                    kind: 'info',
                    title: '🔔 到價警示（無法自動下單）',
                    body: `${t0.code} 現價 ${lastPrice} 已觸價，券商不支援期權下單`,
                });
                this.patch(id, {
                    status: 'rejected',
                    fail_reason: 'futures_trading_unsupported',
                });
                if (t0.group) {
                    this.groupInFlight.delete(t0.group);
                    this.setGroupStatus(t0.group, id, 'armed', null);
                }
                return;
            }

            // Cap qty to flattenable position — never reverse by oversize.
            const flat = await this.deps.flattenableQty(t0.code, t0.action);
            let qty = t0.quantity;
            if (flat === null) {
                this.patch(id, {
                    status: 'locked',
                    fail_reason:
                        '無法確認可平倉部位；已鎖定，請人工核對持倉後再恢復',
                });
                if (t0.group) {
                    this.setGroupStatus(
                        t0.group,
                        id,
                        'locked',
                        '同組因持倉不明已鎖定',
                    );
                }
                this.deps.notify({
                    kind: 'err',
                    title: '觸價已鎖定（持倉不明）',
                    body: `${t0.code} 未送單。${TRIGGER_ENGINE_DISCLAIMER}`,
                });
                return;
            }
            if (flat <= 0) {
                this.patch(id, {
                    status: 'rejected',
                    fail_reason: '無可平倉部位，取消送單以避免反向建倉',
                });
                if (t0.group) {
                    this.groupInFlight.delete(t0.group);
                    this.setGroupStatus(t0.group, id, 'armed', null);
                }
                this.deps.notify({
                    kind: 'err',
                    title: '觸價未送單（無持倉）',
                    body: `${t0.code} 可平倉數量為 0`,
                });
                return;
            }
            if (qty > flat) {
                qty = flat;
                this.patch(id, { quantity: qty });
            }

            const timeoutMs =
                this.deps.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS;
            const trade = await Promise.race([
                this.deps.placeOrder(
                    contract,
                    t0.action,
                    null,
                    qty,
                    {
                        bypassRisk: true,
                        clientOrderKey: t0.client_order_key,
                    },
                ),
                new Promise<never>((_, reject) =>
                    setTimeout(
                        () => reject(new Error('SUBMIT_TIMEOUT')),
                        timeoutMs,
                    ),
                ),
            ]);

            this.applyTradeStatus(id, trade);
            const after = this.triggers.find((x) => x.id === id);
            if (after?.status === 'filled' || after?.status === 'partial_fill') {
                this.deps.notify({
                    kind: 'ok',
                    title: t0.kind === 'stop' ? '⛔ 停損觸發' : '🎯 停利觸發',
                    body: `${t0.code} @${lastPrice} → 市價${t0.action === 'Buy' ? '買' : '賣'} ${qty} (${trade.status.status})`,
                });
            } else if (after?.status === 'accepted') {
                this.deps.notify({
                    kind: 'ok',
                    title: t0.kind === 'stop' ? '⛔ 停損已受理' : '🎯 停利已受理',
                    body: `${t0.code} 委託已送出 (${trade.status.status})`,
                });
            } else if (after?.status === 'rejected') {
                this.deps.notify({
                    kind: 'err',
                    title: '觸價單明確拒單',
                    body: `${t0.code} ${after.fail_reason ?? ''}｜可按「恢復」重新待觸發，不會每 tick 重送`,
                });
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg === 'SUBMIT_TIMEOUT' || /timeout|network|fetch/i.test(msg)) {
                await this.handleUncertain(id, msg);
            } else if (
                /reject|拒絕|失敗|Failed|Insufficient|不符合/i.test(msg)
            ) {
                this.patch(id, { status: 'rejected', fail_reason: msg });
                const t = this.triggers.find((x) => x.id === id);
                if (t?.group) {
                    this.groupInFlight.delete(t.group);
                    this.setGroupStatus(t.group, id, 'armed', null);
                }
                this.deps.notify({
                    kind: 'err',
                    title: '觸價單明確拒單',
                    body: `${t0.code} ${msg}｜設定已保留，不會每 tick 重送`,
                });
            } else {
                await this.handleUncertain(id, msg);
            }
        } finally {
            this.firing.delete(id);
        }
    }

    private async handleUncertain(id: string, reason: string): Promise<void> {
        this.patch(id, {
            status: 'uncertain',
            fail_reason: reason,
            last_query_at_ms: this.deps.now(),
        });
        // Query — never blind resubmit.
        let trades: Trade[] = [];
        try {
            trades = await this.deps.queryTrades();
        } catch {
            this.patch(id, {
                status: 'locked',
                fail_reason: `${reason}；查詢委託失敗，已鎖定禁止重送`,
            });
            const t = this.triggers.find((x) => x.id === id);
            if (t?.group) {
                this.setGroupStatus(
                    t.group,
                    id,
                    'locked',
                    '同組因狀態不明已鎖定',
                );
            }
            this.deps.notify({
                kind: 'err',
                title: '觸價狀態不明已鎖定',
                body: `${TRIGGER_ENGINE_DISCLAIMER} 請人工核對委託／成交後再恢復。券商送單通常不具冪等保證（idempotent=${BROKER_IDEMPOTENT_SUBMIT}）。`,
            });
            return;
        }
        const t = this.triggers.find((x) => x.id === id);
        if (!t) return;
        const match = trades.find(
            (tr) =>
                tr.order.id === t.broker_order_id ||
                tr.order.custom_field === t.client_order_key,
        );
        if (match) {
            this.applyTradeStatus(id, match);
            return;
        }
        this.patch(id, {
            status: 'locked',
            fail_reason: `${reason}；查無委託，已鎖定禁止自動重送`,
        });
        if (t.group) {
            this.setGroupStatus(t.group, id, 'locked', '同組因狀態不明已鎖定');
        }
        this.deps.notify({
            kind: 'err',
            title: '觸價狀態不明已鎖定',
            body: `${t.code} 請人工核對後再恢復。不會自動重送。`,
        });
    }
}

