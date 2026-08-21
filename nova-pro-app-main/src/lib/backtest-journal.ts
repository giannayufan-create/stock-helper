import type { Action } from './types/order';

export interface BacktestEntry {
    id: string;
    createdAt: string;
    code: string;
    name: string;
    action: Action;
    price: number;
    quantity: number;
    notional: number;
}

interface PositionState {
    qty: number;
    avgPrice: number;
}

interface JournalState {
    entries: BacktestEntry[];
    positions: Record<string, PositionState>;
    realizedPnl: Record<string, number>;
}

const KEY = 'nova-backtest-journal-v1';

function loadState(): JournalState {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) {
            return { entries: [], positions: {}, realizedPnl: {} };
        }
        const parsed = JSON.parse(raw) as JournalState;
        return {
            entries: Array.isArray(parsed.entries) ? parsed.entries : [],
            positions:
                parsed.positions && typeof parsed.positions === 'object'
                    ? parsed.positions
                    : {},
            realizedPnl:
                parsed.realizedPnl && typeof parsed.realizedPnl === 'object'
                    ? parsed.realizedPnl
                    : {},
        };
    } catch {
        return { entries: [], positions: {}, realizedPnl: {} };
    }
}

function saveState(state: JournalState): void {
    localStorage.setItem(KEY, JSON.stringify(state));
    void import('./cloud-sync')
        .then((m) => m.pushCloudBacktest())
        .catch(() => undefined);
}

export function loadBacktestJournal(): JournalState {
    return loadState();
}

export function recordBacktestExecution(input: {
    code: string;
    name: string;
    action: Action;
    price: number;
    quantity: number;
}): {
    entry: BacktestEntry;
    positionQty: number;
    positionAvgPrice: number;
    realizedPnl: number;
} {
    const state = loadState();
    const { code, name, action, price, quantity } = input;
    const current = state.positions[code] ?? { qty: 0, avgPrice: 0 };
    const currentRealized = state.realizedPnl[code] ?? 0;

    const entry: BacktestEntry = {
        id: `${code}-${Date.now()}`,
        createdAt: new Date().toISOString(),
        code,
        name,
        action,
        price,
        quantity,
        notional: price * quantity,
    };

    let nextQty = current.qty;
    let nextAvg = current.avgPrice;
    let nextRealized = currentRealized;

    if (action === 'Buy') {
        const totalCost = current.avgPrice * current.qty + price * quantity;
        nextQty = current.qty + quantity;
        nextAvg = nextQty > 0 ? totalCost / nextQty : 0;
    } else {
        const closeQty = Math.min(current.qty, quantity);
        nextRealized += (price - current.avgPrice) * closeQty;
        nextQty = Math.max(0, current.qty - quantity);
        nextAvg = nextQty > 0 ? current.avgPrice : 0;
    }

    state.entries = [entry, ...state.entries].slice(0, 2000);
    state.positions[code] = { qty: nextQty, avgPrice: nextAvg };
    state.realizedPnl[code] = nextRealized;
    saveState(state);

    return {
        entry,
        positionQty: nextQty,
        positionAvgPrice: nextAvg,
        realizedPnl: nextRealized,
    };
}

