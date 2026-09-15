// npm run shadow:summary -- --from 2026-01-01 --to 2026-06-30
// Research-only. Never writes production yaml / never auto-promotes.

import {
    buildAllExperimentAnalytics,
    JsonlShadowRepository,
    loadShadowConfig,
    recommendPromotion,
} from './lib/shadow/index.ts';

function arg(name: string): string | undefined {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx < 0) return undefined;
    return process.argv[idx + 1];
}

function fmt(v: number | null | undefined): string {
    return v == null ? 'n/a' : String(v);
}

function main(): void {
    const from = arg('from') ?? '1970-01-01';
    const to = arg('to') ?? '9999-12-31';
    const cfg = loadShadowConfig();
    const repo = new JsonlShadowRepository();
    const comparisons = repo.listComparisons(from, to);
    const summaries = buildAllExperimentAnalytics(comparisons, [], {
        from,
        to,
        cfg,
    });

    console.log('=== Shadow Multi-Experiment Summary (research only) ===\n');
    console.log(`range=${from}..${to}`);
    console.log(`shadow.enabled=${cfg.enabled}`);
    console.log(`auto_promote=${cfg.promotion.auto_promote} (always false)`);
    console.log(
        `promotion_gate=AND days>=${cfg.min_shadow_days} AND eligible>=${cfg.min_shadow_signals}`,
    );
    console.log(
        `experiments=${cfg.experiments.map((e) => e.experiment_id).join(', ')}`,
    );
    console.log(`total_comparisons=${comparisons.length}\n`);

    if (!summaries.length) {
        console.log('No experiment data yet — Live Shadow accumulating.');
        console.log(
            '\nNOTE: Never writes open_gate_config.yaml / intraday_rank_config.yaml.',
        );
        return;
    }

    for (const summary of summaries) {
        const promo = recommendPromotion(summary, cfg);
        console.log(
            `---------- ${summary.experiment_label} (${summary.experiment_id}) ----------`,
        );
        console.log(
            `days=${summary.by_day.length} comparisons=${summary.comparison_count}`,
        );
        console.log(
            `prod_signals=${summary.production_signal_count} shadow_signals=${summary.shadow_signal_count}`,
        );
        console.log(
            `eligible_prod=${summary.eligible_production_signal_count} eligible_shadow=${summary.eligible_shadow_signal_count}`,
        );
        console.log(
            `signal_coverage_ratio=${fmt(summary.signal_coverage_ratio)}`,
        );
        console.log(
            `avg_score_coverage_pct=${fmt(summary.avg_score_coverage_pct)} median=${fmt(summary.median_score_coverage_pct)} low_conf=${summary.low_confidence_signal_count}`,
        );
        console.log(
            `stability=${summary.stability_score} days_improved=${fmt(summary.days_improved_ratio)} days_worsened=${fmt(summary.days_worsened_ratio)}`,
        );

        for (const g of ['BOTH', 'PRODUCTION_ONLY', 'SHADOW_ONLY'] as const) {
            const m = summary.groups[g];
            console.log(
                `  ${g}: n=${m.signal_count}` +
                    ` +5m=${fmt(m.positive_5m_rate)}%` +
                    ` +15m=${fmt(m.positive_15m_rate)}%` +
                    ` +30m=${fmt(m.positive_30m_rate)}%` +
                    ` avg15=${fmt(m.avg_forward_return_15m)}` +
                    ` med15=${fmt(m.median_forward_return_15m)}` +
                    ` MFE15=${fmt(m.avg_MFE_15m)}` +
                    ` MAE15=${fmt(m.avg_MAE_15m)}` +
                    ` invalid=${fmt(m.invalid_hit_rate)}%`,
            );
        }

        if (summary.by_signal_type.length) {
            console.log('  by_signal_type:');
            for (const t of summary.by_signal_type) {
                console.log(
                    `    ${t.signal_type}: prod=${t.production_signal_count} shadow=${t.shadow_signal_count}`,
                );
            }
        }

        console.log(
            `  promotion_status=${promo.status} auto_promote=${promo.auto_promote}`,
        );
        for (const r of promo.reasons.slice(0, 6)) {
            console.log(`    - ${r}`);
        }
        console.log('');
    }

    console.log(
        'NOTE: Never writes production config. AUTO_PROMOTE is forbidden.',
    );
}

main();
