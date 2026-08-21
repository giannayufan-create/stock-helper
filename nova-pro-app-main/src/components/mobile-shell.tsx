import { useState } from 'react';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import type { PredictionRecord } from '../lib/prediction-book';
import { QuoteBoard } from './quote-board';
import { CandleChart } from './candle-chart';
import { DepthLadder } from './depth-ladder';
import { OrderTicket } from './order-ticket';
import { StrategyScreenerPanel } from './strategy-screener-panel';
import { PredictionBookPanel } from './prediction-book-panel';
import * as styles from './mobile-shell.css';

type MobileTab = 'chart' | 'depth' | 'ticket' | 'screener' | 'book';

const TABS: Array<{ id: MobileTab; short: string; label: string }> = [
    { id: 'chart', short: 'K', label: 'K線' },
    { id: 'depth', short: '5', label: '五檔' },
    { id: 'ticket', short: 'R', label: '回測' },
    { id: 'screener', short: 'S', label: '篩選' },
    { id: 'book', short: 'P', label: '預測本' },
];

export function MobileShell({
    contract,
    snapshot,
    trades,
    onOrdersChanged,
    onRefreshTrading,
    watchlistSeed,
    onSelectCode,
    onAddPrediction,
    predictions,
    onClearPredictions,
}: {
    contract: ContractInfo | null;
    snapshot?: Snapshot;
    trades: import('../lib/types/order').Trade[];
    onOrdersChanged: () => void;
    onRefreshTrading: () => void;
    watchlistSeed: Array<{ code: string; name: string; close?: number }>;
    onSelectCode: (code: string) => void;
    onAddPrediction: (record: PredictionRecord) => void;
    predictions: PredictionRecord[];
    onClearPredictions: () => void;
}) {
    const [tab, setTab] = useState<MobileTab>('chart');

    return (
        <div className={styles.shell}>
            <div className={styles.body}>
                <section className={styles.panel}>
                    <div className={styles.title}>
                        {tab === 'chart' &&
                            `K線${contract ? ` · ${contract.code}` : ''}`}
                        {tab === 'depth' &&
                            `五檔${contract ? ` · ${contract.code}` : ''}`}
                        {tab === 'ticket' &&
                            `回測紀錄${contract ? ` · ${contract.code}` : ''}`}
                        {tab === 'screener' && '策略篩選'}
                        {tab === 'book' && '預測本'}
                    </div>
                    <div className={styles.content}>
                        {tab === 'chart' &&
                            (contract ? (
                                <>
                                    <QuoteBoard
                                        contract={contract}
                                        snapshot={snapshot}
                                    />
                                    <CandleChart
                                        contract={contract}
                                        trades={trades}
                                        onOrdersChanged={onOrdersChanged}
                                    />
                                </>
                            ) : (
                                <EmptyState text="請先選股票" />
                            ))}

                        {tab === 'depth' &&
                            (contract ? (
                                <DepthLadder code={contract.code} />
                            ) : (
                                <EmptyState text="請先選股票" />
                            ))}

                        {tab === 'ticket' &&
                            (contract ? (
                                <OrderTicket
                                    contract={contract}
                                    onPlaced={onRefreshTrading}
                                />
                            ) : (
                                <EmptyState text="請先選股票" />
                            ))}

                        {tab === 'screener' && (
                            <StrategyScreenerPanel
                                watchlistSeed={watchlistSeed}
                                onPickCode={(code) => {
                                    onSelectCode(code);
                                    setTab('chart');
                                }}
                                onAddPrediction={onAddPrediction}
                            />
                        )}

                        {tab === 'book' && (
                            <PredictionBookPanel
                                rows={predictions}
                                onClear={onClearPredictions}
                            />
                        )}
                    </div>
                </section>
            </div>

            <nav className={styles.tabBar} aria-label="手機分頁">
                {TABS.map((t) => (
                    <button
                        key={t.id}
                        type="button"
                        className={styles.tab[tab === t.id ? 'on' : 'off']}
                        onClick={() => setTab(t.id)}
                    >
                        <span className={styles.tabIcon}>{t.short}</span>
                        {t.label}
                    </button>
                ))}
            </nav>
        </div>
    );
}

function EmptyState({ text }: { text: string }) {
    return <div className={styles.empty}>{text}</div>;
}
