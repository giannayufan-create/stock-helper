// server/src/outcome-summary-cli.ts
// npm run outcome:summary -- --from 2026-01-01 --to 2026-06-30 [--signal REBREAK]

import {
    formatAnalyticsTable,
    groupBySignalType,
    heatBuckets,
    JsonlSignalOutcomeRepository,
    openPassScoreBuckets,
    scoreBucketsC,
} from './lib/signal-outcome/index.ts';
import { JsonlStrategySignalRepository } from './lib/strategy-signal/index.ts';
import type { SignalType } from './lib/strategy-signal/types.ts';

function arg(name: string): string | undefined {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx < 0) return undefined;
    return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
    const from = arg('from') ?? '1970-01-01';
    const to = arg('to') ?? '9999-12-31';
    const signal = arg('signal') as SignalType | undefined;
    const mode = arg('mode') as 'live' | 'replay' | undefined;
    const highOnly = hasFlag('high-confidence');

    const signals = new JsonlStrategySignalRepository().listRange(from, to);
    const outcomes = new JsonlSignalOutcomeRepository().materializeRange(
        from,
        to,
    );

    const filter = {
        from,
        to,
        signal_type: signal,
        source_mode: mode,
        high_confidence_only: highOnly || undefined,
        learning_eligible: highOnly ? true : undefined,
    };

    const byType = groupBySignalType(signals, outcomes, filter);
    console.log('=== Signal Performance (NOT trading P&L) ===\n');
    console.log(formatAnalyticsTable(byType));
    console.log(
        `\nsignals=${signals.length} outcomes=${outcomes.length}` +
            (mode ? ` mode=${mode}` : '') +
            (highOnly ? ' high_confidence_only' : ''),
    );

    console.log('\n=== C Score buckets ===');
    for (const b of scoreBucketsC(signals, outcomes, filter)) {
        console.log(
            `${b.bucket} n=${b.count} +15mPos=${b.positive_15m_rate}% avg15=${b.avg_return_15m} MFE=${b.avg_MFE_15m} MAE=${b.avg_MAE_15m}`,
        );
    }

    console.log('\n=== Heat buckets ===');
    for (const b of heatBuckets(signals, outcomes, filter)) {
        console.log(
            `${b.bucket} n=${b.count} +15mPos=${b.positive_15m_rate}% MFE=${b.avg_MFE_15m} MAE=${b.avg_MAE_15m}`,
        );
    }

    console.log('\n=== OPEN_PASS score buckets ===');
    for (const b of openPassScoreBuckets(signals, outcomes, filter)) {
        console.log(
            `${b.bucket} n=${b.count} +15mPos=${b.positive_15m_rate}% MFE=${b.avg_MFE_15m} MAE=${b.avg_MAE_15m}`,
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
