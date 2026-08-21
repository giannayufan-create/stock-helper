// src/components/candle-chart.tsx — K-bar candlestick + volume chart
// (lightweight-charts v5), live-updated from the SSE tick stream.

import {
    CandlestickSeries,
    ColorType,
    createChart,
    HistogramSeries,
    LineSeries,
    type IChartApi,
    type IPriceLine,
    type ISeriesApi,
    type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import { bollinger, ema, rsi, sma, vwap } from '../lib/indicators';
import { analyzeWithServer } from '../lib/ai-analyze';
import {
    buildAiAlerts,
    buildLocalCoach,
    describeAiScore,
} from '../lib/ai-score-label';
import {
    detectInstTraps,
    reasonTone,
    type TradeAction,
    type TrapHit,
} from '../lib/inst-trap';
import {
    analyzePriceStructure,
    type PriceStructure,
} from '../lib/price-structure';
import { cancelOrder, fetchKbars, updateOrderPrice } from '../lib/backend';
import { setPickedPrice } from '../lib/price-sync';
import { notify, placeQuickOrder } from '../lib/trade';
import {
    addTrigger,
    removeTrigger,
    useTriggers,
} from '../lib/trigger-engine';
import type { ContractInfo } from '../lib/types/contract';
import type { Candle } from '../lib/types/market';
import { ACTIVE_ORDER_STATUSES, type Trade } from '../lib/types/order';
import { fmtPrice } from '../lib/utils/format';
import { roundToTick } from '../lib/utils/ticksize';
import { chartFontSize, getChartColors, useThemeSettings } from '../lib/theme-store';
import {
    aggregate,
    dateStrOffset,
    kbarsToCandles,
    wallClockToUtc,
} from '../lib/utils/kbars';
import * as panel from './panel.css';
import * as styles from './candle-chart.css';

const TIMEFRAMES = [
    { label: '1m', minutes: 1, days: 3 },
    { label: '5m', minutes: 5, days: 10 },
    { label: '15m', minutes: 15, days: 20 },
    { label: '60m', minutes: 60, days: 60 },
    { label: '1D', minutes: 1440, days: 365 },
] as const;

type TradeMode = 'observe' | 'buy' | 'sell' | 'stop' | 'take' | 'alert';

const TRADE_MODES: { key: TradeMode; label: string }[] = [
    { key: 'observe', label: '游標' },
    { key: 'buy', label: '點價買' },
    { key: 'sell', label: '點價賣' },
    { key: 'stop', label: '停損' },
    { key: 'take', label: '停利' },
    { key: 'alert', label: '警示' },
];

const INDICATOR_DEFS: {
    key: string;
    label: string;
    color: string;
    kind: 'ma' | 'ema' | 'bb' | 'vwap' | 'rsi';
    defaultPeriod?: number;
}[] = [
    { key: 'ma5', label: 'MA', color: '#e0a43c', kind: 'ma', defaultPeriod: 5 },
    { key: 'ma10', label: 'MA', color: '#e8b84a', kind: 'ma', defaultPeriod: 10 },
    { key: 'ma20', label: 'MA', color: '#b06fff', kind: 'ma', defaultPeriod: 20 },
    { key: 'ma60', label: 'MA', color: '#7e8798', kind: 'ma', defaultPeriod: 60 },
    { key: 'ema12', label: 'EMA12', color: '#19b6c9', kind: 'ema', defaultPeriod: 12 },
    { key: 'bb', label: 'BB(20,2)', color: '#8b94a7', kind: 'bb' },
    { key: 'vwap', label: 'VWAP', color: '#f5f7fa', kind: 'vwap' },
    { key: 'rsi14', label: 'RSI(14)', color: '#ffcf66', kind: 'rsi' },
];

const DEFAULT_MA_PERIODS: Record<string, number> = {
    ma5: 5,
    ma10: 10,
    ma20: 20,
    ma60: 60,
};

function loadIndicators(): Set<string> {
    try {
        const raw = localStorage.getItem('sj-pro-indicators');
        if (raw) return new Set(JSON.parse(raw));
    } catch {
        // defaults
    }
    return new Set(['ma5', 'ma10', 'ma20']);
}

function loadMaPeriods(): Record<string, number> {
    try {
        const raw = localStorage.getItem('sj-pro-ma-periods');
        if (raw) {
            const parsed = JSON.parse(raw) as Record<string, number>;
            return { ...DEFAULT_MA_PERIODS, ...parsed };
        }
    } catch {
        // defaults
    }
    return { ...DEFAULT_MA_PERIODS };
}

function formatTickTime(time: unknown): string {
    if (typeof time !== 'number') return '';
    // Times are encoded as UTC timestamps of Taiwan wall-clock values.
    // Use UTC getters so labels stay stable and don't shift with browser TZ.
    const d = new Date(time * 1000);
    const h = String(d.getUTCHours()).padStart(2, '0');
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    return `${h}:${m}`;
}

function formatTickDate(time: unknown): string {
    if (typeof time !== 'number') return '';
    const d = new Date(time * 1000);
    const day = String(d.getUTCDate());
    const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const year = String(d.getUTCFullYear()).slice(-2);
    return `${day} ${month} '${year}`;
}

export function CandleChart({
    contract,
    trades = [],
    onOrdersChanged,
}: {
    contract: ContractInfo;
    trades?: Trade[];
    onOrdersChanged?: () => void;
}) {
    const hostRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
    const lastBarRef = useRef<Candle | null>(null);
    const [tfIdx, setTfIdx] = useState(1); // default 5m
    const [empty, setEmpty] = useState(false);
    const quote = useQuote(contract.code);
    const tf = TIMEFRAMES[tfIdx] ?? TIMEFRAMES[1];
    const themeSettings = useThemeSettings();
    const colors = getChartColors(themeSettings);
    const themeKey = `${themeSettings.mode}-${themeSettings.convention}-${themeSettings.fontScale}`;
    const [mode, setMode] = useState<TradeMode>('observe');
    const [tradeQty, setTradeQty] = useState(1);
    const [indicators, setIndicators] = useState<Set<string>>(loadIndicators);
    const [maPeriods, setMaPeriods] = useState<Record<string, number>>(loadMaPeriods);
    const [indMenuOpen, setIndMenuOpen] = useState(false);
    const [indMenuPos, setIndMenuPos] = useState({ top: 0, left: 0 });
    const indBtnRef = useRef<HTMLButtonElement>(null);
    const [dataVersion, setDataVersion] = useState(0);
    const [aiDecision, setAiDecision] = useState<{
        score: number;
        stance: '看漲' | '看跌' | '盤整';
        reasons: string[];
        at: string;
        entry?: number;
        stop?: number;
        take?: number;
        rr?: number;
        source?: string;
        coach?: string;
        structure?: PriceStructure | null;
        action?: TradeAction;
        actionReason?: string;
        traps?: TrapHit[];
    } | null>(null);
    const [aiBusy, setAiBusy] = useState(false);
    const [aiPanelPos, setAiPanelPos] = useState({ x: 8, y: 48 });
    const aiDragRef = useRef<{
        startX: number;
        startY: number;
        origX: number;
        origY: number;
    } | null>(null);
    const barsRef = useRef<Candle[]>([]);
    const indSeriesRef = useRef<ISeriesApi<'Line'>[]>([]);
    const structureLinesRef = useRef<IPriceLine[]>([]);
    const triggers = useTriggers().filter((t) => t.code === contract.code);
    const workingOrders = useMemo(
        () =>
            trades.filter(
                (t) =>
                    (t.contract.code === contract.code ||
                        (contract.target_code &&
                            t.contract.code === contract.target_code)) &&
                    ACTIVE_ORDER_STATUSES.has(t.status.status),
            ),
        [trades, contract],
    );
    const workingOrdersRef = useRef(workingOrders);
    workingOrdersRef.current = workingOrders;
    const orderLinesRef = useRef(new Map<string, IPriceLine>());
    const rangeLinesRef = useRef<{ high?: IPriceLine; low?: IPriceLine }>({});
    const [rangeMarks, setRangeMarks] = useState<{ high: number; low: number } | null>(null);
    const [visibleRange, setVisibleRange] = useState<{ from: number; to: number } | null>(null);
    const onOrdersChangedRef = useRef(onOrdersChanged);
    onOrdersChangedRef.current = onOrdersChanged;

    // refs so the chart click handler always sees current values
    const modeRef = useRef(mode);
    modeRef.current = mode;
    const qtyRef = useRef(tradeQty);
    qtyRef.current = tradeQty;
    const contractRef = useRef(contract);
    contractRef.current = contract;
    const lastPriceRef = useRef<number | null>(null);

    useEffect(() => {
        setAiDecision(null);
    }, [contract.code]);

    const runAiDecision = async () => {
        if (aiBusy) return;
        const bars = barsRef.current;
        const atLocal = new Date().toLocaleTimeString('zh-TW', {
            hour12: false,
        });

        const applyLocal = (extra?: { source?: string; coach?: string }) => {
            const structure = analyzePriceStructure(bars);
            if (bars.length < 30) {
                const trap = detectInstTraps(bars, '盤整', 0, structure);
                setAiDecision({
                    score: 0,
                    stance: '盤整',
                    reasons: ['資料量不足，至少需要 30 根 K 棒'],
                    at: atLocal,
                    source: extra?.source ?? 'local',
                    coach:
                        extra?.coach ||
                        structure?.hint ||
                        '教練：K 棒不足 30 根，先不要判定方向，等資料夠再按 AI判定。',
                    structure,
                    action: '無法判定',
                    actionReason: trap.actionReason,
                    traps: trap.traps,
                });
                return;
            }
            const close = bars[bars.length - 1]!.close;
            const ma20Series = sma(bars, 20);
            const ma60Series = sma(bars, 60);
            const vwapSeries = vwap(bars);
            const rsiSeries = rsi(bars, 14);
            const lastMa20 = ma20Series[ma20Series.length - 1]?.value ?? close;
            const lastMa60 = ma60Series[ma60Series.length - 1]?.value ?? close;
            const lastVwap = vwapSeries[vwapSeries.length - 1]?.value ?? close;
            const lastRsi = rsiSeries[rsiSeries.length - 1]?.value ?? 50;
            const prevClose = bars[bars.length - 2]?.close ?? close;
            const latestVolume = bars[bars.length - 1]!.volume;
            const avg20Vol =
                bars.slice(-20).reduce((sum, b) => sum + b.volume, 0) / 20 ||
                latestVolume;

            let score = 0;
            const reasons: string[] = [];

            if (close > lastMa20) {
                score += 18;
                reasons.push('站上 MA20');
            } else {
                score -= 18;
                reasons.push('跌破 MA20');
            }
            if (close > lastMa60) {
                score += 14;
                reasons.push('長趨勢高於 MA60');
            } else {
                score -= 14;
                reasons.push('長趨勢低於 MA60');
            }
            if (close > lastVwap) {
                score += 12;
                reasons.push('現價高於 VWAP');
            } else {
                score -= 12;
                reasons.push('現價低於 VWAP');
            }

            const mom = ((close - prevClose) / (prevClose || close)) * 100;
            if (mom > 0.35) {
                score += 10;
                reasons.push('短線動能轉強');
            } else if (mom < -0.35) {
                score -= 10;
                reasons.push('短線動能轉弱');
            }

            if (lastRsi >= 55 && lastRsi <= 72) {
                score += 12;
                reasons.push(`RSI ${lastRsi.toFixed(1)} 偏多`);
            } else if (lastRsi <= 45 && lastRsi >= 28) {
                score -= 12;
                reasons.push(`RSI ${lastRsi.toFixed(1)} 偏空`);
            } else if (lastRsi > 72) {
                score -= 6;
                reasons.push(`RSI ${lastRsi.toFixed(1)} 過熱`);
            } else if (lastRsi < 28) {
                score += 6;
                reasons.push(`RSI ${lastRsi.toFixed(1)} 超賣反彈區`);
            }

            if (latestVolume > avg20Vol * 1.35) {
                score += 8;
                reasons.push('量能放大');
            } else if (latestVolume < avg20Vol * 0.7) {
                score -= 4;
                reasons.push('量能偏弱');
            }

            score = Math.max(-100, Math.min(100, Math.round(score)));
            const stance: '看漲' | '看跌' | '盤整' =
                score >= 18 ? '看漲' : score <= -18 ? '看跌' : '盤整';

            const stopPct = 0.01;
            const takePct = 0.02;
            let entry: number | undefined;
            let stop: number | undefined;
            let take: number | undefined;
            let rr: number | undefined;
            if (stance === '看漲') {
                entry = close;
                stop = +(close * (1 - stopPct)).toFixed(2);
                take = +(close * (1 + takePct)).toFixed(2);
                rr = +(takePct / stopPct).toFixed(1);
            } else if (stance === '看跌') {
                entry = close;
                stop = +(close * (1 + stopPct)).toFixed(2);
                take = +(close * (1 - takePct)).toFixed(2);
                rr = +(takePct / stopPct).toFixed(1);
            }

            const trap = detectInstTraps(bars, stance, score, structure);
            if (trap.blocked || trap.action === '無法判定') {
                entry = undefined;
                stop = undefined;
                take = undefined;
                rr = undefined;
            }

            setAiDecision({
                score,
                stance,
                reasons: reasons.slice(0, 4),
                at: atLocal,
                entry,
                stop,
                take,
                rr,
                source: extra?.source ?? 'local',
                structure,
                action: trap.action,
                actionReason: trap.actionReason,
                traps: trap.traps,
                coach:
                    extra?.coach ||
                    [
                        `建議：${trap.action}。${trap.actionReason}`,
                        structure?.hint,
                        buildLocalCoach({
                            score,
                            stance,
                            reasons: reasons.slice(0, 4),
                            entry,
                            stop,
                            take,
                            rr,
                        }),
                    ]
                        .filter(Boolean)
                        .join(' '),
            });
        };

        setAiBusy(true);
        try {
            const result = await analyzeWithServer({
                code: contract.code,
                name: contract.name,
                bars: bars.map((b) => ({
                    open: b.open,
                    high: b.high,
                    low: b.low,
                    close: b.close,
                    volume: b.volume,
                })),
                withCoach: true,
            });
            const structure = analyzePriceStructure(bars);
            const trap = detectInstTraps(
                bars,
                result.stance,
                result.score,
                structure,
            );
            let entry = result.entry;
            let stop = result.stop;
            let take = result.take;
            let rr = result.rr;
            if (trap.blocked || trap.action === '無法判定') {
                entry = undefined;
                stop = undefined;
                take = undefined;
                rr = undefined;
            }
            const localCoach = [
                `建議：${trap.action}。${trap.actionReason}`,
                structure?.hint,
                buildLocalCoach({
                    score: result.score,
                    stance: result.stance,
                    reasons: result.reasons ?? [],
                    entry,
                    stop,
                    take,
                    rr,
                }),
            ]
                .filter(Boolean)
                .join(' ');
            setAiDecision({
                score: result.score,
                stance: result.stance,
                reasons: result.reasons ?? [],
                at: result.at ?? atLocal,
                entry,
                stop,
                take,
                rr,
                source: result.source,
                structure,
                action: trap.action,
                actionReason: trap.actionReason,
                traps: trap.traps,
                coach: result.coach?.trim()
                    ? `${structure?.hint ? structure.hint + ' ' : ''}建議：${trap.action}。${result.coach.trim()}`
                    : localCoach,
            });
        } catch {
            applyLocal({
                source: 'local',
                coach: undefined,
            });
        } finally {
            setAiBusy(false);
        }
    };

    // chart lifecycle
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const c = getChartColors(themeSettingsRef.current);
        const chart = createChart(host, {
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: c.text,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: chartFontSize(10),
                attributionLogo: false,
            },
            grid: {
                vertLines: { color: c.grid },
                horzLines: { color: c.grid },
            },
            crosshair: {
                vertLine: {
                    color: c.crosshair,
                    labelBackgroundColor: c.labelBg,
                },
                horzLine: {
                    color: c.crosshair,
                    labelBackgroundColor: c.labelBg,
                },
            },
            rightPriceScale: { borderColor: c.border },
            timeScale: {
                borderColor: c.border,
                timeVisible: true,
                secondsVisible: false,
                tickMarkFormatter: (
                    time: import('lightweight-charts').Time,
                    tickMarkType: import('lightweight-charts').TickMarkType,
                ) => {
                    // 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
                    const type = Number(tickMarkType);
                    if (type <= 2) return formatTickDate(time);
                    return formatTickTime(time);
                },
            },
            autoSize: true,
        });
        const candles = chart.addSeries(CandlestickSeries, {
            upColor: c.up,
            downColor: c.down,
            borderUpColor: c.up,
            borderDownColor: c.down,
            wickUpColor: c.up,
            wickDownColor: c.down,
        });
        const vol = chart.addSeries(HistogramSeries, {
            priceFormat: { type: 'volume' },
            priceScaleId: 'vol',
        });
        // Keep candlesticks and volume in separate vertical bands so zooming
        // never makes them visually overlap.
        chart.priceScale('right').applyOptions({
            scaleMargins: { top: 0.06, bottom: 0.24 },
        });
        chart.priceScale('vol').applyOptions({
            scaleMargins: { top: 0.80, bottom: 0.02 },
        });
        // RSI uses a separate pane created lazily when the indicator is on —
        // do not call priceScale('rsi') here (scale does not exist yet).
        chartRef.current = chart;
        candleSeriesRef.current = candles;
        volSeriesRef.current = vol;

        chart.subscribeClick((param) => {
            const m = modeRef.current;
            if (!param.point) return;
            const raw = candles.coordinateToPrice(param.point.y);
            if (raw === null) return;
            const c = contractRef.current;
            const price = roundToTick(c, Number(raw));
            if (m === 'observe') {
                setPickedPrice(c.code, price); // sync to order tickets
                return;
            }
            const qty = qtyRef.current;
            const last = lastPriceRef.current;
            setMode('observe'); // one-shot
            if (m === 'buy' || m === 'sell') {
                const action = m === 'buy' ? 'Buy' : 'Sell';
                placeQuickOrder(c, action, price, qty)
                    .then((trade) =>
                        notify({
                            kind: 'ok',
                            title: `📈 圖表${action === 'Buy' ? '買進' : '賣出'}已送出`,
                            body: `${c.code} ${qty} @ ${fmtPrice(price)} (${trade.status.status})`,
                        }),
                    )
                    .catch((e) =>
                        notify({
                            kind: 'err',
                            title: '圖表下單失敗',
                            body: e instanceof Error ? e.message : String(e),
                        }),
                    );
                return;
            }
            // stop / take triggers — direction inferred from click vs last
            if (last === null) {
                notify({
                    kind: 'err',
                    title: '無法掛觸價單',
                    body: '尚未收到即時成交價',
                });
                return;
            }
            const below = price <= last;
            if (m === 'alert') {
                addTrigger({
                    code: c.code,
                    condition: below ? 'below' : 'above',
                    price,
                    action: 'Sell', // unused for alerts
                    quantity: 0,
                    kind: 'alert',
                });
                return;
            }
            if (m === 'stop') {
                addTrigger({
                    code: c.code,
                    condition: below ? 'below' : 'above',
                    price,
                    action: below ? 'Sell' : 'Buy',
                    quantity: qty,
                    kind: 'stop',
                });
            } else {
                addTrigger({
                    code: c.code,
                    condition: below ? 'below' : 'above',
                    price,
                    action: below ? 'Buy' : 'Sell',
                    quantity: qty,
                    kind: 'take',
                });
            }
        });

        chart.subscribeCrosshairMove((param) => {
            if (!param.point) return;
            const raw = candles.coordinateToPrice(param.point.y);
            if (raw === null) return;
            const c = contractRef.current;
            setPickedPrice(c.code, roundToTick(c, Number(raw)));
        });

        chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
            if (!range) {
                setVisibleRange(null);
                return;
            }
            setVisibleRange({
                from: Number(range.from),
                to: Number(range.to),
            });
        });

        return () => {
            chart.remove();
            chartRef.current = null;
            candleSeriesRef.current = null;
            volSeriesRef.current = null;
        };
    }, []);

    // keep latest theme readable inside the chart-creation effect
    const themeSettingsRef = useRef(themeSettings);
    themeSettingsRef.current = themeSettings;

    // restyle chart on theme change
    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        chart.applyOptions({
            layout: { textColor: colors.text, fontSize: chartFontSize(10) },
            grid: {
                vertLines: { color: colors.grid },
                horzLines: { color: colors.grid },
            },
            crosshair: {
                vertLine: {
                    color: colors.crosshair,
                    labelBackgroundColor: colors.labelBg,
                },
                horzLine: {
                    color: colors.crosshair,
                    labelBackgroundColor: colors.labelBg,
                },
            },
            rightPriceScale: { borderColor: colors.border },
            timeScale: { borderColor: colors.border },
        });
        candleSeriesRef.current?.applyOptions({
            upColor: colors.up,
            downColor: colors.down,
            borderUpColor: colors.up,
            borderDownColor: colors.down,
            wickUpColor: colors.up,
            wickDownColor: colors.down,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [themeKey]);

    // load kbars on symbol/timeframe change (and recolor volume on theme change)
    useEffect(() => {
        let cancelled = false;
        lastBarRef.current = null;
        setEmpty(false);
        fetchKbars(contract, dateStrOffset(tf.days), dateStrOffset(0))
            .then((k) => {
                if (cancelled || !candleSeriesRef.current) return;
                const bars = aggregate(kbarsToCandles(k), tf.minutes);
                if (bars.length === 0) {
                    setEmpty(true);
                    return;
                }
                candleSeriesRef.current.setData(
                    bars.map((b) => ({
                        time: b.time as UTCTimestamp,
                        open: b.open,
                        high: b.high,
                        low: b.low,
                        close: b.close,
                    })),
                );
                volSeriesRef.current?.setData(
                    bars.map((b) => ({
                        time: b.time as UTCTimestamp,
                        value: b.volume,
                        color:
                            b.close >= b.open ? colors.upVol : colors.downVol,
                    })),
                );
                lastBarRef.current = bars[bars.length - 1] ?? null;
                barsRef.current = bars;
                setDataVersion((v) => v + 1);
                chartRef.current?.timeScale().scrollToRealTime();
            })
            .catch(() => setEmpty(true));
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contract, tf, themeKey]);

    // live tick -> update current bar
    const tick = quote?.tick;
    if (tick && tick.code === contract.code) {
        const p = Number(tick.close);
        if (Number.isFinite(p)) lastPriceRef.current = p;
    }
    useEffect(() => {
        if (!tick || tick.code !== contract.code) return;
        if (tick.simtrade) return; // 試撮 never paints into candles
        const series = candleSeriesRef.current;
        if (!series) return;
        const price = Number(tick.close);
        if (!Number.isFinite(price)) return;
        const tickTime = wallClockToUtc(`${tick.date}T${tick.time}`);
        const bucketSec = tf.minutes * 60;
        const bucket =
            tf.minutes >= 1440
                ? Math.floor(tickTime / 86400) * 86400
                : Math.floor(tickTime / bucketSec) * bucketSec;
        let bar = lastBarRef.current;
        if (!bar || bucket > bar.time) {
            bar = {
                time: bucket,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: tick.volume,
            };
            barsRef.current = [...barsRef.current, bar];
        } else {
            bar.high = Math.max(bar.high, price);
            bar.low = Math.min(bar.low, price);
            bar.close = price;
            bar.volume += tick.volume;
            const idx = barsRef.current.length - 1;
            if (idx >= 0) {
                barsRef.current[idx] = bar;
            } else {
                barsRef.current = [bar];
            }
        }
        lastBarRef.current = bar;
        series.update({
            time: bar.time as UTCTimestamp,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
        });
        volSeriesRef.current?.update({
            time: bar.time as UTCTimestamp,
            value: bar.volume,
            color: bar.close >= bar.open ? colors.upVol : colors.downVol,
        });
        setDataVersion((v) => v + 1);
    }, [tick, contract.code, tf.minutes]);

    // overlay indicators
    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        for (const series of indSeriesRef.current) {
            try {
                chart.removeSeries(series);
            } catch {
                // already gone with chart teardown
            }
        }
        indSeriesRef.current = [];
        const bars = barsRef.current;
        if (bars.length === 0) return;
        const addLine = (
            data: { time: number; value: number }[],
            color: string,
            width: 1 | 2 = 1,
            opts?: { priceScaleId?: string; paneIndex?: number },
        ) => {
            const series = chart.addSeries(
                LineSeries,
                {
                    color,
                    lineWidth: width,
                    priceLineVisible: false,
                    lastValueVisible: false,
                    crosshairMarkerVisible: false,
                    ...(opts?.priceScaleId
                        ? { priceScaleId: opts.priceScaleId }
                        : {}),
                },
                opts?.paneIndex,
            );
            series.setData(
                data.map((d) => ({
                    time: d.time as UTCTimestamp,
                    value: d.value,
                })),
            );
            indSeriesRef.current.push(series);
            return series;
        };
        for (const ind of INDICATOR_DEFS) {
            if (!indicators.has(ind.key)) continue;
            if (ind.kind === 'ma') {
                const period = Math.max(
                    2,
                    maPeriods[ind.key] ?? ind.defaultPeriod ?? 5,
                );
                addLine(sma(bars, period), ind.color);
            } else if (ind.kind === 'ema') {
                addLine(ema(bars, ind.defaultPeriod ?? 12), ind.color);
            } else if (ind.kind === 'vwap') {
                addLine(vwap(bars), ind.color, 2);
            } else if (ind.kind === 'bb') {
                const b = bollinger(bars);
                addLine(b.mid, ind.color);
                addLine(b.upper, ind.color);
                addLine(b.lower, ind.color);
            } else if (ind.kind === 'rsi') {
                // paneIndex 1 auto-creates an RSI pane under the main chart
                addLine(rsi(bars, 14), ind.color, 1, {
                    priceScaleId: 'right',
                    paneIndex: 1,
                });
                addLine(
                    bars.map((b) => ({ time: b.time, value: 70 })),
                    '#d06767',
                    1,
                    { priceScaleId: 'right', paneIndex: 1 },
                );
                addLine(
                    bars.map((b) => ({ time: b.time, value: 30 })),
                    '#58a978',
                    1,
                    { priceScaleId: 'right', paneIndex: 1 },
                );
                try {
                    chart.panes()[1]?.setHeight(90);
                } catch {
                    // pane may not exist if library version differs
                }
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataVersion, indicators, maPeriods]);

    // draw highest/lowest guide lines for the current loaded range
    useEffect(() => {
        const series = candleSeriesRef.current;
        if (!series) return;

        if (rangeLinesRef.current.high) {
            series.removePriceLine(rangeLinesRef.current.high);
        }
        if (rangeLinesRef.current.low) {
            series.removePriceLine(rangeLinesRef.current.low);
        }
        rangeLinesRef.current = {};

        const allBars = barsRef.current;
        const bars =
            visibleRange === null
                ? allBars
                : allBars.filter(
                      (b) => b.time >= visibleRange.from && b.time <= visibleRange.to,
                  );
        if (bars.length === 0) {
            setRangeMarks(null);
            return;
        }

        let highest = bars[0]!.high;
        let lowest = bars[0]!.low;
        for (const b of bars) {
            if (b.high > highest) highest = b.high;
            if (b.low < lowest) lowest = b.low;
        }

        setRangeMarks({ high: highest, low: lowest });
        rangeLinesRef.current.high = series.createPriceLine({
            price: highest,
            color: colors.up,
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: `最高 ${fmtPrice(highest)}`,
        });
        rangeLinesRef.current.low = series.createPriceLine({
            price: lowest,
            color: colors.down,
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: `最低 ${fmtPrice(lowest)}`,
        });

        return () => {
            if (rangeLinesRef.current.high) {
                series.removePriceLine(rangeLinesRef.current.high);
            }
            if (rangeLinesRef.current.low) {
                series.removePriceLine(rangeLinesRef.current.low);
            }
            rangeLinesRef.current = {};
        };
    }, [dataVersion, contract.code, colors.up, colors.down, visibleRange]);

    // Draw support / resistance / target after AI structure analysis
    useEffect(() => {
        const series = candleSeriesRef.current;
        for (const line of structureLinesRef.current) {
            try {
                series?.removePriceLine(line);
            } catch {
                // chart may have been torn down
            }
        }
        structureLinesRef.current = [];
        const s = aiDecision?.structure;
        if (!series || !s) return;

        const add = (
            price: number,
            color: string,
            title: string,
            style: 0 | 1 | 2 | 3 = 2,
        ) => {
            structureLinesRef.current.push(
                series.createPriceLine({
                    price,
                    color,
                    lineWidth: 1,
                    lineStyle: style,
                    axisLabelVisible: true,
                    title,
                }),
            );
        };

        add(s.resistance, '#e0a43c', `壓力 ${fmtPrice(s.resistance)}`);
        add(s.support, '#5a9e6f', `支撐 ${fmtPrice(s.support)}`);
        if (s.target != null) {
            add(s.target, '#b06fff', `預測 ${fmtPrice(s.target)}`, 1);
        }
        if (s.invalidation != null) {
            add(
                s.invalidation,
                '#8b94a7',
                `失效 ${fmtPrice(s.invalidation)}`,
                3,
            );
        }

        return () => {
            for (const line of structureLinesRef.current) {
                try {
                    series.removePriceLine(line);
                } catch {
                    // ignore
                }
            }
            structureLinesRef.current = [];
        };
    }, [aiDecision?.structure, contract.code, themeKey]);

    const toggleIndicator = (key: string) => {
        setIndicators((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            localStorage.setItem(
                'sj-pro-indicators',
                JSON.stringify([...next]),
            );
            return next;
        });
    };

    const setMaPeriod = (key: string, value: number) => {
        const period = Math.min(240, Math.max(2, Math.round(value) || 2));
        setMaPeriods((prev) => {
            const next = { ...prev, [key]: period };
            localStorage.setItem('sj-pro-ma-periods', JSON.stringify(next));
            return next;
        });
        setIndicators((prev) => {
            if (prev.has(key)) return prev;
            const next = new Set(prev);
            next.add(key);
            localStorage.setItem(
                'sj-pro-indicators',
                JSON.stringify([...next]),
            );
            return next;
        });
    };

    // draw working-order price lines (buy=up color / sell=down color)
    const orderKey = JSON.stringify(
        workingOrders.map((t) => [
            t.order.id,
            t.status.modified_price || t.order.price,
            t.order.quantity - t.status.deal_quantity,
        ]),
    );
    useEffect(() => {
        const series = candleSeriesRef.current;
        if (!series) return;
        const lines = new Map<string, IPriceLine>();
        for (const t of workingOrdersRef.current) {
            const price = t.status.modified_price || t.order.price;
            const remaining = t.order.quantity - t.status.deal_quantity;
            lines.set(
                t.order.id,
                series.createPriceLine({
                    price,
                    color: t.order.action === 'Buy' ? colors.up : colors.down,
                    lineWidth: 2,
                    lineStyle: 0, // solid
                    axisLabelVisible: true,
                    title: `${t.order.action === 'Buy' ? '買' : '賣'}${remaining} ⠿`,
                }),
            );
        }
        orderLinesRef.current = lines;
        return () => {
            for (const line of lines.values()) series.removePriceLine(line);
            orderLinesRef.current = new Map();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [orderKey, themeKey, contract.code]);

    // drag an order line to modify its price
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        let dragging: { trade: Trade; line: IPriceLine; price: number } | null =
            null;

        const yOf = (e: MouseEvent) =>
            e.clientY - host.getBoundingClientRect().top;

        const findNear = (y: number) => {
            const series = candleSeriesRef.current;
            if (!series) return null;
            for (const t of workingOrdersRef.current) {
                const line = orderLinesRef.current.get(t.order.id);
                if (!line) continue;
                const coord = series.priceToCoordinate(line.options().price);
                if (coord !== null && Math.abs(coord - y) <= 6) {
                    return { trade: t, line };
                }
            }
            return null;
        };

        const hover = (e: MouseEvent) => {
            if (dragging) return;
            host.style.cursor = findNear(yOf(e)) ? 'ns-resize' : '';
        };

        const down = (e: MouseEvent) => {
            if (e.button !== 0) return;
            const hit = findNear(yOf(e));
            if (!hit) return;
            e.preventDefault();
            e.stopPropagation();
            chartRef.current?.applyOptions({
                handleScroll: false,
                handleScale: false,
            });
            dragging = {
                trade: hit.trade,
                line: hit.line,
                price: hit.line.options().price,
            };

            const move = (ev: MouseEvent) => {
                const series = candleSeriesRef.current;
                if (!series || !dragging) return;
                const raw = series.coordinateToPrice(yOf(ev));
                if (raw === null) return;
                const np = roundToTick(contractRef.current, Number(raw));
                dragging.price = np;
                dragging.line.applyOptions({ price: np });
            };
            const up = () => {
                document.removeEventListener('mousemove', move, true);
                document.removeEventListener('mouseup', up, true);
                chartRef.current?.applyOptions({
                    handleScroll: true,
                    handleScale: true,
                });
                const d = dragging;
                dragging = null;
                if (!d) return;
                const orig =
                    d.trade.status.modified_price || d.trade.order.price;
                if (d.price === orig) return;
                updateOrderPrice(d.trade.order.id, d.price)
                    .then(() => {
                        notify({
                            kind: 'ok',
                            title: '✏️ 改價已送出',
                            body: `${d.trade.contract.code} ${fmtPrice(orig)} → ${fmtPrice(d.price)}`,
                        });
                        onOrdersChangedRef.current?.();
                    })
                    .catch((err) => {
                        notify({
                            kind: 'err',
                            title: '改價失敗',
                            body:
                                err instanceof Error
                                    ? err.message
                                    : String(err),
                        });
                        onOrdersChangedRef.current?.();
                    });
            };
            document.addEventListener('mousemove', move, true);
            document.addEventListener('mouseup', up, true);
        };

        host.addEventListener('mousedown', down, true); // capture: beat chart pan
        host.addEventListener('mousemove', hover, true);
        return () => {
            host.removeEventListener('mousedown', down, true);
            host.removeEventListener('mousemove', hover, true);
        };
    }, []);

    // draw trigger price lines on the candle series
    useEffect(() => {
        const series = candleSeriesRef.current;
        if (!series) return;
        const lines = triggers.map((t) =>
            series.createPriceLine({
                price: t.price,
                color:
                    t.kind === 'stop'
                        ? '#e0a43c'
                        : t.kind === 'alert'
                          ? '#8b94a7'
                          : colors.crosshair,
                lineWidth: 1,
                lineStyle: 2, // dashed
                axisLabelVisible: true,
                title:
                    t.kind === 'alert'
                        ? '警示'
                        : `${t.kind === 'stop' ? '停損' : '停利'}${t.action === 'Buy' ? '買' : '賣'}${t.quantity}`,
            }),
        );
        return () => {
            for (const line of lines) series.removePriceLine(line);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(triggers), themeKey, contract.code]);

    return (
        <div className={styles.wrap}>
            <div className={styles.toolbar}>
                {TIMEFRAMES.map((t, i) => (
                    <button
                        key={t.label}
                        className={styles.tfBtn[i === tfIdx ? 'active' : 'normal']}
                        onClick={() => setTfIdx(i)}
                    >
                        {t.label}
                    </button>
                ))}
                <span className={styles.toolbarDivider} />
                {TRADE_MODES.map((m) => (
                    <button
                        key={m.key}
                        className={
                            styles.modeBtn[
                                mode === m.key
                                    ? m.key === 'observe'
                                        ? 'active'
                                        : 'armed'
                                    : 'normal'
                            ]
                        }
                        onClick={() => setMode(m.key)}
                    >
                        {m.label}
                    </button>
                ))}
                <input
                    className={styles.qtyInput}
                    value={tradeQty}
                    inputMode='numeric'
                    title='下單數量'
                    onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isInteger(v) && v >= 1) setTradeQty(v);
                    }}
                />
                <div className={styles.maQuickRow}>
                    {INDICATOR_DEFS.filter((ind) => ind.kind === 'ma').map(
                        (ind) => {
                            const period =
                                maPeriods[ind.key] ?? ind.defaultPeriod ?? 5;
                            const on = indicators.has(ind.key);
                            return (
                                <button
                                    key={ind.key}
                                    type='button'
                                    className={
                                        styles.modeBtn[on ? 'active' : 'normal']
                                    }
                                    title={`均線 MA${period}（點擊開關）`}
                                    onClick={() => toggleIndicator(ind.key)}
                                >
                                    <span
                                        className={styles.indSwatch}
                                        style={{ background: ind.color }}
                                    />
                                    MA{period}
                                </button>
                            );
                        },
                    )}
                </div>
                <div style={{ position: 'relative' }}>
                    <button
                        ref={indBtnRef}
                        className={
                            styles.modeBtn[
                                indicators.size > 0 ? 'active' : 'normal'
                            ]
                        }
                        onClick={() => {
                            const next = !indMenuOpen;
                            if (next && indBtnRef.current) {
                                const r =
                                    indBtnRef.current.getBoundingClientRect();
                                const width = Math.min(
                                    200,
                                    window.innerWidth - 16,
                                );
                                let left = r.right - width;
                                if (left < 8) left = 8;
                                setIndMenuPos({
                                    top: Math.min(
                                        r.bottom + 4,
                                        window.innerHeight - 200,
                                    ),
                                    left,
                                });
                            }
                            setIndMenuOpen(next);
                        }}
                        title='開關均線／指標，並可改均線天數'
                    >
                        ⚙ 均線設定
                        {indicators.size > 0 ? ` ${indicators.size}` : ''}
                    </button>
                    {indMenuOpen && (
                        <>
                            <div
                                className={styles.indBackdrop}
                                onClick={() => setIndMenuOpen(false)}
                            />
                            <div
                                className={styles.indMenu}
                                style={{
                                    top: indMenuPos.top,
                                    left: indMenuPos.left,
                                }}
                            >
                                <div className={styles.indSection}>
                                    均線天數（可改）
                                </div>
                                {INDICATOR_DEFS.filter(
                                    (ind) => ind.kind === 'ma',
                                ).map((ind) => {
                                    const period =
                                        maPeriods[ind.key] ??
                                        ind.defaultPeriod ??
                                        5;
                                    const on = indicators.has(ind.key);
                                    return (
                                        <div
                                            className={styles.indMaRow}
                                            key={ind.key}
                                        >
                                            <button
                                                type='button'
                                                className={styles.indItem}
                                                onClick={() =>
                                                    toggleIndicator(ind.key)
                                                }
                                            >
                                                <span
                                                    className={styles.indSwatch}
                                                    style={{
                                                        background: ind.color,
                                                    }}
                                                />
                                                MA
                                                {on ? ' ✓' : ''}
                                            </button>
                                            <input
                                                className={styles.indPeriod}
                                                type='number'
                                                min={2}
                                                max={240}
                                                value={period}
                                                title='均線天數／根數'
                                                onChange={(e) =>
                                                    setMaPeriod(
                                                        ind.key,
                                                        Number(e.target.value),
                                                    )
                                                }
                                            />
                                        </div>
                                    );
                                })}
                                <div className={styles.indSection}>其他指標</div>
                                {INDICATOR_DEFS.filter(
                                    (ind) => ind.kind !== 'ma',
                                ).map((ind) => (
                                    <button
                                        key={ind.key}
                                        type='button'
                                        className={styles.indItem}
                                        onClick={() =>
                                            toggleIndicator(ind.key)
                                        }
                                    >
                                        <span
                                            className={styles.indSwatch}
                                            style={{ background: ind.color }}
                                        />
                                        {ind.label}
                                        {indicators.has(ind.key) && ' ✓'}
                                    </button>
                                ))}
                            </div>
                        </>
                    )}
                </div>
                <button
                    className={styles.modeBtn.active}
                    onClick={() => void runAiDecision()}
                    disabled={aiBusy}
                    title='呼叫 Python／Gemini 分析（失敗則本地規則）'
                >
                    {aiBusy ? '分析中…' : 'AI判定'}
                </button>
                {aiDecision?.coach && (
                    <span className={styles.coachInline} title={aiDecision.coach}>
                        {aiDecision.coach}
                    </span>
                )}
            </div>
            <div ref={hostRef} className={styles.chartHost}>
                {empty && (
                    <div className={styles.emptyMsg}>
                        <span className={panel.mono}>無 K 線資料</span>
                    </div>
                )}
                {mode !== 'observe' && (
                    <div className={styles.modeHint}>
                        {mode === 'buy' && '點擊圖表價位 → 限價買進'}
                        {mode === 'sell' && '點擊圖表價位 → 限價賣出'}
                        {mode === 'stop' && '點擊價位掛停損（觸價市價單）'}
                        {mode === 'take' && '點擊價位掛停利（觸價市價單）'}
                        {mode === 'alert' && '點擊價位設定到價警示（只通知不下單）'}
                    </div>
                )}
                {rangeMarks && (
                    <div className={styles.rangeBadge}>
                        <span>最高 {fmtPrice(rangeMarks.high)}</span>
                        <span>最低 {fmtPrice(rangeMarks.low)}</span>
                    </div>
                )}
                {aiDecision && (
                    <div
                        className={styles.aiBadge}
                        style={{
                            left: aiPanelPos.x,
                            top: aiPanelPos.y,
                            right: 'auto',
                        }}
                    >
                        <div
                            className={styles.aiDragBar}
                            title='按住拖曳，移開不要擋圖'
                            onPointerDown={(e) => {
                                e.preventDefault();
                                (e.currentTarget as HTMLElement).setPointerCapture(
                                    e.pointerId,
                                );
                                aiDragRef.current = {
                                    startX: e.clientX,
                                    startY: e.clientY,
                                    origX: aiPanelPos.x,
                                    origY: aiPanelPos.y,
                                };
                            }}
                            onPointerMove={(e) => {
                                const d = aiDragRef.current;
                                if (!d) return;
                                const host = hostRef.current;
                                const maxX = Math.max(
                                    0,
                                    (host?.clientWidth ?? 320) - 180,
                                );
                                const maxY = Math.max(
                                    0,
                                    (host?.clientHeight ?? 240) - 80,
                                );
                                setAiPanelPos({
                                    x: Math.min(
                                        maxX,
                                        Math.max(
                                            0,
                                            d.origX + (e.clientX - d.startX),
                                        ),
                                    ),
                                    y: Math.min(
                                        maxY,
                                        Math.max(
                                            0,
                                            d.origY + (e.clientY - d.startY),
                                        ),
                                    ),
                                });
                            }}
                            onPointerUp={() => {
                                aiDragRef.current = null;
                            }}
                            onPointerCancel={() => {
                                aiDragRef.current = null;
                            }}
                        >
                            <span className={styles.aiTitle}>
                                AI 綜合判斷 · {aiDecision.at}
                                {aiDecision.source
                                    ? ` · ${aiDecision.source}`
                                    : ''}
                            </span>
                            <button
                                type='button'
                                className={styles.aiClose}
                                title='關閉'
                                onClick={() => setAiDecision(null)}
                                onPointerDown={(e) => e.stopPropagation()}
                            >
                                ✕
                            </button>
                        </div>
                        <span
                            className={`${styles.aiScore} ${
                                aiDecision.stance === '看漲'
                                    ? panel.dirText.up
                                    : aiDecision.stance === '看跌'
                                      ? panel.dirText.down
                                      : panel.dirText.flat
                            }`}
                        >
                            {describeAiScore(
                                aiDecision.score,
                                aiDecision.stance,
                            )}{' '}
                            ({aiDecision.score > 0 ? '+' : ''}
                            {aiDecision.score})
                        </span>
                        {aiDecision.structure && (
                            <div className={styles.aiStructure}>
                                <span className={styles.aiStructureBias}>
                                    {aiDecision.structure.bias}
                                    <em>信心{aiDecision.structure.confidence}</em>
                                </span>
                                <div className={styles.aiLevels}>
                                    <span>
                                        壓力{' '}
                                        {fmtPrice(aiDecision.structure.resistance)}
                                    </span>
                                    <span>
                                        支撐{' '}
                                        {fmtPrice(aiDecision.structure.support)}
                                    </span>
                                    {aiDecision.structure.target != null && (
                                        <span>
                                            預測{' '}
                                            {fmtPrice(aiDecision.structure.target)}
                                        </span>
                                    )}
                                    {aiDecision.structure.invalidation !=
                                        null && (
                                        <span>
                                            失效{' '}
                                            {fmtPrice(
                                                aiDecision.structure.invalidation,
                                            )}
                                        </span>
                                    )}
                                </div>
                                <span className={styles.aiStructureHint}>
                                    {aiDecision.structure.hint}
                                </span>
                            </div>
                        )}
                        {aiDecision.entry != null &&
                            aiDecision.stop != null &&
                            aiDecision.take != null && (
                                <div className={styles.aiLevels}>
                                    <span>
                                        參考進 {fmtPrice(aiDecision.entry)}
                                    </span>
                                    <span>
                                        停損 {fmtPrice(aiDecision.stop)}
                                    </span>
                                    <span>
                                        停利 {fmtPrice(aiDecision.take)}
                                    </span>
                                    <span>RR {aiDecision.rr}</span>
                                </div>
                            )}
                        <span className={styles.aiReason}>
                            {aiDecision.reasons.join(' · ')}
                        </span>
                        {buildAiAlerts(aiDecision).map((tip) => (
                            <span className={styles.aiAlert} key={tip}>
                                {tip}
                            </span>
                        ))}
                        {aiDecision.coach && (
                            <span className={styles.aiCoach}>
                                {aiDecision.coach}
                            </span>
                        )}
                    </div>
                )}
                {(workingOrders.length > 0 || triggers.length > 0) && (
                    <div className={styles.triggerList}>
                        {workingOrders.map((t) => {
                            const price =
                                t.status.modified_price || t.order.price;
                            const remaining =
                                t.order.quantity - t.status.deal_quantity;
                            return (
                                <div
                                    key={t.order.id}
                                    className={styles.triggerRow}
                                >
                                    <span
                                        className={
                                            panel.dirText[
                                                t.order.action === 'Buy'
                                                    ? 'up'
                                                    : 'down'
                                            ]
                                        }
                                    >
                                        委{t.order.action === 'Buy' ? '買' : '賣'}
                                        {remaining} @{fmtPrice(price)}
                                    </span>
                                    <button
                                        className={styles.orderCancel}
                                        title='刪單'
                                        onClick={() =>
                                            cancelOrder(t.order.id)
                                                .then(() => {
                                                    notify({
                                                        kind: 'ok',
                                                        title: '🗑 刪單已送出',
                                                        body: `${t.contract.code} @${fmtPrice(price)}`,
                                                    });
                                                    onOrdersChangedRef.current?.();
                                                })
                                                .catch((e) =>
                                                    notify({
                                                        kind: 'err',
                                                        title: '刪單失敗',
                                                        body:
                                                            e instanceof Error
                                                                ? e.message
                                                                : String(e),
                                                    }),
                                                )
                                        }
                                    >
                                        CANCEL
                                    </button>
                                </div>
                            );
                        })}
                        {triggers.map((t) => (
                            <div key={t.id} className={styles.triggerRow}>
                                <span>
                                    {t.kind === 'stop'
                                        ? '⛔'
                                        : t.kind === 'take'
                                          ? '🎯'
                                          : '🔔'}{' '}
                                    {t.condition === 'below' ? '≤' : '≥'}
                                    {fmtPrice(t.price)}
                                    {t.kind !== 'alert' &&
                                        ` ${t.action === 'Buy' ? '買' : '賣'}${t.quantity}`}
                                </span>
                                <button
                                    className={styles.triggerRemove}
                                    onClick={() => removeTrigger(t.id)}
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
