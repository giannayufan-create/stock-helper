// server/src/routes/outcomes.ts — measured signal performance (read-only).

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import {
    groupBySignalType,
    heatBuckets,
    scoreBucketsC,
} from '../lib/signal-outcome/index.ts';

function taipeiYmd(offsetDays = 0): string {
    const d = new Date(Date.now() + offsetDays * 86_400_000);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

export function registerOutcomeRoutes(app: FastifyInstance, ctx: AppContext) {
    app.get('/api/v1/research/outcomes/summary', async (req, reply) => {
        const repos = ctx.researchRepos;
        if (!repos) {
            return reply.code(503).send({ error: 'research_repos_unavailable' });
        }
        const q = req.query as Record<string, string | undefined>;
        const to = q.to ?? taipeiYmd();
        const from = q.from ?? taipeiYmd(-30);

        const signals = repos.signals.listRange(from, to);
        const outcomes = repos.outcomes.materializeRange(from, to);

        const measured = outcomes.filter(
            (o) => o.status === 'complete' || o.status === 'partial',
        );

        return {
            window: { from, to },
            tracker: ctx.outcomeTracker?.getHealth() ?? null,
            coverage: {
                signals: signals.length,
                outcomes: outcomes.length,
                measured: measured.length,
                coverage_pct: signals.length
                    ? Math.round((outcomes.length / signals.length) * 100)
                    : 0,
            },
            by_signal_type: groupBySignalType(signals, outcomes),
            by_c_score: scoreBucketsC(signals, outcomes),
            by_heat: heatBuckets(signals, outcomes),
            note:
                '此為訊號後的市場路徑統計（forward return / MFE / MAE），' +
                '不是交易損益，也不含手續費與滑價。',
        };
    });

    app.get('/api/v1/research/outcomes/health', async () => {
        return (
            ctx.outcomeTracker?.getHealth() ?? {
                enabled: false,
                reason: 'tracker_not_wired',
            }
        );
    });
}
