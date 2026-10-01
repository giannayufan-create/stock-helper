// server/src/lib/strategy-validation/service.ts
// Read-only validation summary from RawSignalStore (+ optional demo bars).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawSignalEvent } from '../strategy-signal/raw-signal-event.ts';
import { RawSignalStore } from '../strategy-signal/raw-signal-store.ts';
import type { ValidationBarSource } from './bar-source.ts';
import {
    emptyValidationSummary,
    validateSignals,
} from './tracker.ts';
import {
    DEFAULT_PROVISIONAL_ASSUMPTIONS,
    VALIDATION_STRATEGY_NAME,
    VALIDATION_STRATEGY_VERSION,
    type PriceBar,
    type ValidationSummary,
} from './types.ts';

/**
 * First day with a single writer (stock-helper-api, Shioaji feed, session guard).
 * Earlier raw signals mix feeds / after-hours emissions and are not validated.
 */
export const VALIDATION_DATA_START_YMD = '2026-10-01';

function defaultRawRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', 'data', 'raw_strategy_signals');
}

function taipeiYmd(offsetDays = 0): string {
    const d = new Date(Date.now() + offsetDays * 86_400_000);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

function signalYmd(iso: string): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date(iso));
}

const BAR_FETCH_CONCURRENCY = 4;

export class StrategyValidationService {
    readonly store: RawSignalStore;
    private bars: ValidationBarSource | null;

    constructor(store?: RawSignalStore, bars?: ValidationBarSource) {
        this.store = store ?? new RawSignalStore(defaultRawRoot());
        this.bars = bars ?? null;
    }

    /**
     * Read-only summary. Without a bar source (or when bars / prior close are
     * unavailable for a symbol-day), path/sim stay insufficient — never invented.
     * demo=true attaches synthetic bars (clearly labeled) for UI smoke only.
     */
    async getSummary(opts: {
        from?: string;
        to?: string;
        demo?: boolean;
    }): Promise<ValidationSummary> {
        const to = opts.to ?? taipeiYmd();
        const requestedFrom = opts.from ?? taipeiYmd(-30);
        const from =
            requestedFrom < VALIDATION_DATA_START_YMD
                ? VALIDATION_DATA_START_YMD
                : requestedFrom;
        const events = (from > to ? [] : this.store.listRange(from, to))
            .filter(
                (e) =>
                    e.strategy_name === VALIDATION_STRATEGY_NAME &&
                    e.strategy_version === VALIDATION_STRATEGY_VERSION &&
                    e.source_mode === 'live',
            );

        if (events.length === 0 && !opts.demo) {
            return emptyValidationSummary({
                validation_date: to,
                data_source: 'raw_strategy_signals',
                source_mode: 'live',
            });
        }

        if (opts.demo) {
            return this.demoSummary(to);
        }

        const dayBars = await this.loadDayBars(events);
        const summary = validateSignals({
            events,
            barsBySymbol: {},
            barsForEvent: (e) =>
                dayBars.get(`${signalYmd(e.signal_time)}:${e.symbol}`),
            assumptions: DEFAULT_PROVISIONAL_ASSUMPTIONS,
            run_simulation: true,
            validation_date: to,
            data_source: `raw_strategy_signals:${from}..${to}`,
        });
        return summary;
    }

    /** Same-day bars per signal (key `${ymd}:${symbol}`), never across sessions. */
    private async loadDayBars(
        events: RawSignalEvent[],
    ): Promise<Map<string, PriceBar[]>> {
        const out = new Map<string, PriceBar[]>();
        const source = this.bars;
        if (!source) return out;
        const keys = [
            ...new Set(
                events.map((e) => `${signalYmd(e.signal_time)}:${e.symbol}`),
            ),
        ];
        let next = 0;
        const worker = async () => {
            while (next < keys.length) {
                const key = keys[next++]!;
                const [date, symbol] = key.split(':') as [string, string];
                const bars = await source.loadDay(date, symbol);
                if (bars) out.set(key, bars);
            }
        };
        await Promise.all(
            Array.from(
                { length: Math.min(BAR_FETCH_CONCURRENCY, keys.length) },
                worker,
            ),
        );
        return out;
    }

    /** Synthetic demo — never claim as live edge. */
    private demoSummary(validationDate: string): ValidationSummary {
        const t0 = Date.parse('2026-09-25T01:30:00.000Z');
        const bars: PriceBar[] = [2, 10, 20, 40, 55].map((m, i) => ({
            t: t0 + m * 60_000,
            open: 100 + i * 0.3,
            high: 101 + i * 0.5,
            low: 99.5 + i * 0.2,
            close: 100.5 + i * 0.4,
        }));
        const events = [
            {
                signal_id: 'demo_open_pass_001',
                symbol: '2330',
                strategy_name: 'OPEN_PASS' as const,
                strategy_version: 'bc-strategy-v1',
                config_hash: 'demo',
                signal_time: new Date(t0).toISOString(),
                observation_time: new Date(t0).toISOString(),
                data_source: 'synthetic_demo',
                source_mode: 'synthetic' as const,
                price_at_signal: 100,
                scores: { final_open_score: 82 },
                trigger_conditions: { tradeable_candidate: true },
                key_inputs: { gap_pct: 1.1 },
                data_completeness: { learning_eligible: false },
                exit_rules_snapshot: { invalid_price: 97 },
                schema_version: 'raw-signal-event-v1' as const,
            },
        ];
        const summary = validateSignals({
            events,
            barsBySymbol: { '2330': bars },
            validation_date: validationDate,
            data_source: 'synthetic_demo',
        });
        summary.disclaimer =
            '【測試／合成資料】僅供 UI 煙霧測試，不代表實盤或已驗證優勢。' +
            summary.disclaimer;
        summary.source_mode = 'synthetic';
        return summary;
    }
}
