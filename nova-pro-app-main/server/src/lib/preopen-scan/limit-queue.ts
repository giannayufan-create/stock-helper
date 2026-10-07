// 09:00–09:10: best bid/ask of the final pre-open list, sampled every 20s, so the
// post-close analysis can tell which trial-at-limit names held their limit-up
// bid queue (封單) and which were opened. Read-only research capture.
// Fugle intraday quotes are primary when a key is set. Shioaji forbids polling
// snapshots intraday (https://sinotrade.github.io/zh/tutor/limit/), so it is
// asked once at 09:05 for the source comparison (role "shadow") and otherwise
// only when Fugle returns nothing, at most once a minute.

import { isTradingDay } from '../market-calendar/trading-day.ts';
import { sessionMinuteTaipei, taipeiYmd } from '../shadow/session.ts';
import { serverDataDir } from '../data-janitor.ts';
import {
    fetchShioajiSnapshots,
    shioajiOptionalAllowed,
    type BridgeSnapshot,
} from '../../providers/shioaji/bridge-scanner.ts';
import { appendPreopenRow, preopenLiveState } from './capture.ts';
import { fetchFugleQueue, type FugleQueueRow } from './fugle-preopen.ts';

export const LIMIT_QUEUE_TYPE = 'LimitQueue';
const SAMPLE_MS = 20_000;
const MAX_CODES = 50;
const SHIOAJI_FALLBACK_GAP_MS = 60_000;
const SHADOW_FROM_MINUTE = 5;

let lastShioajiAt = 0;
let shadowDate = '';

export function resetLimitQueueState(): void {
    latest = null;
    lastShioajiAt = 0;
    shadowDate = '';
}

export interface LimitQueueSample {
    date: string;
    at: string;
    source: 'fugle' | 'shioaji';
    items: BridgeSnapshot[];
}

let latest: LimitQueueSample | null = null;

export function latestLimitQueue(ymd: string = taipeiYmd()): LimitQueueSample | null {
    return latest?.date === ymd ? latest : null;
}

export function isLimitQueueWindow(d: Date = new Date()): boolean {
    if (!isTradingDay(taipeiYmd(d))) return false;
    const sm = sessionMinuteTaipei(d);
    return sm >= 0 && sm < 10;
}

const toRow = (r: BridgeSnapshot | FugleQueueRow) => ({
    code: r.code,
    close: r.close,
    high: r.high,
    buy_price: r.buy_price,
    buy_volume: r.buy_volume,
    sell_price: r.sell_price,
    sell_volume: r.sell_volume,
    total_volume: r.total_volume,
    change_rate: r.change_rate,
    ...('limit_up_bid' in r
        ? { reference: r.reference, limit_up_bid: r.limit_up_bid, limit_up_price_hit: r.limit_up_price_hit }
        : {}),
});

export interface LimitQueueFetchers {
    shioaji?: (codes: readonly string[]) => Promise<BridgeSnapshot[]>;
    fugle?: ((codes: readonly string[], d: Date) => Promise<FugleQueueRow[]>) | null;
    /** Whether optional (comparison-only) Shioaji calls are within the traffic budget. */
    shioajiOptional?: () => Promise<boolean>;
}

export async function sampleLimitQueue(
    d: Date = new Date(),
    dataDir = serverDataDir(),
    fetchers: LimitQueueFetchers = {},
): Promise<number> {
    if (!isLimitQueueWindow(d)) return 0;
    const state = preopenLiveState(taipeiYmd(d), dataDir);
    const codes = state?.items.slice(0, MAX_CODES).map((it) => it.code) ?? [];
    if (!codes.length) return 0;
    const ymd = taipeiYmd(d);
    const fg = fetchers.fugle ? await fetchers.fugle(codes, d).catch(() => [] as FugleQueueRow[]) : [];
    const shioajiFree = d.getTime() - lastShioajiAt >= SHIOAJI_FALLBACK_GAP_MS || d.getTime() < lastShioajiAt;
    const wantShadow =
        fg.length > 0 &&
        shadowDate !== ymd &&
        sessionMinuteTaipei(d) >= SHADOW_FROM_MINUTE &&
        shioajiFree &&
        (await (fetchers.shioajiOptional ?? (async () => true))());
    const wantFallback = fg.length === 0 && shioajiFree;
    let sj: BridgeSnapshot[] = [];
    if (wantShadow || wantFallback) {
        lastShioajiAt = d.getTime();
        if (wantShadow) shadowDate = ymd;
        sj = await (fetchers.shioaji ?? fetchShioajiSnapshots)(codes).catch(() => [] as BridgeSnapshot[]);
    }
    const primary = fg.length ? 'fugle' : 'shioaji';
    const t = d.toISOString();
    if (fg.length) appendPreopenRow({ t, type: LIMIT_QUEUE_TYPE, source: 'fugle', items: fg.map(toRow) }, dataDir);
    if (sj.length) {
        appendPreopenRow(
            {
                t,
                type: LIMIT_QUEUE_TYPE,
                source: 'shioaji',
                ...(primary === 'fugle' ? { role: 'shadow' as const } : {}),
                items: sj.map(toRow),
            },
            dataDir,
        );
    }
    const rows = primary === 'fugle' ? fg : sj;
    if (!rows.length) return 0;
    latest = { date: ymd, at: t, source: primary, items: rows };
    return rows.length;
}

export function startLimitQueueSampler(dataDir: string, getFugleKey: () => string = () => ''): () => void {
    let busy = false;
    const timer = setInterval(() => {
        if (busy || !isLimitQueueWindow()) return;
        busy = true;
        const key = getFugleKey();
        void sampleLimitQueue(new Date(), dataDir, {
            fugle: key ? (codes, d) => fetchFugleQueue(key, codes, d) : null,
            shioajiOptional: () => shioajiOptionalAllowed(),
        })
            .catch(() => 0)
            .finally(() => {
                busy = false;
            });
    }, SAMPLE_MS);
    timer.unref();
    return () => clearInterval(timer);
}
