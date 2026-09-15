// server/src/learning-analyze-cli.ts
// npm run learning:analyze -- --from 2026-01-01 --to 2026-06-30 [--signal REBREAK]

import {
    buildLearningDataset,
    formatBucketTable,
    loadLearningConfig,
    runFeatureAnalysis,
} from './lib/learning/index.ts';
import { JsonlSignalOutcomeRepository } from './lib/signal-outcome/index.ts';
import { JsonlStrategySignalRepository } from './lib/strategy-signal/index.ts';

function arg(name: string): string | undefined {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx < 0) return undefined;
    return process.argv[idx + 1];
}

async function main(): Promise<void> {
    const from = arg('from') ?? '1970-01-01';
    const to = arg('to') ?? '9999-12-31';
    const signal = arg('signal');
    const mode = arg('mode') as 'live' | 'replay' | undefined;

    loadLearningConfig();

    const signals = new JsonlStrategySignalRepository()
        .listRange(from, to)
        .filter((s) => (mode ? s.source_mode === mode : true));
    const outcomes = new JsonlSignalOutcomeRepository().materializeRange(
        from,
        to,
    );

    const { rows, report } = buildLearningDataset(signals, outcomes, {
        from,
        to,
    });
    const analysis = runFeatureAnalysis(rows, { signal });

    console.log('=== Learning Dataset (eligible only) ===');
    console.log(JSON.stringify(report, null, 2));

    console.log('\n=== Signal Types ===');
    for (const s of analysis.signal_types) {
        console.log(
            `${s.signal_type.padEnd(16)} n=${String(s.count).padStart(5)} +15m=${String(s.positive_15m_rate ?? '-').padStart(6)} MFE=${String(s.avg_MFE_15m ?? '-').padStart(6)} MAE=${String(s.avg_MAE_15m ?? '-').padStart(6)} ${s.tag ?? ''} conf=${s.confidence}`,
        );
    }

    console.log('\n=== RVOL buckets ===');
    console.log(formatBucketTable(analysis.rvol));
    console.log('\n=== VWAP position ===');
    console.log(formatBucketTable(analysis.vwap_pos));
    console.log('\n=== Heat ===');
    console.log(formatBucketTable(analysis.heat));
    console.log('\n=== Open score ===');
    console.log(formatBucketTable(analysis.open_score));
    console.log('\n=== Intraday score ===');
    console.log(formatBucketTable(analysis.intraday_score));
    console.log('\n=== Momentum deciles ===');
    console.log(formatBucketTable(analysis.momentum_deciles));
    console.log('\n=== Chase risk ===');
    console.log(formatBucketTable(analysis.chase_risk));
    console.log('\n=== Rank velocity deciles ===');
    console.log(formatBucketTable(analysis.rank_velocity_deciles));
    console.log('\n=== Time of day ===');
    console.log(formatBucketTable(analysis.time_of_day));

    console.log('\n=== Regimes ===');
    for (const r of analysis.regimes) {
        console.log(`\n[${r.regime}]`);
        for (const s of r.stats) {
            console.log(
                `  ${s.signal_type} n=${s.count} +15m=${s.positive_15m_rate}%`,
            );
        }
    }

    console.log('\n=== Combinations (min_combo_sample guarded) ===');
    console.log(formatBucketTable(analysis.combinations));

    console.log('\n=== Feature findings ===');
    const pos = analysis.findings.filter((f) => f.polarity === 'positive');
    const neg = analysis.findings.filter((f) => f.polarity === 'negative');
    const non = analysis.findings.filter(
        (f) => f.polarity === 'non_informative',
    );
    console.log('Top positive:', pos.map((f) => f.feature).join(', ') || '-');
    console.log('Top negative:', neg.map((f) => f.feature).join(', ') || '-');
    console.log(
        'Non-informative:',
        non.map((f) => f.feature).join(', ') || '-',
    );
    for (const f of analysis.findings) {
        console.log(
            `  [${f.polarity}] ${f.feature}: ${f.reason} (${f.confidence})`,
        );
    }

    console.log(
        `\nNOTE: positive_rate / MFE / MAE are signal-path market stats — NOT trading P&L.`,
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
