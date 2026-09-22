// server/src/lib/radar-rescue/funnel-trace.ts

import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FunnelTraceRow, DropReason } from './types.ts';

function taipeiYmd(d = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

export class FunnelTraceService {
    private bySymbol = new Map<string, FunnelTraceRow>();
    private dirty = new Set<string>();

    constructor(private dataDir: string) {}

    get(symbol: string): FunnelTraceRow | null {
        return this.bySymbol.get(symbol) ?? null;
    }

    list(): FunnelTraceRow[] {
        return [...this.bySymbol.values()];
    }

    upsert(partial: Partial<FunnelTraceRow> & { symbol: string; name?: string }): FunnelTraceRow {
        const now = new Date().toISOString();
        const ymd = taipeiYmd();
        const prev = this.bySymbol.get(partial.symbol);
        const row: FunnelTraceRow = {
            trade_date: ymd,
            name: partial.name ?? prev?.name ?? partial.symbol,
            first_seen_at: prev?.first_seen_at ?? now,
            in_a: false,
            a_score: null,
            a_rank: null,
            in_scanner: false,
            scanner_sources: [],
            in_discovery: false,
            discovery_score: null,
            discovery_rank: null,
            trigger_score: null,
            lanes: [],
            in_active_watch: false,
            active_watch_rank: null,
            in_c: false,
            c_score: null,
            c_rank: null,
            c_state: null,
            bp_observed: false,
            bp_score: null,
            bp_state: null,
            bp_trend: null,
            radar_state: 'WATCH',
            radar_confidence: 'MEDIUM',
            early_trigger: false,
            early_trigger_at: null,
            opportunity_score: null,
            chase_risk: null,
            focus_score: null,
            focus_rank: null,
            ui_visible: false,
            first_ui_visible_at: null,
            news_state: 'NO_RELEVANT_NEWS',
            news_confidence: null,
            drop_stage: null,
            drop_reason: null,
            drop_score: null,
            drop_rank: null,
            drop_threshold: null,
            margin_to_threshold: null,
            ...prev,
            ...partial,
            symbol: partial.symbol,
            updated_at: now,
        };
        if (
            partial.early_trigger === true &&
            !prev?.early_trigger_at &&
            !row.early_trigger_at
        ) {
            row.early_trigger_at = now;
        }
        if (partial.ui_visible === true && !prev?.first_ui_visible_at) {
            row.first_ui_visible_at = now;
        }
        this.bySymbol.set(row.symbol, row);
        this.dirty.add(row.symbol);
        return row;
    }

    markDrop(
        symbol: string,
        stage: string,
        reason: DropReason,
        meta?: {
            score?: number | null;
            rank?: number | null;
            threshold?: number | null;
        },
    ): void {
        const row = this.bySymbol.get(symbol);
        if (!row) return;
        if (row.drop_stage) return; // first drop wins
        const score = meta?.score ?? null;
        const threshold = meta?.threshold ?? null;
        this.upsert({
            symbol,
            drop_stage: stage,
            drop_reason: reason,
            drop_score: score,
            drop_rank: meta?.rank ?? null,
            drop_threshold: threshold,
            margin_to_threshold:
                score != null && threshold != null ? score - threshold : null,
        });
    }

    /** Flush only dirty transition rows — never every 2s full dump. */
    flushTransitions(): number {
        if (!this.dirty.size) return 0;
        const dir = join(this.dataDir, 'radar_funnel_trace');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${taipeiYmd()}.jsonl`);
        let n = 0;
        for (const sym of this.dirty) {
            const row = this.bySymbol.get(sym);
            if (!row) continue;
            appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
            n++;
        }
        this.dirty.clear();
        return n;
    }

    loadToday(): number {
        const file = join(
            this.dataDir,
            'radar_funnel_trace',
            `${taipeiYmd()}.jsonl`,
        );
        if (!existsSync(file)) return 0;
        let n = 0;
        for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                const row = JSON.parse(line) as FunnelTraceRow;
                this.bySymbol.set(row.symbol, row);
                n++;
            } catch {
                /* skip */
            }
        }
        return n;
    }
}
