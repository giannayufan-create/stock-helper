// src/App.tsx — Nova Pro trading terminal
// Dynamic panel blocks on a draggable grid, with named layout profiles.

import { useCallback, useEffect, useMemo, useState } from 'react';
import GridLayout, {
    useContainerWidth,
    type Layout,
    type LayoutItem,
} from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import * as styles from './App.css';
import * as grid from './grid.css';
import { BottomDock } from './components/bottom-dock';
import { CandleChart } from './components/candle-chart';
import { CommandPalette } from './components/command-palette';
import { DepthLadder } from './components/depth-ladder';
import { EventToasts } from './components/event-toasts';
import { FlashOrder } from './components/flash-order';
import { HudHeader } from './components/hud-header';
import { OptionChain } from './components/option-chain';
import { OrderTicket } from './components/order-ticket';
import { ChipsCard } from './components/chips-card';
import { PnlPanel } from './components/pnl-panel';
import { VolProfile } from './components/vol-profile';
import { ReplayPanel } from './components/replay-panel';
import { DepthMap } from './components/depth-map';
import { StrategyScreenerPanel } from './components/strategy-screener-panel';
import { MoneyFlowPanel } from './components/money-flow-panel';
import { PredictionBookPanel } from './components/prediction-book-panel';
import { MobileShell } from './components/mobile-shell';
import { PanelChrome } from './components/panel-chrome';
import { QuoteBoard } from './components/quote-board';
import { ScannerPanel } from './components/scanner-panel';
import { TickTape } from './components/tick-tape';
import { Watchlist } from './components/watchlist';
import * as panel from './components/panel.css';
import { useHotkeys } from './hooks/use-hotkeys';
import { useMediaQuery } from './hooks/use-media-query';
import { usePoll } from './hooks/use-poll';
import { useWatchlist } from './hooks/use-watchlist';
import { ensureContract, useContract } from './lib/contracts-cache';
import { reportDailyPnl } from './lib/risk';
import { openPopout } from './lib/tauri';
import {
    fetchAccountBalance,
    fetchMargin,
    fetchPositions,
    fetchTrades,
    resolveSymbolQuery,
} from './lib/backend';
import { notify } from './lib/trade';
import type { ContractInfo } from './lib/types/contract';
import type { Trade } from './lib/types/order';
import type { Position } from './lib/types/portfolio';
import {
    BLOCK_META,
    DEFAULT_WORKSPACE,
    loadProfiles,
    loadWorkspace,
    newBlockId,
    saveProfiles,
    saveWorkspace,
    type Block,
    type BlockType,
    type Profile,
    type Workspace,
} from './lib/workspace';
import {
    appendPrediction,
    loadPredictions,
    mergeAutoScanPredictions,
    savePredictions,
    type PredictionRecord,
} from './lib/prediction-book';
import { verifyOpenPredictions } from './lib/prediction-verify';
import { bootstrapCloudSync } from './lib/cloud-sync';

const GRID_COLS = 24;

const POPOUT_TYPES: ReadonlySet<string> = new Set([
    'chart',
    'depth',
    'ticket',
    'tape',
    'flash',
    'chips',
    'volprofile',
    'moneyFlow',
    'optchain',
    'pnl',
    'replay',
    'depthmap',
]);

const popoutQuery = new URLSearchParams(window.location.search);
const POPOUT_TYPE = popoutQuery.get('popout') as BlockType | null;
const POPOUT_CODE = popoutQuery.get('code') || null;

// resolves a block's contract: pinned code (contract cache) or global selection
function useBlockContract(
    block: Block,
    selected: ContractInfo | null,
): ContractInfo | null {
    const pinned = useContract(block.pin);
    useEffect(() => {
        if (block.pin && !pinned) {
            ensureContract(block.pin).catch(() =>
                notify({
                    kind: 'err',
                    title: '找不到商品',
                    body: `代碼 ${block.pin} 無法解析`,
                }),
            );
        }
    }, [block.pin, pinned]);
    return block.pin ? (pinned ?? null) : selected;
}

function BlockBody({
    block,
    contract,
    snapshot,
    watchlistProps,
    dockProps,
    onSelectCode,
    refreshTrading,
    watchlistSeed,
    onAddPrediction,
    onAutoScanPredictions,
    predictions,
    onClearPredictions,
    onVerifyPredictions,
    verifyingPredictions,
}: {
    block: Block;
    contract: ContractInfo | null;
    snapshot?: import('./lib/types/market').Snapshot;
    watchlistProps: React.ComponentProps<typeof Watchlist>;
    dockProps: React.ComponentProps<typeof BottomDock>;
    onSelectCode: (code: string) => void;
    refreshTrading: () => void;
    watchlistSeed: Array<{ code: string; name: string; close?: number }>;
    onAddPrediction: (record: PredictionRecord) => void;
    onAutoScanPredictions: (records: PredictionRecord[]) => void;
    predictions: PredictionRecord[];
    onClearPredictions: () => void;
    onVerifyPredictions: () => void | Promise<void>;
    verifyingPredictions: boolean;
}) {
    switch (block.type) {
        case 'watchlist':
            return <Watchlist {...watchlistProps} />;
        case 'movers':
            return <ScannerPanel onPick={onSelectCode} />;
        case 'dock':
            return <BottomDock {...dockProps} />;
        case 'chart':
            return contract ? (
                <>
                    <QuoteBoard contract={contract} snapshot={snapshot} />
                    <CandleChart
                        contract={contract}
                        trades={dockProps.trades}
                        onOrdersChanged={dockProps.onTradesChanged}
                    />
                </>
            ) : (
                <BlockPlaceholder />
            );
        case 'depth':
            return contract ? (
                <DepthLadder code={contract.code} />
            ) : (
                <BlockPlaceholder />
            );
        case 'ticket':
            return contract ? (
                <OrderTicket contract={contract} onPlaced={refreshTrading} />
            ) : (
                <BlockPlaceholder />
            );
        case 'tape':
            return contract ? (
                <TickTape contract={contract} />
            ) : (
                <BlockPlaceholder />
            );
        case 'flash':
            return contract ? (
                <FlashOrder contract={contract} />
            ) : (
                <BlockPlaceholder />
            );
        case 'pnl':
            return <PnlPanel />;
        case 'chips':
            return contract ? (
                <ChipsCard contract={contract} />
            ) : (
                <BlockPlaceholder />
            );
        case 'volprofile':
            return contract ? (
                <VolProfile contract={contract} />
            ) : (
                <BlockPlaceholder />
            );
        case 'optchain':
            return <OptionChain />;
        case 'replay':
            return contract ? (
                <ReplayPanel contract={contract} />
            ) : (
                <BlockPlaceholder />
            );
        case 'depthmap':
            return contract ? (
                <DepthMap contract={contract} />
            ) : (
                <BlockPlaceholder />
            );
        case 'strategyScreener':
            return (
                <StrategyScreenerPanel
                    watchlistSeed={watchlistSeed}
                    onPickCode={onSelectCode}
                    onAddPrediction={onAddPrediction}
                    onAutoScanPredictions={onAutoScanPredictions}
                />
            );
        case 'moneyFlow':
            return <MoneyFlowPanel onPickCode={onSelectCode} />;
        case 'predictionBook':
            return (
                <PredictionBookPanel
                    rows={predictions}
                    onClear={onClearPredictions}
                    onVerify={onVerifyPredictions}
                    verifying={verifyingPredictions}
                />
            );
    }
}

function BlockPlaceholder() {
    return <div className={styles.blockPlaceholder}>等待商品…</div>;
}

interface BlockViewProps {
    block: Block;
    selected: ContractInfo | null;
    onPinChange: (id: string, pin: string | null) => void;
    onRemove: (id: string) => void;
    snapshot?: import('./lib/types/market').Snapshot;
    watchlistProps: React.ComponentProps<typeof Watchlist>;
    dockProps: React.ComponentProps<typeof BottomDock>;
    onSelectCode: (code: string) => void;
    refreshTrading: () => void;
    watchlistSeed: Array<{ code: string; name: string; close?: number }>;
    onAddPrediction: (record: PredictionRecord) => void;
    onAutoScanPredictions: (records: PredictionRecord[]) => void;
    predictions: PredictionRecord[];
    onClearPredictions: () => void;
    onVerifyPredictions: () => void | Promise<void>;
    verifyingPredictions: boolean;
}

function BlockView(props: BlockViewProps) {
    const { block, selected, onPinChange, onRemove, ...bodyProps } = props;
    const contract = useBlockContract(block, selected);
    const meta = BLOCK_META[block.type];
    const showSymbol =
        meta.pinnable && contract ? ` · ${contract.code}` : '';

    return (
        <section className={panel.panel}>
            <PanelChrome
                title={`${meta.label}${showSymbol}`}
                pinnable={meta.pinnable}
                pin={block.pin}
                currentCode={selected?.code ?? null}
                onPinChange={(pin) => onPinChange(block.id, pin)}
                onRemove={() => onRemove(block.id)}
                onPopout={
                    POPOUT_TYPES.has(block.type)
                        ? () =>
                              void openPopout(
                                  block.type,
                                  contract?.code ?? null,
                              )
                        : undefined
                }
            />
            <BlockBody {...bodyProps} block={block} contract={contract} />
        </section>
    );
}

function PopoutView({
    type,
    code,
}: {
    type: BlockType;
    code: string | null;
}) {
    const contract = useContract(code);
    useEffect(() => {
        if (code) ensureContract(code).catch(() => undefined);
    }, [code]);
    const tradesPoll = usePoll<Trade[]>(
        useCallback(async () => {
            const [s, f] = await Promise.allSettled([
                fetchTrades('S'),
                fetchTrades('F'),
            ]);
            return [
                ...(s.status === 'fulfilled' ? s.value : []),
                ...(f.status === 'fulfilled' ? f.value : []),
            ];
        }, []),
        8000,
    );
    const meta = BLOCK_META[type];

    let body: React.ReactNode = <BlockPlaceholder />;
    if (type === 'pnl') body = <PnlPanel />;
    else if (type === 'optchain') body = <OptionChain />;
    else if (type === 'moneyFlow') {
        body = (
            <MoneyFlowPanel
                onPickCode={(c) => {
                    void ensureContract(c);
                }}
            />
        );
    } else if (contract) {
        switch (type) {
            case 'chart':
                body = (
                    <>
                        <QuoteBoard contract={contract} />
                        <CandleChart
                            contract={contract}
                            trades={tradesPoll.data ?? []}
                            onOrdersChanged={tradesPoll.refresh}
                        />
                    </>
                );
                break;
            case 'depth':
                body = <DepthLadder code={contract.code} />;
                break;
            case 'ticket':
                body = (
                    <OrderTicket
                        contract={contract}
                        onPlaced={tradesPoll.refresh}
                    />
                );
                break;
            case 'tape':
                body = <TickTape contract={contract} />;
                break;
            case 'flash':
                body = <FlashOrder contract={contract} />;
                break;
            case 'chips':
                body = <ChipsCard contract={contract} />;
                break;
            case 'volprofile':
                body = <VolProfile contract={contract} />;
                break;
            case 'replay':
                body = <ReplayPanel contract={contract} />;
                break;
            case 'depthmap':
                body = <DepthMap contract={contract} />;
                break;
            default:
                break;
        }
    }

    return (
        <div className={styles.shell}>
            <EventToasts />
            <section className={panel.panel} style={{ flex: 1, margin: 6 }}>
                <PanelChrome
                    title={`${meta.label}${contract ? ` · ${contract.code}` : ''}`}
                />
                {body}
            </section>
        </div>
    );
}

export default function App() {
    const { items, loading, addSymbol, removeSymbol } = useWatchlist();
    const [selected, setSelected] = useState<ContractInfo | null>(null);
    const [workspace, setWorkspace] = useState<Workspace>(loadWorkspace);
    const [profiles, setProfiles] = useState<Profile[]>(loadProfiles);
    const [predictions, setPredictions] =
        useState<PredictionRecord[]>(loadPredictions);
    const [verifyingPredictions, setVerifyingPredictions] = useState(false);
    const { width, containerRef, mounted } = useContainerWidth();

    const addPrediction = useCallback((record: PredictionRecord) => {
        setPredictions((prev) => appendPrediction(prev, record));
    }, []);

    const addAutoScanPredictions = useCallback(
        (records: PredictionRecord[]) => {
            setPredictions((prev) => mergeAutoScanPredictions(prev, records));
        },
        [],
    );

    const clearPredictions = useCallback(() => {
        savePredictions([]);
        setPredictions([]);
    }, []);

    const runVerifyPredictions = useCallback(async () => {
        setVerifyingPredictions(true);
        try {
            const current = loadPredictions();
            const { rows } = await verifyOpenPredictions(current);
            setPredictions(rows);
        } catch (err) {
            console.warn('[prediction-verify] failed', err);
        } finally {
            setVerifyingPredictions(false);
        }
    }, []);

    // Pull Firestore copy on boot, then auto-verify open picks
    useEffect(() => {
        void bootstrapCloudSync()
            .then(async (cloud) => {
                const base = cloud ?? loadPredictions();
                if (cloud) setPredictions(cloud);
                try {
                    const { rows, changed } =
                        await verifyOpenPredictions(base);
                    if (changed > 0) setPredictions(rows);
                } catch (err) {
                    console.warn('[prediction-verify] boot failed', err);
                }
            })
            .catch(() => undefined);
    }, []);

    // first loaded watchlist item becomes the active symbol
    useEffect(() => {
        const first = items[0];
        if (!selected && first) {
            setSelected(first.contract);
        }
    }, [items, selected]);

    // portfolio polling (stock + futures merged)
    const positionsPoll = usePoll<Position[]>(
        useCallback(async () => {
            const [st, fu] = await Promise.allSettled([
                fetchPositions('S'),
                fetchPositions('F'),
            ]);
            return [
                ...(st.status === 'fulfilled' ? st.value : []),
                ...(fu.status === 'fulfilled' ? fu.value : []),
            ];
        }, []),
        10000,
    );
    const tradesPoll = usePoll<Trade[]>(
        useCallback(async () => {
            const [s, f] = await Promise.allSettled([
                fetchTrades('S'),
                fetchTrades('F'),
            ]);
            return [
                ...(s.status === 'fulfilled' ? s.value : []),
                ...(f.status === 'fulfilled' ? f.value : []),
            ];
        }, []),
        8000,
    );
    const balancePoll = usePoll(
        useCallback(() => fetchAccountBalance(), []),
        60000,
    );
    const marginPoll = usePoll(useCallback(() => fetchMargin(), []), 30000);

    const refreshTrading = useCallback(() => {
        tradesPoll.refresh();
        positionsPoll.refresh();
    }, [tradesPoll, positionsPoll]);

    // feed risk engine: unrealized position P&L + futures settle P&L
    useEffect(() => {
        const unrealized = (positionsPoll.data ?? []).reduce(
            (sum, p) => sum + (p.pnl || 0),
            0,
        );
        const settle = marginPoll.data?.future_settle_profitloss ?? 0;
        reportDailyPnl(unrealized + settle);
    }, [positionsPoll.data, marginPoll.data]);

    const selectByCode = useCallback(
        async (code: string) => {
            // Unlock all pinned blocks so every panel follows this pick
            setWorkspace((prev) => {
                if (!prev.blocks.some((b) => b.pin)) return prev;
                const next = {
                    ...prev,
                    blocks: prev.blocks.map((b) => ({ ...b, pin: null })),
                };
                saveWorkspace(next);
                return next;
            });

            const existing = items.find((i) => i.contract.code === code);
            if (existing) {
                setSelected(existing.contract);
                return;
            }

            // Optimistic stub so mobile chart/depth/ticket switch immediately
            setSelected({
                code,
                name: code,
                exchange: 'TSE',
                security_type: 'STK',
                target_code: null,
                currency: 'TWD',
                limit_up: 0,
                limit_down: 0,
                reference: 0,
                day_trade: 'Yes',
                update_date: '',
                category: '',
                margin_trading_balance: 0,
                short_selling_balance: 0,
            });

            try {
                const c = (await addSymbol(code, 'STK')) as ContractInfo;
                setSelected(c);
            } catch (err) {
                console.warn('selectByCode failed', code, err);
                window.alert(
                    `無法切換到 ${code}：合約解析失敗。請確認代號或稍後再試。`,
                );
            }
        },
        [items, addSymbol],
    );

    const selectedSnapshot = useMemo(
        () => items.find((i) => i.contract.code === selected?.code)?.snapshot,
        [items, selected],
    );
    const watchlistSeed = useMemo(
        () =>
            items.map((i) => ({
                code: i.contract.code,
                name: i.contract.name,
                close: i.snapshot?.close,
            })),
        [items],
    );

    // ---- workspace ops ----

    const updateWorkspace = useCallback((w: Workspace) => {
        setWorkspace(w);
        saveWorkspace(w);
    }, []);

    const onLayoutChange = useCallback(
        (next: Layout) => {
            updateWorkspace({ ...workspace, layout: [...next] });
        },
        [workspace, updateWorkspace],
    );

    const addBlock = useCallback(
        (type: BlockType) => {
            const meta = BLOCK_META[type];
            if (
                meta.singleton &&
                workspace.blocks.some((b) => b.type === type)
            ) {
                return;
            }
            const id = newBlockId(type);
            const item: LayoutItem = {
                i: id,
                x: 0,
                y: Infinity, // RGL drops it at the bottom
                w: meta.defaultSize.w,
                h: meta.defaultSize.h,
                minW: meta.defaultSize.minW,
                minH: meta.defaultSize.minH,
            };
            updateWorkspace({
                blocks: [...workspace.blocks, { id, type, pin: null }],
                layout: [...workspace.layout, item],
            });
        },
        [workspace, updateWorkspace],
    );

    const removeBlock = useCallback(
        (id: string) => {
            updateWorkspace({
                blocks: workspace.blocks.filter((b) => b.id !== id),
                layout: workspace.layout.filter((l) => l.i !== id),
            });
        },
        [workspace, updateWorkspace],
    );

    const setBlockPin = useCallback(
        (id: string, pin: string | null) => {
            updateWorkspace({
                ...workspace,
                blocks: workspace.blocks.map((b) =>
                    b.id === id ? { ...b, pin } : b,
                ),
            });
        },
        [workspace, updateWorkspace],
    );

    const resetWorkspace = useCallback(() => {
        updateWorkspace(structuredClone(DEFAULT_WORKSPACE));
    }, [updateWorkspace]);

    // ---- profiles ----

    const saveProfileAs = useCallback(
        (name: string) => {
            const next = [
                ...profiles.filter((p) => p.name !== name),
                { name, workspace: structuredClone(workspace) },
            ];
            setProfiles(next);
            saveProfiles(next);
            notify({
                kind: 'ok',
                title: '版面已儲存',
                body: `「${name}」已加入版面列表`,
            });
        },
        [profiles, workspace],
    );

    const loadProfile = useCallback(
        (name: string) => {
            const p = profiles.find((x) => x.name === name);
            if (p) {
                updateWorkspace(structuredClone(p.workspace));
                notify({
                    kind: 'info',
                    title: '版面已載入',
                    body: `已切換至「${name}」`,
                });
            }
        },
        [profiles, updateWorkspace],
    );

    const deleteProfile = useCallback(
        (name: string) => {
            const next = profiles.filter((p) => p.name !== name);
            setProfiles(next);
            saveProfiles(next);
        },
        [profiles],
    );

    const [paletteOpen, setPaletteOpen] = useState(false);
    const openPalette = useCallback(() => setPaletteOpen(true), []);
    useHotkeys({
        onOpenPalette: openPalette,
        onAfterCancelAll: refreshTrading,
    });

    const jumpToCode = useCallback(
        async (query: string) => {
            try {
                const q = query.trim();
                const byName = items.find(
                    (i) =>
                        i.contract.code.toUpperCase() === q.toUpperCase() ||
                        i.contract.name.includes(q),
                );
                if (byName) {
                    setSelected(byName.contract);
                    return;
                }
                const code = await resolveSymbolQuery(q);
                if (!code) {
                    throw new Error(`找不到「${q}」，請改打代碼或完整名稱`);
                }
                const existing = items.find((i) => i.contract.code === code);
                if (existing) {
                    setSelected(existing.contract);
                    return;
                }
                const c = (await addSymbol(code, 'STK').catch(() =>
                    addSymbol(code, 'FUT'),
                )) as ContractInfo;
                setSelected(c);
            } catch (err) {
                notify({
                    kind: 'err',
                    title: '無法開啟商品',
                    body: err instanceof Error ? err.message : String(err),
                });
                throw err;
            }
        },
        [items, addSymbol],
    );

    const addableTypes = useMemo(
        () =>
            (Object.keys(BLOCK_META) as BlockType[]).map((type) => ({
                type,
                label: BLOCK_META[type].label,
                disabled:
                    BLOCK_META[type].singleton &&
                    workspace.blocks.some((b) => b.type === type),
            })),
        [workspace.blocks],
    );

    const booting = loading && items.length === 0;
    const isMobile = useMediaQuery('screen and (max-width: 1024px)');

    if (POPOUT_TYPE && POPOUT_TYPES.has(POPOUT_TYPE)) {
        return <PopoutView type={POPOUT_TYPE} code={POPOUT_CODE} />;
    }

    const watchlistProps = {
        items,
        selectedCode: selected?.code ?? null,
        onSelect: setSelected,
        onAdd: addSymbol,
        onRemove: removeSymbol,
    };
    const dockProps = {
        positions: positionsPoll.data ?? [],
        trades: tradesPoll.data ?? [],
        balance: balancePoll.data,
        margin: marginPoll.data,
        onTradesChanged: refreshTrading,
    };

    // 手機：只渲染一頁式殼，絕不掛桌面 HUD / Grid（避免舊分頁殼殘留）
    if (isMobile) {
        return (
            <div className={styles.shell}>
                <EventToasts onEvent={refreshTrading} />
                <CommandPalette
                    open={paletteOpen}
                    onClose={() => setPaletteOpen(false)}
                    onJump={jumpToCode}
                />
                {booting ? (
                    <div className={styles.loading}>
                        <span>股市小幫手</span>
                        <span style={{ fontSize: '0.7rem' }}>載入中…</span>
                    </div>
                ) : (
                    <MobileShell
                        contract={selected}
                        snapshot={selectedSnapshot}
                        trades={dockProps.trades}
                        onOrdersChanged={refreshTrading}
                        onRefreshTrading={refreshTrading}
                        watchlistSeed={watchlistSeed}
                        onSelectCode={selectByCode}
                        onAddPrediction={addPrediction}
                        onAutoScanPredictions={addAutoScanPredictions}
                        predictions={predictions}
                        onClearPredictions={clearPredictions}
                        onVerifyPredictions={runVerifyPredictions}
                        verifyingPredictions={verifyingPredictions}
                        onOpenSearch={() => setPaletteOpen(true)}
                    />
                )}
            </div>
        );
    }

    return (
        <div className={styles.shell}>
            <HudHeader
                accBalance={balancePoll.data?.acc_balance}
                addableTypes={addableTypes}
                onAddBlock={addBlock}
                profiles={profiles.map((p) => p.name)}
                onSaveProfile={saveProfileAs}
                onLoadProfile={loadProfile}
                onDeleteProfile={deleteProfile}
                onResetWorkspace={resetWorkspace}
                onJump={jumpToCode}
            />
            <EventToasts onEvent={refreshTrading} />
            <CommandPalette
                open={paletteOpen}
                onClose={() => setPaletteOpen(false)}
                onJump={jumpToCode}
            />

            <div className={grid.gridWrap} ref={containerRef}>
                {booting && (
                    <div className={styles.loading}>
                        <span>Nova Pro</span>
                        <span style={{ fontSize: '0.7rem' }}>
                            載入交易終端…
                        </span>
                    </div>
                )}
                {!booting && mounted && (
                    <GridLayout
                        layout={workspace.layout}
                        width={width}
                        gridConfig={{
                            cols: GRID_COLS,
                            rowHeight: 30,
                            margin: [6, 6],
                            containerPadding: [6, 6],
                        }}
                        dragConfig={{
                            handle: '.drag-handle',
                            cancel: 'button, input, select',
                        }}
                        onLayoutChange={onLayoutChange}
                    >
                        {workspace.blocks.map((block) => (
                            <div key={block.id} className={grid.cell}>
                                <BlockView
                                    block={block}
                                    selected={selected}
                                    onPinChange={setBlockPin}
                                    onRemove={removeBlock}
                                    snapshot={
                                        block.pin
                                            ? undefined
                                            : selectedSnapshot
                                    }
                                    watchlistProps={watchlistProps}
                                    dockProps={dockProps}
                                    onSelectCode={selectByCode}
                                    refreshTrading={refreshTrading}
                                    watchlistSeed={watchlistSeed}
                                    onAddPrediction={addPrediction}
                                    onAutoScanPredictions={
                                        addAutoScanPredictions
                                    }
                                    predictions={predictions}
                                    onClearPredictions={clearPredictions}
                                    onVerifyPredictions={runVerifyPredictions}
                                    verifyingPredictions={verifyingPredictions}
                                />
                            </div>
                        ))}
                    </GridLayout>
                )}
            </div>
        </div>
    );
}
