// npm run shadow:daily -- [--date 2026-09-15]
// Daily Shadow summary for Production vs SHADOW_B / SHADOW_C / SHADOW_BC.
// Streams JSONL (never readFileSync whole multi-GB day files).

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

function todayTaipei(): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

function fmt(v: number | null | undefined): string {
    return v == null ? 'n/a' : String(v);
}

async function main(): Promise<void> {
    const date = arg('date') ?? todayTaipei();
    const cfg = loadShadowConfig();
    const repo = new JsonlShadowRepository();
    await repo.flush?.();
    const comparisons = await repo.listComparisonsAsync(date, date);
    const summaries = buildAllExperimentAnalytics(comparisons, [], {
        from: date,
        to: date,
        cfg,
    });

    console.log(`=== Shadow Daily Summary ${date} ===\n`);
    console.log(
        `enabled=${cfg.enabled} diffs_only=${cfg.record_diffs_only} session_only=${cfg.session_only} auto_promote=${cfg.promotion.auto_promote}`,
    );
    console.log(`comparisons_today=${comparisons.length}\n`);

    const byLabel = new Map(summaries.map((s) => [s.experiment_label, s]));
    const primary =
        byLabel.get('SHADOW_B') ?? summaries[0] ?? null;

    if (primary) {
        const regimes = new Set<string>();
        for (const r of primary.by_regime) regimes.add(r.regime);
        console.log('--- Production (same MarketRuntime) ---');
        console.log(
            `Eligible Signals=${primary.eligible_production_signal_count} (raw=${primary.production_signal_count})`,
        );
        console.log(
            `Coverage avg=${fmt(primary.avg_score_coverage_pct)}%`,
        );
        console.log(
            `Positive Rate +15m=${fmt(primary.groups.PRODUCTION_ONLY.positive_15m_rate ?? primary.groups.BOTH.positive_15m_rate)}%`,
        );
        console.log(
            `MFE15=${fmt(primary.groups.PRODUCTION_ONLY.avg_MFE_15m ?? primary.groups.BOTH.avg_MFE_15m)}` +
                ` MAE15=${fmt(primary.groups.PRODUCTION_ONLY.avg_MAE_15m ?? primary.groups.BOTH.avg_MAE_15m)}`,
        );
        console.log(
            `Invalid Rate=${fmt(primary.groups.PRODUCTION_ONLY.invalid_hit_rate ?? primary.groups.BOTH.invalid_hit_rate)}%`,
        );
        console.log(`Regime=${[...regimes].join(',') || 'n/a'}\n`);
    } else {
        console.log('--- Production ---\n(no comparisons today)\n');
    }

    for (const label of ['SHADOW_B', 'SHADOW_C', 'SHADOW_BC']) {
        const s =
            byLabel.get(label) ??
            summaries.find((x) => x.experiment_label === label);
        console.log(`--- ${label} ---`);
        if (!s) {
            console.log('(no data)\n');
            continue;
        }
        const promo = recommendPromotion(s, cfg);
        const shadowArm = s.groups.SHADOW_ONLY;
        const both = s.groups.BOTH;
        console.log(
            `Eligible Signals=${s.eligible_shadow_signal_count} (raw=${s.shadow_signal_count})`,
        );
        console.log(
            `Coverage avg=${fmt(s.avg_score_coverage_pct)} median=${fmt(s.median_score_coverage_pct)} low_conf=${s.low_confidence_signal_count}`,
        );
        console.log(
            `Positive Rate +5m=${fmt(both.positive_5m_rate ?? shadowArm.positive_5m_rate)}%` +
                ` +15m=${fmt(both.positive_15m_rate ?? shadowArm.positive_15m_rate)}%` +
                ` +30m=${fmt(both.positive_30m_rate ?? shadowArm.positive_30m_rate)}%`,
        );
        console.log(
            `MFE15=${fmt(both.avg_MFE_15m ?? shadowArm.avg_MFE_15m)}` +
                ` MAE15=${fmt(both.avg_MAE_15m ?? shadowArm.avg_MAE_15m)}`,
        );
        console.log(
            `Invalid Rate=${fmt(both.invalid_hit_rate ?? shadowArm.invalid_hit_rate)}%`,
        );
        console.log(
            `Signal Coverage Ratio=${fmt(s.signal_coverage_ratio)}`,
        );
        console.log(
            `BOTH=${s.groups.BOTH.signal_count} PROD_ONLY=${s.groups.PRODUCTION_ONLY.signal_count} SHADOW_ONLY=${s.groups.SHADOW_ONLY.signal_count}`,
        );
        console.log(
            `Regime=${s.by_regime.map((r) => r.regime).join(',') || 'n/a'}`,
        );
        console.log(
            `promotion_status=${promo.status} (auto_promote=false)`,
        );
        console.log('');
    }

    console.log(
        'NOTE: Research only — does not modify production or broker subscriptions.',
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
