// server/src/lib/open-gate-v2/open-confirm-repository.ts
// Conditional JSONL append (not every 3s).

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpenGateConfig } from './config.ts';
import type { OpenConfirmLogRow, OpenConfirmResult } from './types.ts';

function dataRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', 'data', 'open-confirm-logs');
}

function taipeiYmd(iso?: string): string {
    const d = iso ? new Date(iso) : new Date();
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

export class OpenConfirmRepository {
    private root = dataRoot();
    private lastLogAt = new Map<string, number>();
    private lastLoggedScore = new Map<string, number>();

    constructor() {
        if (!existsSync(this.root)) {
            mkdirSync(this.root, { recursive: true });
        }
    }

    shouldLog(
        prev: OpenConfirmResult | null | undefined,
        next: OpenConfirmResult,
        cfg: OpenGateConfig,
    ): { yes: boolean; reason: string } {
        if (!prev) return { yes: true, reason: 'first_eval' };

        if (prev.open_confirm !== next.open_confirm) {
            if (
                next.open_confirm === 'pass' ||
                next.open_confirm === 'early_pass'
            ) {
                return { yes: true, reason: 'first_or_re_pass' };
            }
            if (
                prev.open_confirm === 'pass' ||
                prev.open_confirm === 'early_pass'
            ) {
                return { yes: true, reason: 'pass_invalidated' };
            }
            return { yes: true, reason: 'status_transition' };
        }

        if (prev.hard_reject !== next.hard_reject) {
            return { yes: true, reason: 'hard_reject_change' };
        }
        if (prev.soft_reject !== next.soft_reject) {
            return { yes: true, reason: 'soft_reject_change' };
        }
        if (prev.data_health !== next.data_health) {
            return { yes: true, reason: 'data_health_change' };
        }
        if (prev.data_blocked !== next.data_blocked) {
            return { yes: true, reason: 'data_blocked_change' };
        }

        const scoreDelta = Math.abs(
            next.final_open_score - prev.final_open_score,
        );
        if (scoreDelta >= cfg.logging.log_score_delta_threshold) {
            return { yes: true, reason: 'score_delta' };
        }

        if (
            prev.risk.chase_risk !== next.risk.chase_risk ||
            (prev.risk.invalid_price != null &&
                next.risk.invalid_price != null &&
                Math.abs(prev.risk.invalid_price - next.risk.invalid_price) /
                    Math.max(prev.risk.invalid_price, 1) >
                    0.005)
        ) {
            return { yes: true, reason: 'important_risk_change' };
        }

        const lastAt = this.lastLogAt.get(next.symbol) ?? 0;
        if (
            Date.now() - lastAt >=
            cfg.logging.log_heartbeat_sec * 1000
        ) {
            return { yes: true, reason: 'heartbeat' };
        }

        return { yes: false, reason: 'skip' };
    }

    toLogRow(
        r: OpenConfirmResult,
        priceAtSignal: number | null,
        log_reason: string,
    ): OpenConfirmLogRow {
        return {
            date: taipeiYmd(r.generated_at),
            timestamp: r.generated_at,
            evaluation_id: r.evaluation_id,
            signal_id: r.signal_id,
            symbol: r.symbol,
            a_score: r.a_score,
            a_score_source: r.a_score_source,
            phase: r.phase,
            raw_open_score: r.raw_open_score,
            final_open_score: r.final_open_score,
            rvol_same_time: r.metrics.rvol_same_time,
            vwap: r.metrics.vwap,
            vwap_pos_pct: r.metrics.vwap_pos_pct,
            vwap_source: r.metrics.vwap_source,
            vwap_valid: r.metrics.vwap_valid,
            open_pos_pct: r.metrics.open_pos_pct,
            high_pullback_pct: r.metrics.high_pullback_pct,
            momentum_score: r.metrics.momentum_score,
            market_score: r.market_score,
            market_adjustment: r.market_adjustment,
            liquidity_score: r.liquidity_score,
            liquidity_adjustment: r.liquidity_adjustment,
            risk_score: r.risk.risk_score,
            risk_adjustment: r.risk_adjustment,
            invalid_price: r.risk.invalid_price,
            invalid_reason: r.risk.invalid_reason,
            risk_distance_pct: r.risk.risk_distance_pct,
            chase_risk: r.risk.chase_risk,
            open_confirm: r.open_confirm,
            hard_reject: r.hard_reject,
            soft_reject: r.soft_reject,
            data_blocked: r.data_blocked,
            data_health: r.data_health,
            tradeable_candidate: r.tradeable_candidate,
            open_gate_passed_before_cutoff: r.open_gate_passed_before_cutoff,
            late_candidate: r.late_candidate,
            reasons_json: JSON.stringify(r.reasons),
            risks_json: JSON.stringify(r.risks),
            price_at_signal: priceAtSignal,
            log_reason,
            return_5m: null,
            return_15m: null,
            return_30m: null,
            return_60m: null,
            close_return: null,
            mfe: null,
            mae: null,
        };
    }

    append(row: OpenConfirmLogRow): void {
        try {
            if (!existsSync(this.root)) {
                mkdirSync(this.root, { recursive: true });
            }
            const file = join(this.root, `${row.date}.jsonl`);
            appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
            this.lastLogAt.set(row.symbol, Date.now());
            this.lastLoggedScore.set(row.symbol, row.final_open_score);
        } catch (err) {
            console.warn(
                'open-confirm log failed:',
                err instanceof Error ? err.message : err,
            );
        }
    }

    maybeAppend(
        prev: OpenConfirmResult | null | undefined,
        next: OpenConfirmResult,
        priceAtSignal: number | null,
        cfg: OpenGateConfig,
    ): boolean {
        const { yes, reason } = this.shouldLog(prev, next, cfg);
        if (!yes) return false;
        this.append(this.toLogRow(next, priceAtSignal, reason));
        return true;
    }
}
