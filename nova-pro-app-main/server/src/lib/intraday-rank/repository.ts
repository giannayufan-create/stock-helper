// server/src/lib/intraday-rank/repository.ts

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IntradayRankConfig } from './config.ts';
import type { IntradayEvent, IntradayRankItem } from './types.ts';

function root(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', 'data', 'intraday-rank-logs');
}

function ymd(): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

export class IntradayRankRepository {
    private dir = root();
    private lastLogAt = new Map<string, number>();

    constructor() {
        if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    }

    maybeLogRank(
        prev: IntradayRankItem | null,
        next: IntradayRankItem,
        cfg: IntradayRankConfig,
    ): void {
        let reason = '';
        if (!prev) reason = 'first';
        else if (prev.state !== next.state) reason = 'state_change';
        else if (
            Math.abs(prev.intraday_score - next.intraday_score) >=
            cfg.score_log_delta
        ) {
            reason = 'score_delta';
        } else if (
            prev.rank != null &&
            next.rank != null &&
            Math.abs(prev.rank - next.rank) >= 5
        ) {
            reason = 'rank_change';
        } else if (next.events.length) reason = 'events';
        else {
            const last = this.lastLogAt.get(next.symbol) ?? 0;
            if (Date.now() - last >= cfg.heartbeat_sec * 1000) {
                reason = 'heartbeat';
            }
        }
        if (!reason) return;
        try {
            const file = join(this.dir, `rank-${ymd()}.jsonl`);
            appendFileSync(
                file,
                `${JSON.stringify({
                    log_reason: reason,
                    timestamp: next.updated_at,
                    symbol: next.symbol,
                    candidate_origin: next.candidate_origin,
                    intraday_score: next.intraday_score,
                    heat_score: next.heat_score,
                    rank: next.rank,
                    rank_change: next.rank_change,
                    state: next.state,
                    signal_id: next.signal_id,
                    evaluation_id: next.evaluation_id,
                    metrics: next.metrics,
                    risk: next.risk,
                    events: next.events,
                    // outcome hooks (fill later)
                    forward_returns: null,
                    mfe: null,
                    mae: null,
                })}\n`,
                'utf8',
            );
            this.lastLogAt.set(next.symbol, Date.now());
        } catch (err) {
            console.warn(
                'intraday-rank log failed:',
                err instanceof Error ? err.message : err,
            );
        }
    }

    logEvent(ev: IntradayEvent): void {
        try {
            const file = join(this.dir, `events-${ymd()}.jsonl`);
            appendFileSync(file, `${JSON.stringify(ev)}\n`, 'utf8');
        } catch {
            /* ignore */
        }
    }
}
