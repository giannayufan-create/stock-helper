// server/src/lib/radar-rescue/recall.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FunnelTraceService } from './funnel-trace.ts';
import type {
    DailyRecallReport,
    DropReason,
    EodTruthRow,
    FalsePositiveCase,
    FunnelTraceRow,
    MissedWinnerCase,
} from './types.ts';

/** Focus slots that count as "shown in priority" for recall (matches widened UI). */
const FOCUS_RECALL_TOP_N = 12;

function ratio(hit: number, total: number): string {
    return `${hit} / ${total}`;
}

function wasUiVisible(f: FunnelTraceRow | null | undefined): boolean {
    return !!f && (f.ui_visible === true || f.first_ui_visible_at != null);
}

function wasEarly(f: FunnelTraceRow | null | undefined): boolean {
    return !!f && (f.early_trigger === true || f.early_trigger_at != null);
}

function wasActive(f: FunnelTraceRow | null | undefined): boolean {
    return (
        !!f &&
        (f.ever_active === true ||
            f.radar_state === 'ACTIVE' ||
            // legacy rows before ever_active existed
            (f.radar_state === 'WATCH' && f.early_trigger === true && f.ui_visible))
    );
}

function wasFocus(f: FunnelTraceRow | null | undefined): boolean {
    if (!f) return false;
    const rank = f.best_focus_rank ?? f.focus_rank;
    return rank != null && rank <= FOCUS_RECALL_TOP_N;
}

export function buildMissedWinners(
    truth: EodTruthRow[],
    funnel: FunnelTraceService,
    minPct = 5,
): MissedWinnerCase[] {
    const movers = truth.filter(
        (t) =>
            (t.data_status ?? 'ok') === 'ok' &&
            (t.max_return_pct ?? t.close_return_pct ?? 0) >= minPct,
    );
    const out: MissedWinnerCase[] = [];
    for (const t of movers) {
        const f = funnel.get(t.symbol);
        const ui = wasUiVisible(f);
        const early = wasEarly(f);
        const active = wasActive(f);
        const focus = wasFocus(f);
        const stages: Array<[string, boolean, DropReason]> = [
            ['A', !!f?.in_a, 'NOT_IN_A'],
            ['Scanner', !!f?.in_scanner, 'NOT_IN_SCANNER'],
            ['Discovery', !!f?.in_discovery, 'NOT_IN_DISCOVERY'],
            ['ActiveWatch', !!f?.in_active_watch, 'ACTIVE_WATCH_LIMIT'],
            ['C', !!f?.in_c, 'C_TOP30_LIMIT'],
            ['EARLY', early, 'NO_CURRENT_MOMENTUM'],
            ['ACTIVE', active, 'NO_CURRENT_MOMENTUM'],
            ['Focus', focus, 'FOCUS_NOT_SELECTED'],
            ['UI', ui, 'UI_FILTERED_LEGACY'],
        ];
        let firstStage = 'UNKNOWN';
        let firstReason: DropReason = 'UNKNOWN';
        for (const [name, ok, reason] of stages) {
            if (!ok) {
                firstStage = name;
                firstReason = f?.drop_reason ?? reason;
                break;
            }
        }
        if (ui) continue; // shown sometime today — not missed for UI recall
        out.push({
            symbol: t.symbol,
            name: f?.name ?? t.symbol,
            max_return_pct: t.max_return_pct ?? t.close_return_pct ?? 0,
            in_a: !!f?.in_a,
            in_scanner: !!f?.in_scanner,
            in_discovery: !!f?.in_discovery,
            in_active_watch: !!f?.in_active_watch,
            in_c: !!f?.in_c,
            early,
            active,
            focus,
            ui,
            first_drop_stage: firstStage,
            first_drop_reason: firstReason,
        });
    }
    return out.sort((a, b) => b.max_return_pct - a.max_return_pct);
}

export function buildDailyRecall(
    tradeDate: string,
    truth: EodTruthRow[],
    funnel: FunnelTraceService,
): DailyRecallReport {
    const plus3 = truth.filter(
        (t) =>
            (t.data_status ?? 'ok') === 'ok' &&
            (t.max_return_pct ?? t.close_return_pct ?? 0) >= 3,
    );
    const n = plus3.length;
    const count = (pred: (sym: string) => boolean) =>
        plus3.filter((t) => pred(t.symbol)).length;

    const scanner = count((s) => !!funnel.get(s)?.in_scanner);
    const discovery = count((s) => !!funnel.get(s)?.in_discovery);
    const active = count((s) => !!funnel.get(s)?.in_active_watch);
    const c = count((s) => !!funnel.get(s)?.in_c);
    const early = count((s) => wasEarly(funnel.get(s)));
    const activeState = count((s) => wasActive(funnel.get(s)));
    const focus = count((s) => wasFocus(funnel.get(s)));
    const ui = count((s) => wasUiVisible(funnel.get(s)));

    const stages = [
        ['Scanner', scanner],
        ['Discovery', discovery],
        ['Active', active],
        ['C', c],
        ['EARLY', early],
        ['ACTIVE', activeState],
        ['Focus', focus],
        ['UI', ui],
    ] as const;
    let largest = 'NONE';
    let worstLoss = -1;
    let prev = n;
    for (const [name, hit] of stages) {
        const loss = prev - hit;
        if (loss > worstLoss) {
            worstLoss = loss;
            largest = name;
        }
        prev = hit;
    }

    const missed = buildMissedWinners(truth, funnel, 5);
    return {
        trade_date: tradeDate,
        plus_3_count: n,
        scanner: ratio(scanner, n),
        discovery: ratio(discovery, n),
        active: ratio(active, n),
        c: ratio(c, n),
        early: ratio(early, n),
        active_state: ratio(activeState, n),
        focus: ratio(focus, n),
        ui: ratio(ui, n),
        largest_recall_loss_stage: largest,
        missed,
    };
}

export function persistRecall(
    dataDir: string,
    report: DailyRecallReport,
): void {
    const dir = join(dataDir, 'daily_recall');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, `${report.trade_date}.json`),
        JSON.stringify(report, null, 2),
        'utf8',
    );
    if (report.missed.length) {
        const md = join(dataDir, 'missed_winner_cases');
        mkdirSync(md, { recursive: true });
        writeFileSync(
            join(md, `${report.trade_date}.json`),
            JSON.stringify(report.missed, null, 2),
            'utf8',
        );
    }
}

export function persistFalsePositives(
    dataDir: string,
    ymd: string,
    cases: FalsePositiveCase[],
): void {
    if (!cases.length) return;
    const dir = join(dataDir, 'false_positive_cases');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ymd}.json`), JSON.stringify(cases, null, 2), 'utf8');
}
