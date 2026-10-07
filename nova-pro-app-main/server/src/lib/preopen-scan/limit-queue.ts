// 09:00–09:10: best bid/ask of the final pre-open list, sampled every 20s, so the
// post-close analysis can tell which trial-at-limit names held their limit-up
// bid queue (封單) and which were opened. Read-only research capture.

import { isTradingDay } from '../market-calendar/trading-day.ts';
import { sessionMinuteTaipei, taipeiYmd } from '../shadow/session.ts';
import { serverDataDir } from '../data-janitor.ts';
import { fetchShioajiSnapshots, type BridgeSnapshot } from '../../providers/shioaji/bridge-scanner.ts';
import { appendPreopenRow, preopenLiveState } from './capture.ts';

export const LIMIT_QUEUE_TYPE = 'LimitQueue';
const SAMPLE_MS = 20_000;
const MAX_CODES = 50;

export function isLimitQueueWindow(d: Date = new Date()): boolean {
    if (!isTradingDay(taipeiYmd(d))) return false;
    const sm = sessionMinuteTaipei(d);
    return sm >= 0 && sm < 10;
}

export async function sampleLimitQueue(
    d: Date = new Date(),
    dataDir = serverDataDir(),
    fetchSnapshots: (codes: readonly string[]) => Promise<BridgeSnapshot[]> = fetchShioajiSnapshots,
): Promise<number> {
    if (!isLimitQueueWindow(d)) return 0;
    const state = preopenLiveState(taipeiYmd(d), dataDir);
    const codes = state?.items.slice(0, MAX_CODES).map((it) => it.code) ?? [];
    if (!codes.length) return 0;
    const rows = await fetchSnapshots(codes);
    if (!rows.length) return 0;
    appendPreopenRow(
        {
            t: d.toISOString(),
            type: LIMIT_QUEUE_TYPE,
            source: 'shioaji',
            items: rows.map((r) => ({
                code: r.code,
                close: r.close,
                high: r.high,
                buy_price: r.buy_price,
                buy_volume: r.buy_volume,
                sell_price: r.sell_price,
                sell_volume: r.sell_volume,
                total_volume: r.total_volume,
                change_rate: r.change_rate,
            })),
        },
        dataDir,
    );
    return rows.length;
}

export function startLimitQueueSampler(dataDir: string): () => void {
    let busy = false;
    const timer = setInterval(() => {
        if (busy || !isLimitQueueWindow()) return;
        busy = true;
        void sampleLimitQueue(new Date(), dataDir)
            .catch(() => 0)
            .finally(() => {
                busy = false;
            });
    }, SAMPLE_MS);
    timer.unref();
    return () => clearInterval(timer);
}
