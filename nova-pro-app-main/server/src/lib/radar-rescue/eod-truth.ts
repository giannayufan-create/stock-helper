// server/src/lib/radar-rescue/eod-truth.ts

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fetchTwDailyBarsBatch } from '../tw-daily-bars.ts';
import type { EodTruthRow } from './types.ts';

function taipeiYmd(d = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

export class EodTruthService {
    private last: EodTruthRow[] = [];

    constructor(private dataDir: string) {}

    getLast(): EodTruthRow[] {
        return this.last;
    }

    load(ymd?: string): EodTruthRow[] {
        const day = ymd ?? taipeiYmd();
        const file = join(this.dataDir, 'daily_radar_truth', `${day}.json`);
        if (!existsSync(file)) return [];
        try {
            const rows = JSON.parse(readFileSync(file, 'utf8')) as EodTruthRow[];
            this.last = rows;
            return rows;
        } catch {
            return [];
        }
    }

    /**
     * Build EOD truth for a symbol universe (batch Yahoo/TW daily).
     * Call after market close — not every evaluate tick.
     */
    async buildForSymbols(
        symbols: string[],
        tradeDate = taipeiYmd(),
    ): Promise<EodTruthRow[]> {
        const unique = [...new Set(symbols.filter(Boolean))];
        const barsMap = await fetchTwDailyBarsBatch(unique, '1mo', 4);
        const rows: EodTruthRow[] = [];
        for (const symbol of unique) {
            const bars = barsMap.get(symbol) ?? [];
            if (bars.length < 2) continue;
            // Prefer bar matching tradeDate; else last bar
            let today = bars.find((b) => b.date === tradeDate) ?? bars[bars.length - 1]!;
            const prevIdx = bars.findIndex((b) => b.date === today.date);
            const prev =
                prevIdx > 0 ? bars[prevIdx - 1]! : bars.length >= 2 ? bars[bars.length - 2]! : null;
            const prevClose = prev?.close ?? null;
            const maxRet =
                prevClose && prevClose > 0
                    ? ((today.high - prevClose) / prevClose) * 100
                    : null;
            const closeRet =
                prevClose && prevClose > 0
                    ? ((today.close - prevClose) / prevClose) * 100
                    : null;
            const maxTwd =
                prevClose != null ? today.high - prevClose : null;
            rows.push({
                trade_date: tradeDate,
                symbol,
                prev_close: prevClose,
                open: today.open,
                high: today.high,
                low: today.low,
                close: today.close,
                adjusted_reference_price: prevClose,
                max_return_pct: maxRet,
                close_return_pct: closeRet,
                max_twd_move: maxTwd,
                hit_plus_1_twd: maxTwd != null && maxTwd >= 1,
                hit_plus_3pct: maxRet != null && maxRet >= 3,
                hit_plus_5pct: maxRet != null && maxRet >= 5,
                hit_limit_up: maxRet != null && maxRet >= 9.5,
                intraday_range:
                    today.low > 0
                        ? ((today.high - today.low) / today.low) * 100
                        : null,
                corporate_action_type: null,
                corporate_action_adjusted: false,
            });
        }
        this.last = rows;
        const dir = join(this.dataDir, 'daily_radar_truth');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, `${tradeDate}.json`),
            JSON.stringify(rows, null, 2),
            'utf8',
        );
        return rows;
    }
}
