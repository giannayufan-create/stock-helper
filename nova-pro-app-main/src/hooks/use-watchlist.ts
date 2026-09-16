// src/hooks/use-watchlist.ts — watched contracts: resolve contract info,
// subscribe Tick+BidAsk on the server, seed initial snapshot.

import { useCallback, useEffect, useRef, useState } from 'react';
import { primeContract } from '../lib/contracts-cache';
import {
    createWatchlist,
    fetchContract,
    fetchSnapshots,
    fetchWatchlists,
    subscribeQuote,
    syncWatchlist,
} from '../lib/backend';
import { registerCodeAlias } from '../lib/stream';
import type { ContractInfo, SecurityType } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';

export interface WatchItem {
    contract: ContractInfo;
    snapshot?: Snapshot;
}

const DEFAULT_SYMBOLS: { code: string; type: SecurityType }[] = [
    { code: '2330', type: 'STK' },
    { code: '2317', type: 'STK' },
    { code: '2454', type: 'STK' },
    { code: '2603', type: 'STK' },
    { code: '0050', type: 'STK' },
];

const STORAGE_KEY = 'sj-pro-watchlist';
const SERVER_LIST_NAME = 'nova-pro-v1';
const INIT_BUDGET_MS = 8_000;

function loadSaved(): { code: string; type: SecurityType }[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) {
                // Drop futures/warrants leftovers that can hang Shioaji subscribe.
                const stocks = parsed.filter(
                    (s: { code?: string; type?: SecurityType }) =>
                        s?.type === 'STK' && typeof s.code === 'string',
                );
                if (stocks.length > 0) return stocks;
            }
        }
    } catch {
        // fall through to defaults
    }
    return DEFAULT_SYMBOLS;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout')), ms);
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            },
        );
    });
}

export function useWatchlist() {
    const [items, setItems] = useState<WatchItem[]>([]);
    const [loading, setLoading] = useState(true);
    const subscribed = useRef(new Set<string>());
    const initStarted = useRef(false);
    const initDone = useRef(false);
    const serverListId = useRef<string | null>(null);
    const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const addSymbol = useCallback(
        async (code: string, type: SecurityType = 'STK') => {
            const contract = await fetchContract(code, type);
            if (contract.target_code) {
                registerCodeAlias(contract.target_code, contract.code);
            }
            primeContract(contract);
            setItems((prev) =>
                prev.some((i) => i.contract.code === contract.code)
                    ? prev
                    : [...prev, { contract }],
            );
            if (!subscribed.current.has(contract.code)) {
                subscribed.current.add(contract.code);
                // Never block UI on stream subscribe (cold Shioaji can 502/hang).
                void Promise.allSettled([
                    subscribeQuote(contract, 'Tick'),
                    subscribeQuote(contract, 'BidAsk'),
                ]);
            }
            fetchSnapshots([contract])
                .then(([snap]) =>
                    setItems((prev) =>
                        prev.map((i) =>
                            i.contract.code === contract.code
                                ? { ...i, snapshot: snap }
                                : i,
                        ),
                    ),
                )
                .catch(() => undefined);
            return contract;
        },
        [],
    );

    const removeSymbol = useCallback((code: string) => {
        setItems((prev) => prev.filter((i) => i.contract.code !== code));
    }, []);

    // persist only after the initial load finished — writing during the
    // load loop races with StrictMode double-mount and truncates the list
    useEffect(() => {
        if (!initDone.current) return;
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(
                items.map((i) => ({
                    code: i.contract.code,
                    type: i.contract.security_type,
                })),
            ),
        );
        // best-effort cloud sync to the server watchlist
        if (syncTimer.current) clearTimeout(syncTimer.current);
        syncTimer.current = setTimeout(() => {
            const contracts = items.map((i) => i.contract);
            if (serverListId.current) {
                syncWatchlist(serverListId.current, contracts).catch(
                    () => undefined,
                );
            } else {
                createWatchlist(SERVER_LIST_NAME, contracts)
                    .then((wl) => {
                        serverListId.current = wl.id;
                    })
                    .catch(() => undefined);
            }
        }, 2000);
    }, [items]);

    useEffect(() => {
        if (initStarted.current) return;
        initStarted.current = true;
        (async () => {
            const local = loadSaved();
            let saved = local;
            // cloud list is a seed when local storage is empty; local wins
            // otherwise (server 1.5.2 watchlist update routes are broken, so
            // the cloud copy can be stale)
            try {
                const lists = await withTimeout(fetchWatchlists(), 3_000);
                const mine = lists.find((l) => l.name === SERVER_LIST_NAME);
                if (mine) {
                    serverListId.current = mine.id;
                    const hasLocal = !!localStorage.getItem(STORAGE_KEY);
                    if (!hasLocal && mine.contracts.length > 0) {
                        saved = mine.contracts
                            .filter((c) => c.security_type === 'STK')
                            .map((c) => ({
                                code: c.code,
                                type: c.security_type,
                            }));
                    }
                }
            } catch {
                // offline from server watchlists — local copy is fine
            }
            const deadline = Date.now() + INIT_BUDGET_MS;
            for (const s of saved) {
                if (Date.now() > deadline) break;
                try {
                    await withTimeout(addSymbol(s.code, s.type), 4_000);
                } catch {
                    // unknown code / slow contract — skip
                }
            }
            initDone.current = true;
            setLoading(false);
        })();
    }, [addSymbol]);

    return { items, loading, addSymbol, removeSymbol };
}
