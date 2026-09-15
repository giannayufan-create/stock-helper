// server/src/learning-tune-cli.ts
// npm run learning:tune -- --target open-gate --from 2026-01-01 --to 2026-06-30
// Writes experiment report only — NEVER modifies production yaml.

import {
    ExperimentRepository,
    armShadow,
    buildLearningDataset,
    buildRecommendation,
    loadLearningConfig,
    regimeAdjustmentSuggestions,
    shadowReadyForManualReview,
} from './lib/learning/index.ts';
import { JsonlSignalOutcomeRepository } from './lib/signal-outcome/index.ts';
import { JsonlStrategySignalRepository } from './lib/strategy-signal/index.ts';

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
    const target = (arg('target') ?? 'open-gate') as
        | 'open-gate'
        | 'intraday-rank';
    const arm = hasFlag('arm-shadow');

    const lcfg = loadLearningConfig();
    if (lcfg.promotion.auto_promote) {
        throw new Error('Refusing to run: auto_promote must be false');
    }

    const signals = new JsonlStrategySignalRepository().listRange(from, to);
    const outcomes = new JsonlSignalOutcomeRepository().materializeRange(
        from,
        to,
    );
    const { rows, report } = buildLearningDataset(signals, outcomes, {
        from,
        to,
    });

    console.log('=== Dataset ===');
    console.log(
        `eligible=${report.eligible_samples} excluded=${report.excluded_samples}`,
    );
    console.log(
        `dates=${report.date_coverage.from}..${report.date_coverage.to} days=${report.date_coverage.days}`,
    );
    console.log('signals:', report.signal_distribution);

    const exp = buildRecommendation(rows, target);
    const path = new ExperimentRepository().save(exp);

    console.log('\n=== Baseline ===');
    console.log(JSON.stringify(exp.baseline, null, 2));

    console.log('\n=== Candidate (NOT applied to production) ===');
    console.log(JSON.stringify(exp.candidate, null, 2));

    console.log('\n=== Walk-Forward ===');
    for (const f of exp.walk_forward) {
        console.log(
            `${f.fold_id} base_obj=${f.baseline.objective_score} cand_obj=${f.candidate.objective_score} Δ=${f.delta.objective} improved=${f.delta.improved}`,
        );
    }

    console.log('\n=== Holdout ===');
    console.log(JSON.stringify(exp.holdout, null, 2));

    console.log('\n=== Risk / Stability ===');
    console.log(
        `stability=${exp.stability_score} confidence=${exp.confidence}`,
    );
    console.log(
        `candidate MAE=${exp.candidate_metrics.avg_mae_15m} invalid_rate=${exp.candidate_metrics.invalid_rate}`,
    );

    console.log('\n=== Regime adjustments (suggestions only) ===');
    console.log(JSON.stringify(regimeAdjustmentSuggestions(rows), null, 2));

    console.log('\n=== Recommendation ===');
    console.log(`status=${exp.recommendation_status}`);
    console.log(`promotion=${exp.promotion_status}`);
    for (const r of exp.reasons) console.log(` - ${r}`);
    console.log(`\nexperiment saved: ${path}`);
    console.log(
        'Production open_gate_config.yaml / intraday_rank_config.yaml were NOT modified.',
    );

    if (arm) {
        if (exp.recommendation_status !== 'RECOMMEND') {
            console.log(
                '\n--arm-shadow ignored: recommendation_status is not RECOMMEND',
            );
        } else {
            const shadow = armShadow({
                candidate: exp.candidate,
                experiment_id: exp.experiment_id,
                enabled: true,
            });
            console.log('\nShadow armed (research only):', shadow);
            console.log(shadowReadyForManualReview(shadow));
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
