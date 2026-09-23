// server/src/lib/today-decision/service.ts
// Assembles the Today board from existing layer outputs. Read-only.

import type { AppContext } from '../../context.ts';
import { summarizeUsOvernightBias } from '../session-autonomy/overnight-snapshot.ts';
import type { GlobalAssetQuote } from '../market-intelligence/types.ts';
import { buildTodayBoard } from './engine.ts';
import { getTxfNightQuote, refreshTxfNightQuote } from './txf-night-quote.ts';
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

const OVERNIGHT_ASSET_LABEL: Record<string, string> = {
    nasdaq: '那斯達克',
    sox: '費半',
    spx: '標普500',
    dow: '道瓊',
    vix: 'VIX',
    nq_fut: '那指期',
    es_fut: '標普期',
    nikkei: '日經',
    hsi: '恆生',
    txf_night: '台指夜盤',
    twf_cme: '海外台指期',
};

function runtimeChangePct(
    ctx: AppContext,
    codes: string[],
): number | null {
    for (const code of codes) {
        const st = ctx.marketRuntime.getState(code);
        if (!st || !(st.prev_close > 0) || !(st.last_price > 0)) continue;
        return ((st.last_price - st.prev_close) / st.prev_close) * 100;
    }
    return null;
}

function asQuotes(
    rows: Array<{
        id: string;
        name?: string;
        change_pct?: number | null;
        status?: string;
    }>,
): GlobalAssetQuote[] {
    return rows
        .filter(
            (a) =>
                a.change_pct != null &&
                Number.isFinite(a.change_pct) &&
                (a.status == null || a.status === 'HEALTHY'),
        )
        .map((a) => ({
            id: a.id,
            name: a.name ?? a.id,
            value: null,
            change: null,
            change_pct: a.change_pct ?? null,
            timestamp: null,
            source: 'cache',
            freshness: 'unknown',
            status: 'HEALTHY',
        }));
}

function buildOvernightBrief(ctx: AppContext): TodayOvernightBrief {
    const snap = ctx.sessionAutonomy?.getOvernightSnapshots().slice(-1)[0];
    const live = ctx.marketContext?.getGlobalAssets() ?? [];
    const mi = ctx.marketIntelligence?.getSnapshot()?.global_markets ?? [];
    const pool = live.length ? live : mi;
    const source: TodayOvernightBrief['source'] = live.length
        ? 'live'
        : snap
          ? 'snapshot'
          : pool.length
            ? 'live'
            : 'none';

    const byId = new Map<
        string,
        { id: string; name: string; change_pct: number | null }
    >();
    const ingest = (
        id: string,
        change_pct: number | null | undefined,
        name?: string,
    ) => {
        if (!OVERNIGHT_ASSET_LABEL[id]) return;
        if (change_pct == null || !Number.isFinite(change_pct)) return;
        if (byId.has(id)) return;
        byId.set(id, {
            id,
            name: OVERNIGHT_ASSET_LABEL[id] ?? name ?? id,
            change_pct,
        });
    };

    for (const a of pool) {
        ingest(a.id, a.change_pct, a.name);
    }
    if (snap) {
        for (const a of snap.global_assets) {
            if (a.available) ingest(a.id, a.change_pct);
        }
    }
    const txf =
        runtimeChangePct(ctx, ['TXFR1', 'TXF', 'TX']) ??
        getTxfNightQuote()?.pct ??
        null;
    if (txf != null) ingest('txf_night', txf);

    const assets = Object.keys(OVERNIGHT_ASSET_LABEL)
        .map((id) => byId.get(id))
        .filter((a): a is { id: string; name: string; change_pct: number | null } =>
            Boolean(a),
        );

    const cashIds = new Set(['nasdaq', 'sox', 'spx', 'dow']);
    const futIds = new Set(['nq_fut', 'es_fut', 'txf_night', 'twf_cme']);
    const cash = assets.filter((a) => cashIds.has(a.id));
    const fut = assets.filter((a) => futIds.has(a.id));
    const asia = assets.filter(
        (a) => a.id === 'nikkei' || a.id === 'hsi' || a.id === 'vix',
    );

    const fmt = (a: { name: string; change_pct: number | null }) =>
        `${a.name} ${a.change_pct != null && a.change_pct >= 0 ? '+' : ''}${a.change_pct?.toFixed(2)}%`;

    const bias =
        summarizeUsOvernightBias(asQuotes(cash.length ? cash : pool)) ??
        snap?.us_overnight_bias ??
        null;

    const parts: string[] = [];
    if (cash.length) parts.push(`美股現貨收盤：${cash.map(fmt).join('、')}`);
    if (fut.length) parts.push(`夜盤期貨：${fut.map(fmt).join('、')}`);
    if (asia.length) parts.push(asia.map(fmt).join('、'));
    const headline = parts.length
        ? parts.join('。')
        : (bias ?? '夜盤指數尚未就緒');

    return {
        available: assets.length > 0 || Boolean(bias),
        session_date: snap?.session_date ?? null,
        created_at: snap?.created_at ?? new Date().toISOString(),
        us_overnight_bias: bias,
        headline,
        source,
        assets,
    };
}

function runtimeQuote(
    ctx: AppContext,
    symbol: string,
): { last_price: number | null; change_pct: number | null } {
    const st = ctx.marketRuntime.getState(symbol);
    if (!st || !(st.last_price > 0)) {
        return { last_price: null, change_pct: null };
    }
    const prev = st.prev_close > 0 ? st.prev_close : null;
    return {
        last_price: st.last_price,
        change_pct:
            prev != null ? ((st.last_price - prev) / prev) * 100 : null,
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
        rescue_state: null,
        rescue_reasons: [],
        opportunity_score: null,
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
    const rankBy = new Map(rankItems.map((c) => [c.symbol, c]));

    const rescueBatch = ctx.radarRescue?.getLastBatch() ?? null;
    // Strongest card wins in Map (confirmed last so it overwrites).
    const rescueBy = new Map(
        [
            ...(rescueBatch?.watch ?? []),
            ...(rescueBatch?.early ?? []),
            ...(rescueBatch?.active ?? []),
            ...(rescueBatch?.focus.early ?? []),
            ...(rescueBatch?.focus.confirmed ?? []),
        ].map((c) => [c.symbol, c]),
    );
    const rescueFocusConfirmed = new Set(
        (rescueBatch?.focus.confirmed ?? []).map((c) => c.symbol),
    );

    /** Merge every layer for one symbol — same sources Radar uses. */
    const mergeSymbol = (symbol: string): TodayInputItem => {
        const c = rankBy.get(symbol) ?? null;
        const bp = bpItems.get(symbol) ?? null;
        const rq = rqItems.get(symbol) ?? null;
        const ds = dsItems.get(symbol) ?? null;
        const og = openItems.get(symbol) ?? null;
        const a = aPool.get(symbol) ?? null;
        const rescue = rescueBy.get(symbol) ?? null;
        const q = runtimeQuote(ctx, symbol);

        const focusEarly = new Set(
            (rescueBatch?.focus.early ?? []).map((x) => x.symbol),
        );
        const focusRank =
            rescueFocusConfirmed.has(symbol)
                ? 1
                : focusEarly.has(symbol)
                  ? 2
                  : rq?.is_focus
                    ? rq.focus_rank
                    : null;

        const name =
            c?.name ??
            rescue?.name ??
            rq?.name ??
            ds?.name ??
            og?.name ??
            a?.name ??
            symbol;

        return {
            symbol,
            name,
            last_price:
                c?.last_price ??
                rescue?.last_price ??
                q.last_price,
            change_pct:
                c?.change_pct ??
                rescue?.change_pct ??
                q.change_pct,
            c_score: c?.intraday_score ?? rescue?.c_score ?? null,
            c_state: c?.state ?? null,
            rank: c?.rank ?? rescue?.rank ?? null,
            rank_change: c?.rank_change ?? rescue?.rank_change ?? null,
            heat_score: c?.heat_score ?? null,
            chase_risk:
                rescue?.chase_risk ??
                c?.risk.chase_risk ??
                og?.risk.chase_risk ??
                null,
            vwap_pos_pct:
                c?.metrics.vwap_pos_pct ?? og?.metrics.vwap_pos_pct ?? null,
            rvol: null,
            breakout_type: c?.metrics.breakout_type ?? null,
            pullback_state: c?.metrics.pullback_state ?? null,
            events: c?.events ?? [],
            c_reasons: [
                ...(c?.reasons ?? []),
                ...(og?.reasons ?? []),
                ...(rescue?.reasons ?? []),
            ],
            c_risks: [
                ...(c?.risks ?? []),
                ...(og?.risks ?? []),
                ...(a?.warning_status ? ['注意股'] : []),
                ...(a?.disposition_status ? ['處置股'] : []),
            ],
            trap_flags: c?.risk.trap_flags ?? [],
            trap_penalty: c?.risk.trap_penalty ?? 0,
            data_blocked: c?.data_blocked ?? og?.data_blocked ?? false,
            data_health: c?.data_health ?? null,
            score_coverage_pct:
                c?.score_coverage_pct ?? og?.score_coverage_pct ?? null,
            bp_score: bp?.buy_pressure_score ?? rescue?.bp_score ?? null,
            bp_state: bp?.primary_state ?? null,
            bp_overheated: bp?.overheated ?? false,
            bp_stale: bp?.data_stale ?? false,
            momentum_state:
                rescue?.radar_state ?? rq?.momentum_state ?? null,
            eligibility: rq?.eligibility ?? null,
            focus_rank: focusRank,
            rq_reasons: [
                ...(rq?.focus_reasons ?? []),
                ...(rescue?.reasons ?? []),
            ],
            decision_status: ds?.status ?? null,
            decision_confirmed: ds?.confirmed_reasons ?? [],
            decision_missing: ds?.missing_confirmations ?? [],
            decision_risks: ds?.risk_flags ?? [],
            decision_next: ds?.next_confirmations ?? [],
            open_confirm: og?.open_confirm ?? c?.open_gate_status ?? null,
            open_score: og?.final_open_score ?? c?.open_score ?? null,
            tradeable_candidate: og?.tradeable_candidate ?? false,
            a_score: c?.a_score ?? a?.a_score ?? og?.a_score ?? null,
            rescue_state: rescue?.radar_state ?? null,
            rescue_reasons: rescue?.reasons ?? [],
            opportunity_score: rescue?.opportunity_score ?? null,
        };
    };

    const fromAPoolPrep = (symbol: string): TodayInputItem => {
        const a = aPool.get(symbol) ?? null;
        const q = runtimeQuote(ctx, symbol);
        const sector = (a?.sector ?? '').trim();
        const sectorWhy =
            sector && !/^\d+$/.test(sector) ? [`族群：${sector}`] : [];
        return {
            ...emptyInput(symbol, a?.name ?? symbol),
            last_price: q.last_price,
            change_pct: q.change_pct,
            a_score: a?.a_score ?? null,
            c_reasons: sectorWhy,
            c_risks: [
                ...(a?.warning_status ? ['注意股'] : []),
                ...(a?.disposition_status ? ['處置股'] : []),
            ],
        };
    };

    // After hours / preopen: A-pool prep + any rescue leftovers from session
    if (mode === 'PREOPEN' || mode === 'AFTER_HOURS') {
        const seen = new Set<string>();
        const out: TodayInputItem[] = [];
        for (const a of ctx.openGateV2.candidates
            .list()
            .slice()
            .sort((x, y) => (y.a_score ?? 0) - (x.a_score ?? 0))
            .slice(0, 20)) {
            seen.add(a.symbol);
            out.push(fromAPoolPrep(a.symbol));
        }
        for (const sym of rescueBy.keys()) {
            if (seen.has(sym)) continue;
            seen.add(sym);
            out.push(mergeSymbol(sym));
        }
        return out.slice(0, 24);
    }

    // Opening: B already evaluates A-pool every 3s. Don't wait for C.
    if (mode === 'OPENING') {
        const confirmOrder = (s: string | null | undefined) => {
            switch ((s ?? '').toLowerCase()) {
                case 'pass':
                    return 0;
                case 'early_pass':
                    return 1;
                case 'watch':
                    return 2;
                case 'provisional':
                    return 3;
                case 'reject':
                    return 4;
                default:
                    return 5;
            }
        };
        const seen = new Set<string>();
        const out: TodayInputItem[] = [];
        const take = (symbol: string) => {
            if (seen.has(symbol)) return;
            seen.add(symbol);
            out.push(mergeSymbol(symbol));
        };
        const bList = [...openItems.values()].sort((a, b) => {
            const by = confirmOrder(a.open_confirm) - confirmOrder(b.open_confirm);
            if (by !== 0) return by;
            return (b.final_open_score ?? 0) - (a.final_open_score ?? 0);
        });
        for (const b of bList) take(b.symbol);
        // Rescue / DS / RQ that already look live — don't wait only on A order
        for (const ds of dsItems.values()) {
            if (ds.status === 'CONFIRMED_STRENGTH') take(ds.symbol);
        }
        for (const sym of rescueFocusConfirmed) take(sym);
        for (const a of [...aPool.values()].sort(
            (x, y) => (y.a_score ?? 0) - (x.a_score ?? 0),
        )) {
            take(a.symbol);
        }
        for (const c of rankItems) take(c.symbol);
        for (const sym of rescueBy.keys()) take(sym);
        return out.slice(0, 24);
    }

    // Intraday / closing: same order Radar would surface as “可進”
    // 1) Decision Summary CONFIRMED_STRENGTH
    // 2) Rescue focus confirmed / ACTIVE
    // 3) RQ focus
    // 4) Rest of C rank + other rescue lanes
    const seen = new Set<string>();
    const out: TodayInputItem[] = [];
    const take = (symbol: string) => {
        if (seen.has(symbol)) return;
        seen.add(symbol);
        out.push(mergeSymbol(symbol));
    };

    for (const ds of [...dsItems.values()].sort((a, b) => {
        const rank = (s: string) =>
            s === 'CONFIRMED_STRENGTH' ? 0 : s === 'WATCH' ? 1 : 2;
        return rank(a.status) - rank(b.status);
    })) {
        if (
            ds.status === 'CONFIRMED_STRENGTH' ||
            ds.status === 'WATCH'
        ) {
            take(ds.symbol);
        }
    }
    for (const c of rescueBatch?.focus.confirmed ?? []) take(c.symbol);
    for (const c of [...(rescueBatch?.active ?? [])].sort(
        (a, b) =>
            b.opportunity_score - a.opportunity_score ||
            (b.change_pct ?? 0) - (a.change_pct ?? 0),
    )) {
        take(c.symbol);
    }
    for (const c of rescueBatch?.focus.early ?? []) take(c.symbol);
    for (const c of [...(rescueBatch?.early ?? [])].sort(
        (a, b) => b.trigger_score - a.trigger_score,
    )) {
        take(c.symbol);
    }
    // Board movers / +1.5% watch — C top-30 missed but still show on Today.
    for (const c of [...(rescueBatch?.watch ?? []), ...(rescueBatch?.active ?? [])]
        .filter(
            (x) => (x.change_pct ?? 0) >= 1.5 || (x.c_score ?? 0) >= 65,
        )
        .sort(
            (a, b) =>
                (b.change_pct ?? 0) - (a.change_pct ?? 0) ||
                b.opportunity_score - a.opportunity_score,
        )) {
        take(c.symbol);
    }
    for (const rq of rqItems.values()) {
        if (rq.is_focus) take(rq.symbol);
    }
    for (const c of rankItems) take(c.symbol);
    for (const sym of rescueBy.keys()) take(sym);

    return out;
}

export function buildTodayDecision(
    ctx: AppContext,
    opts: { limit?: number; now?: Date } = {},
): TodayDecisionBoard {
    const now = opts.now ?? new Date();
    const mode = resolveTodayMode(ctx, now);
    const overview = ctx.marketContext?.getOverview() ?? null;
    if (mode === 'AFTER_HOURS' || mode === 'PREOPEN') {
        void refreshTxfNightQuote(ctx.market);
    }

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
