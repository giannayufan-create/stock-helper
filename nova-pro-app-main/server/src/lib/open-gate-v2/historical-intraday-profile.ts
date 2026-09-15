// server/src/lib/open-gate-v2/historical-intraday-profile.ts
// Same-time RVOL: today cum vol / avg of past N days' cum vol at same minute.
// Preload once; never re-scan 20d raw bars every evaluate tick.

import type { MarketManager } from '../../providers/manager.ts';
import type { OpenGateConfig } from './config.ts';

export interface MinuteCurve {
    /** minute from 09:00 → cumulative volume */
    byMinute: Map<number, number>;
    daysUsed: number;
}

function taipeiYmd(d = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

function sessionMinuteFromDatetime(dt: string): number | null {
    // "YYYY-MM-DD HH:mm:ss"
    const m = dt.match(/(\d{2}):(\d{2})/);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const mins = hh * 60 + mm;
    const open = 9 * 60;
    if (mins < open || mins > 13 * 60 + 30) return null;
    return mins - open;
}

function addDaysYmd(ymd: string, delta: number): string {
    const parts = ymd.split('-').map(Number);
    const y = parts[0] ?? 2020;
    const mo = parts[1] ?? 1;
    const d = parts[2] ?? 1;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    dt.setUTCDate(dt.getUTCDate() + delta);
    return dt.toISOString().slice(0, 10);
}

export class HistoricalProfileCache {
    private curves = new Map<string, MinuteCurve>();
    private ready = false;
    private lastError: string | null = null;

    constructor(
        private market: MarketManager,
        private cfg: OpenGateConfig,
    ) {}

    isReady(): boolean {
        return this.ready && this.curves.size > 0;
    }

    lastErrorMessage(): string | null {
        return this.lastError;
    }

    getCurve(symbol: string): MinuteCurve | undefined {
        return this.curves.get(symbol);
    }

    /**
     * Average cumulative volume at session minute `m` (0 = 09:00).
     * Interpolates from nearest anchors if exact minute missing.
     */
    avgCumVolume(symbol: string, sessionMinute: number): number | null {
        const curve = this.curves.get(symbol);
        if (!curve || curve.daysUsed < 3) return null;
        if (curve.byMinute.has(sessionMinute)) {
            return curve.byMinute.get(sessionMinute)!;
        }
        // nearest lower/upper
        let lo = -1;
        let hi = -1;
        for (const k of curve.byMinute.keys()) {
            if (k <= sessionMinute && k > lo) lo = k;
            if (k >= sessionMinute && (hi < 0 || k < hi)) hi = k;
        }
        if (lo >= 0 && curve.byMinute.has(lo)) return curve.byMinute.get(lo)!;
        if (hi >= 0 && curve.byMinute.has(hi)) return curve.byMinute.get(hi)!;
        return null;
    }

    rvolSameTime(
        symbol: string,
        currentCumVol: number,
        sessionMinute: number,
    ): number | null {
        const avg = this.avgCumVolume(symbol, sessionMinute);
        if (avg == null || avg <= 0 || currentCumVol < 0) return null;
        return currentCumVol / avg;
    }

    async preload(
        symbols: string[],
        opts?: { asOfExclusiveYmd?: string },
    ): Promise<void> {
        this.lastError = null;
        const lookback = this.cfg.historical_profile.lookback_days;
        const anchors = this.cfg.historical_profile.anchor_minutes;
        // Point-in-time: exclusive end date (replay day itself excluded)
        const end = opts?.asOfExclusiveYmd ?? taipeiYmd();
        const start = addDaysYmd(end, -(lookback + 10)); // buffer for weekends

        let ok = 0;
        for (const symbol of symbols) {
            try {
                const kbars = await this.market.kbars(
                    {
                        code: symbol,
                        security_type: 'STK',
                        exchange: null,
                    },
                    start,
                    end,
                );
                const dayCum = new Map<string, Map<number, number>>();
                for (let i = 0; i < kbars.datetime.length; i++) {
                    const dt = kbars.datetime[i];
                    if (!dt) continue;
                    const day = dt.slice(0, 10);
                    if (day >= end) continue; // exclude as-of day and future
                    const sm = sessionMinuteFromDatetime(dt);
                    if (sm == null) continue;
                    const vol = Number(kbars.Volume[i]) || 0;
                    if (!dayCum.has(day)) dayCum.set(day, new Map());
                    const m = dayCum.get(day)!;
                    const prev = m.get(sm) ?? 0;
                    m.set(sm, prev + vol);
                }

                // convert per-minute bar vol → cumulative, then average across days
                const sumAt = new Map<number, number>();
                const cntAt = new Map<number, number>();
                const days = [...dayCum.keys()].sort().slice(-lookback);

                for (const day of days) {
                    const bars = dayCum.get(day)!;
                    const minutes = [...bars.keys()].sort((a, b) => a - b);
                    let cum = 0;
                    const cumMap = new Map<number, number>();
                    for (const sm of minutes) {
                        cum += bars.get(sm) ?? 0;
                        cumMap.set(sm, cum);
                    }
                    // fill anchors by last known cum
                    let last = 0;
                    for (let m = 0; m <= 30; m++) {
                        if (cumMap.has(m)) last = cumMap.get(m)!;
                        else if (last > 0) cumMap.set(m, last);
                    }
                    for (const a of anchors) {
                        const v = cumMap.get(a);
                        if (v == null || v <= 0) continue;
                        sumAt.set(a, (sumAt.get(a) ?? 0) + v);
                        cntAt.set(a, (cntAt.get(a) ?? 0) + 1);
                    }
                    // also store full minute curve averages
                    for (const [m, v] of cumMap) {
                        if (!anchors.includes(m) && this.cfg.historical_profile.prefer_minute_curve) {
                            sumAt.set(m, (sumAt.get(m) ?? 0) + v);
                            cntAt.set(m, (cntAt.get(m) ?? 0) + 1);
                        }
                    }
                }

                const byMinute = new Map<number, number>();
                for (const [m, sum] of sumAt) {
                    const c = cntAt.get(m) ?? 0;
                    if (c > 0) byMinute.set(m, sum / c);
                }
                if (byMinute.size >= 3) {
                    this.curves.set(symbol, {
                        byMinute,
                        daysUsed: days.length,
                    });
                    ok += 1;
                }
            } catch (err) {
                this.lastError =
                    err instanceof Error ? err.message : String(err);
            }
        }
        this.ready = ok > 0;
    }

    /** Test / fixture: inject a ready curve without network. */
    injectCurve(
        symbol: string,
        byMinute: Map<number, number>,
        daysUsed = 20,
    ): void {
        this.curves.set(symbol, { byMinute, daysUsed });
        this.ready = true;
    }

    clear(): void {
        this.curves.clear();
        this.ready = false;
    }
}
