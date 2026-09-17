// server/src/lib/today-decision/service.ts
// Assembles the Today board from existing layer outputs. Read-only.

import type { AppContext } from '../../context.ts';
import { buildTodayBoard } from './engine.ts';
import type {
    TodayDecisionBoard,
    TodayInputItem,
    TodayMode,
    TodayOvernightBrief,
} from './types.ts';

function taipeiMinutes(now: Date): number {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Taipei',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(now);
    const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return hh * 60 + mm;
}

export function resolveTodayMode(ctx: AppContext, now: Date): TodayMode {
    const session = ctx.sessionAutonomy?.getState() ?? null;
    const minutes = taipeiMinutes(now);
    switch (session) {
        case 'PREOPEN':
            return 'PREOPEN';
        case 'CLOSE_AUCTION':
            return 'CLOSING';
        case 'CASH_LIVE':
            // 09:00–09:30 is the Open Gate confirmation window.
            return minutes < 9 * 60 + 30 ? 'OPENING' : 'INTRADAY';
        case 'NIGHT_LIVE':
        case 'WEEKEND':
            return 'AFTER_HOURS';
        default:
            break;
    }
    if (minutes >= 8 * 60 + 30 && minutes < 9 * 60) return 'PREOPEN';
    if (minutes >= 9 * 60 && minutes < 9 * 60 + 30) return 'OPENING';
    if (minutes >= 9 * 60 + 30 && minutes < 13 * 60 + 25) return 'INTRADAY';
    if (minutes >= 13 * 60 + 25 && minutes < 13 * 60 + 30) return 'CLOSING';
    return 'AFTER_HOURS';
}

function buildOvernightBrief(ctx: AppContext): TodayOvernightBrief | null {
    const snap = ctx.sessionAutonomy?.getOvernightSnapshots().slice(-1)[0];
    if (!snap) return null;
    const wanted = ['nasdaq', 'sox', 'spx', 'vix'];
    const assets = snap.global_assets
        .filter((a) => wanted.includes(a.id) && a.available)
        .map((a) => ({ id: a.id, change_pct: a.change_pct }));
    return {
        available: true,
        session_date: snap.session_date,
        created_at: snap.created_at,
        us_overnight_bias: snap.us_overnight_bias,
        headline:
            snap.us_overnight_bias ??
            (assets.length
                ? '夜盤已擷取國際指數，但美股方向判讀不足'
                : '夜盤快照缺少國際指數資料'),
        assets,
    };
}

function emptyInput(symbol: string, name: string): TodayInputItem {
    return {
        symbol,
        name,
        last_price: null,
        change_pct: null,
        c_score: null,
        c_state: null,
        rank: null,
        rank_change: null,
        heat_score: null,
        chase_risk: null,
        vwap_pos_pct: null,
        rvol: null,
        breakout_type: null,
        pullback_state: null,
        events: [],
        c_reasons: [],
        c_risks: [],
        trap_flags: [],
        trap_penalty: 0,
        data_blocked: false,
        data_health: null,
        score_coverage_pct: null,
        bp_score: null,
        bp_state: null,
        bp_overheated: false,
        bp_stale: false,
        momentum_state: null,
        eligibility: null,
        focus_rank: null,
        rq_reasons: [],
        decision_status: null,
        decision_confirmed: [],
        decision_missing: [],
        decision_risks: [],
        decision_next: [],
        open_confirm: null,
        open_score: null,
        tradeable_candidate: false,
        a_score: null,
    };
}

function collectInputs(ctx: AppContext, mode: TodayMode): TodayInputItem[] {
    const bpItems = new Map(
        (ctx.buyPressure?.getLastBatch()?.items ?? []).map((i) => [i.symbol, i]),
    );
    const rqItems = new Map(
        (ctx.radarQuality?.getLastBatch()?.items ?? []).map((i) => [
            i.symbol,
            i,
        ]),
    );
    const dsItems = new Map(
        (ctx.decisionSummary?.getLastBatch()?.items ?? []).map((i) => [
            i.symbol,
            i,
        ]),
    );
    const openItems = new Map(
        (ctx.openGateV2.getLastBatch()?.items ?? []).map((r) => [r.symbol, r]),
    );

    const aPool = new Map(
        ctx.openGateV2.candidates.list().map((a) => [a.symbol, a]),
    );
    const rankItems = ctx.intradayRank.getLastBatch()?.items ?? [];

    // Pre-open / after-hours: no live C batch yet. Show the prepared A pool
    // so 08:30 is not a blank screen — Open Gate confirmation starts at 09:00.
    if (!rankItems.length && (mode === 'PREOPEN' || mode === 'AFTER_HOURS')) {
        return ctx.openGateV2.candidates
            .list()
            .slice()
            .sort((a, b) => (b.a_score ?? 0) - (a.a_score ?? 0))
            .slice(0, 20)
            .map((a) => {
                const og = openItems.get(a.symbol) ?? null;
                return {
                    ...emptyInput(a.symbol, a.name),
                    open_confirm: og?.open_confirm ?? null,
                    open_score: og?.final_open_score ?? null,
                    a_score: a.a_score,
                    c_reasons: a.sector ? [`族群：${a.sector}`] : [],
                    c_risks: [
                        ...(a.warning_status ? ['注意股'] : []),
                        ...(a.disposition_status ? ['處置股'] : []),
                    ],
                    trap_flags: [],
                    trap_penalty: 0,
                };
            });
    }

    return rankItems.map((c) => {
        const bp = bpItems.get(c.symbol) ?? null;
        const rq = rqItems.get(c.symbol) ?? null;
        const ds = dsItems.get(c.symbol) ?? null;
        const og = openItems.get(c.symbol) ?? null;
        const a = aPool.get(c.symbol) ?? null;
        return {
            symbol: c.symbol,
            name: c.name,
            last_price: c.last_price,
            change_pct: c.change_pct,
            c_score: c.intraday_score,
            c_state: c.state,
            rank: c.rank,
            rank_change: c.rank_change,
            heat_score: c.heat_score,
            chase_risk: c.risk.chase_risk,
            vwap_pos_pct: c.metrics.vwap_pos_pct,
            rvol: null,
            breakout_type: c.metrics.breakout_type,
            pullback_state: c.metrics.pullback_state,
            events: c.events,
            c_reasons: c.reasons,
            c_risks: [
                ...(c.risks ?? []),
                ...(a?.warning_status ? ['注意股'] : []),
                ...(a?.disposition_status ? ['處置股'] : []),
            ],
            trap_flags: c.risk.trap_flags ?? [],
            trap_penalty: c.risk.trap_penalty ?? 0,
            data_blocked: c.data_blocked,
            data_health: c.data_health,
            score_coverage_pct: c.score_coverage_pct ?? null,
            bp_score: bp?.buy_pressure_score ?? null,
            bp_state: bp?.primary_state ?? null,
            bp_overheated: bp?.overheated ?? false,
            bp_stale: bp?.data_stale ?? false,
            momentum_state: rq?.momentum_state ?? null,
            eligibility: rq?.eligibility ?? null,
            focus_rank: rq?.is_focus ? rq.focus_rank : null,
            rq_reasons: rq?.focus_reasons ?? [],
            decision_status: ds?.status ?? null,
            decision_confirmed: ds?.confirmed_reasons ?? [],
            decision_missing: ds?.missing_confirmations ?? [],
            decision_risks: ds?.risk_flags ?? [],
            decision_next: ds?.next_confirmations ?? [],
            open_confirm: og?.open_confirm ?? c.open_gate_status ?? null,
            open_score: og?.final_open_score ?? c.open_score ?? null,
            tradeable_candidate: og?.tradeable_candidate ?? false,
            a_score: c.a_score,
        };
    });
}

export function buildTodayDecision(
    ctx: AppContext,
    opts: { limit?: number; now?: Date } = {},
): TodayDecisionBoard {
    const now = opts.now ?? new Date();
    const mode = resolveTodayMode(ctx, now);
    const overview = ctx.marketContext?.getOverview() ?? null;

    return buildTodayBoard({
        now,
        mode,
        items: collectInputs(ctx, mode),
        taiwan_regime: overview?.taiwan_regime.state ?? null,
        market_breadth_advance_pct: overview?.breadth.advance_pct ?? null,
        overnight: buildOvernightBrief(ctx),
        limit: opts.limit,
    });
}
