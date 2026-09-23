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
            ever_active: false,
            best_focus_rank: null,
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
        // Sticky day facts — after-hours downgrade must not erase daytime recall.
        if (prev?.early_trigger || partial.early_trigger === true) {
            row.early_trigger = true;
        }
        if (prev?.in_active_watch || partial.in_active_watch === true) {
            row.in_active_watch = true;
        }
        if (prev?.in_c || partial.in_c === true) {
            row.in_c = true;
        }
        if (prev?.in_discovery || partial.in_discovery === true) {
            row.in_discovery = true;
        }
        if (prev?.in_scanner || partial.in_scanner === true) {
            row.in_scanner = true;
        }
        if (prev?.ui_visible || partial.ui_visible === true) {
            row.ui_visible = true;
        }
        if (
            partial.radar_state === 'ACTIVE' ||
            prev?.ever_active ||
            prev?.radar_state === 'ACTIVE'
        ) {
            row.ever_active = true;
        }
        const focusCand = [
            partial.focus_rank,
            prev?.focus_rank,
            prev?.best_focus_rank,
        ].filter((n): n is number => typeof n === 'number' && n > 0);
        if (focusCand.length) {
            row.best_focus_rank = Math.min(...focusCand);
            // Keep current focus_rank from partial if set; else retain best.
            if (partial.focus_rank == null && row.best_focus_rank != null) {
                row.focus_rank = row.best_focus_rank;
            }
        }
        if (
            partial.early_trigger === true &&
            !prev?.early_trigger_at &&
            !row.early_trigger_at
        ) {
            row.early_trigger_at = now;
        }
        if (
            (partial.ui_visible === true || row.ui_visible) &&
            !prev?.first_ui_visible_at &&
            !row.first_ui_visible_at
        ) {
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
                // Backfill sticky fields for older jsonl lines.
                row.ever_active = !!(
                    row.ever_active ||
                    row.radar_state === 'ACTIVE'
                );
                row.best_focus_rank =
                    row.best_focus_rank ?? row.focus_rank ?? null;
                if (row.first_ui_visible_at && !row.ui_visible) {
                    row.ui_visible = true;
                }
                this.bySymbol.set(row.symbol, row);
                n++;
            } catch {
                /* skip */
            }
        }
        return n;
    }
}
