// npm run board-attack:backtest -- --from 2026-09-01 --to 2026-09-12 --top 20
// Optional: --sweep  (single-feature ranking comparison)
// Never mutates A/B/C. Uses FinMind TaiwanStockPrice (+ local cache).

import {
    runBoardAttackBacktest,
    sweepSingleFeatures,
    type ScoreFeatureKey,
} from './lib/board-attack/index.ts';

function arg(name: string): string | undefined {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx < 0) return undefined;
    return process.argv[idx + 1];
}

function hasFlag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

function fmt(v: number | null | undefined): string {
    if (v == null) return 'n/a';
    return (v * 100).toFixed(1) + '%';
}

async function main(): Promise<void> {
    const from = arg('from');
    const to = arg('to');
    if (!from || !to) {
        console.error(
            'Usage: npm run board-attack:backtest -- --from YYYY-MM-DD --to YYYY-MM-DD [--top 20] [--sweep] [--feature gap_pct]',
        );
        process.exit(1);
    }
    const topN = Number(arg('top') ?? 20);
    const feature = arg('feature') as ScoreFeatureKey | undefined;

    if (hasFlag('sweep')) {
        console.log(`=== BoardAttack feature sweep ${from} → ${to} top=${topN} ===\n`);
        const rows = await sweepSingleFeatures({ from, to, topN });
        console.log('feature\tdays\trecall\tprecision');
        for (const r of rows) {
            console.log(
                `${r.feature}\t${r.days}\t${fmt(r.mean_recall)}\t${fmt(r.mean_precision)}`,
            );
        }
        console.log(
            '\nNOTE: Research only. Weights are not production parameters.',
        );
        return;
    }

    const summary = await runBoardAttackBacktest({
        from,
        to,
        topN,
        mode: feature ? 'single_feature' : 'equal_weight',
        feature,
    });

    console.log(
        `=== BoardAttack backtest ${summary.from} → ${summary.to} ===`,
    );
    console.log(
        `mode=${summary.mode}${summary.feature ? ` feature=${summary.feature}` : ''} top_n=${summary.top_n}`,
    );
    console.log(
        `days=${summary.days.length} limit_ups=${summary.total_limit_ups} hits_in_top=${summary.total_hits}`,
    );
    console.log(
        `mean_recall=${fmt(summary.mean_recall)} mean_precision=${fmt(summary.mean_precision)}\n`,
    );

    console.log('date\tlu\thit\trecall\tprecision\tavg_gap_hits');
    for (const d of summary.days) {
        console.log(
            `${d.date}\t${d.limit_up_count}\t${d.hit_in_top_n}\t${fmt(d.recall)}\t${fmt(d.precision)}\t${d.avg_gap_pct_hits?.toFixed(2) ?? 'n/a'}`,
        );
    }

    console.log('\n--- notes ---');
    for (const n of summary.notes) console.log(`- ${n}`);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
