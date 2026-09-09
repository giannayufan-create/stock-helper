import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import type { PredictionRecord } from '../lib/prediction-book';
import { useQuote } from '../hooks/use-stream';
import { fmtPct, fmtPrice, fmtSigned } from '../lib/utils/format';
import { CandleChart } from './candle-chart';
import { DepthLadder } from './depth-ladder';
import { StrategyScreenerPanel } from './strategy-screener-panel';
import { PredictionBookPanel } from './prediction-book-panel';
import * as styles from './mobile-shell.css';

type SectionId = 'screener' | 'chart' | 'depth' | 'book';

function MiniQuote({
    contract,
    snapshot,
}: {
    contract: ContractInfo;
    snapshot?: Snapshot;
}) {
    const quote = useQuote(contract.code);
    const tick = quote?.tick;
    const close = tick ? Number(tick.close) : snapshot?.close;
    const chg = tick?.price_chg
        ? Number(tick.price_chg)
        : snapshot?.change_price;
    const pct = tick?.pct_chg
        ? Number(tick.pct_chg)
        : snapshot?.change_rate;
    const open = tick ? Number(tick.open) : snapshot?.open;
    const high = tick ? Number(tick.high) : snapshot?.high;
    const low = tick ? Number(tick.low) : snapshot?.low;
    const dir =
        chg === undefined || chg === 0 ? 'flat' : chg > 0 ? 'up' : 'down';
    const tone =
        dir === 'up'
            ? styles.quoteUp
            : dir === 'down'
              ? styles.quoteDown
              : styles.quoteFlat;

    return (
        <div>
            <div className={styles.quoteStrip}>
                <div>
                    <div className={styles.quoteCode}>{contract.code}</div>
                    <div className={styles.quoteName}>{contract.name}</div>
                </div>
                <div className={`${styles.quotePrice} ${tone}`}>
                    {fmtPrice(close)}
                </div>
                <div className={`${styles.quoteChg} ${tone}`}>
                    <div>{fmtSigned(chg)}</div>
                    <div>{fmtPct(pct)}</div>
                </div>
            </div>
            <div className={styles.ohlcRow}>
                <div className={styles.ohlcCell}>
                    <span className={styles.ohlcLabel}>開</span>
                    <span>{fmtPrice(open)}</span>
                </div>
                <div className={styles.ohlcCell}>
                    <span className={styles.ohlcLabel}>高</span>
                    <span className={styles.quoteUp}>{fmtPrice(high)}</span>
                </div>
                <div className={styles.ohlcCell}>
                    <span className={styles.ohlcLabel}>低</span>
                    <span className={styles.quoteDown}>{fmtPrice(low)}</span>
                </div>
                <div className={styles.ohlcCell}>
                    <span className={styles.ohlcLabel}>參</span>
                    <span>{fmtPrice(contract.reference)}</span>
                </div>
            </div>
        </div>
    );
}

export function MobileShell({
    contract,
    snapshot,
    trades,
    onOrdersChanged,
    watchlistSeed,
    onSelectCode,
    onAddPrediction,
    onAutoScanPredictions,
    predictions,
    onClearPredictions,
    onVerifyPredictions,
    verifyingPredictions,
    onOpenSearch,
}: {
    contract: ContractInfo | null;
    snapshot?: Snapshot;
    trades: import('../lib/types/order').Trade[];
    onOrdersChanged: () => void;
    onRefreshTrading?: () => void;
    watchlistSeed: Array<{ code: string; name: string; close?: number }>;
    onSelectCode: (code: string) => void | Promise<void>;
    onAddPrediction: (record: PredictionRecord) => void;
    onAutoScanPredictions: (records: PredictionRecord[]) => void;
    predictions: PredictionRecord[];
    onClearPredictions: () => void;
    onVerifyPredictions: () => void | Promise<void>;
    verifyingPredictions: boolean;
    onOpenSearch?: () => void;
}) {
    const pageRef = useRef<HTMLDivElement>(null);
    const screenerRef = useRef<HTMLElement>(null);
    const chartRef = useRef<HTMLElement>(null);
    const depthRef = useRef<HTMLElement>(null);
    const bookRef = useRef<HTMLElement>(null);
    const [active, setActive] = useState<SectionId>('screener');
    const [showDepth, setShowDepth] = useState(false);
    const [showBook, setShowBook] = useState(false);

    const scrollTo = (id: SectionId) => {
        const map: Record<SectionId, RefObject<HTMLElement | null>> = {
            screener: screenerRef,
            chart: chartRef,
            depth: depthRef,
            book: bookRef,
        };
        setActive(id);
        if (id === 'depth') setShowDepth(true);
        if (id === 'book') setShowBook(true);
        requestAnimationFrame(() => {
            map[id].current?.scrollIntoView({
                behavior: 'smooth',
                block: 'start',
            });
        });
    };

    useEffect(() => {
        const page = pageRef.current;
        if (!page) return;
        const sections: Array<{ id: SectionId; el: HTMLElement | null }> = [
            { id: 'screener', el: screenerRef.current },
            { id: 'chart', el: chartRef.current },
            { id: 'depth', el: depthRef.current },
            { id: 'book', el: bookRef.current },
        ];
        const onScroll = () => {
            const y = page.scrollTop + 80;
            let current: SectionId = 'screener';
            for (const s of sections) {
                if (!s.el) continue;
                if (s.el.offsetTop <= y) current = s.id;
            }
            setActive(current);
        };
        page.addEventListener('scroll', onScroll, { passive: true });
        return () => page.removeEventListener('scroll', onScroll);
    }, [contract, showDepth, showBook]);

    return (
        <div className={styles.shell}>
            <header className={styles.topBar}>
                <span className={styles.brand}>股市小幫手</span>
                {onOpenSearch && (
                    <button
                        type="button"
                        className={styles.chipBtn}
                        onClick={onOpenSearch}
                    >
                        搜尋
                    </button>
                )}
            </header>

            {contract && (
                <MiniQuote contract={contract} snapshot={snapshot} />
            )}

            <div className={styles.page} ref={pageRef}>
                {/* ① 篩選優先 — 一進來就能按 */}
                <section className={styles.section} ref={screenerRef}>
                    <h2 className={styles.sectionTitle}>智能篩選</h2>
                    <StrategyScreenerPanel
                        compactMobile
                        watchlistSeed={watchlistSeed}
                        onPickCode={(code) => {
                            void (async () => {
                                await onSelectCode(code);
                                setShowDepth(false);
                                scrollTo('chart');
                            })();
                        }}
                        onAddPrediction={onAddPrediction}
                        onAutoScanPredictions={onAutoScanPredictions}
                    />
                </section>

                <section className={styles.section} ref={chartRef}>
                    <h2 className={styles.sectionTitle}>
                        看盤{contract ? ` · ${contract.code}` : ''}
                    </h2>
                    {contract ? (
                        <div className={styles.chartBox}>
                            <div className={styles.chartInner}>
                                <CandleChart
                                    contract={contract}
                                    trades={trades}
                                    onOrdersChanged={onOrdersChanged}
                                />
                            </div>
                        </div>
                    ) : (
                        <p className={styles.hint}>
                            上方篩選結果點一檔，K 線會出現在這裡（同一頁往下）。
                        </p>
                    )}
                    <div className={styles.quickRow}>
                        <button
                            type="button"
                            className={`${styles.quickBtn} ${showDepth ? styles.quickBtnOn : ''}`}
                            disabled={!contract}
                            onClick={() => {
                                setShowDepth((v) => !v);
                                if (!showDepth) scrollTo('depth');
                            }}
                        >
                            五檔
                        </button>
                        <button
                            type="button"
                            className={`${styles.quickBtn} ${showBook ? styles.quickBtnOn : ''}`}
                            onClick={() => {
                                setShowBook((v) => !v);
                                if (!showBook) scrollTo('book');
                            }}
                        >
                            布局本
                            {predictions.length
                                ? ` ${predictions.length}`
                                : ''}
                        </button>
                        <button
                            type="button"
                            className={styles.quickBtn}
                            onClick={() => scrollTo('screener')}
                        >
                            回篩選
                        </button>
                    </div>
                </section>

                <section className={styles.section} ref={depthRef}>
                    {showDepth && contract && (
                        <>
                            <h2 className={styles.sectionTitle}>
                                五檔 · {contract.code}
                            </h2>
                            <div className={styles.foldBody}>
                                <DepthLadder code={contract.code} />
                            </div>
                        </>
                    )}
                </section>

                <section className={styles.section} ref={bookRef}>
                    {showBook && (
                        <>
                            <h2 className={styles.sectionTitle}>布局本</h2>
                            <div className={styles.foldBody}>
                                <PredictionBookPanel
                                    rows={predictions}
                                    onClear={onClearPredictions}
                                    onVerify={onVerifyPredictions}
                                    verifying={verifyingPredictions}
                                />
                            </div>
                        </>
                    )}
                </section>

                <div className={styles.pageEnd} />
            </div>

            <nav className={styles.dock} aria-label="手機導覽">
                {(
                    [
                        ['screener', '篩選'],
                        ['chart', '看盤'],
                        ['depth', '五檔'],
                        ['book', '布局'],
                    ] as const
                ).map(([id, label]) => (
                    <button
                        key={id}
                        type="button"
                        className={`${styles.dockBtn} ${active === id ? styles.dockBtnOn : ''}`}
                        disabled={id === 'depth' && !contract}
                        onClick={() => scrollTo(id)}
                    >
                        {label}
                    </button>
                ))}
            </nav>
        </div>
    );
}
