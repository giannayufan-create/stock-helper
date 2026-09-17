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

    const fromRank = (c: (typeof rankItems)[number]): TodayInputItem => {
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

    const fromOpenOrA = (symbol: string): TodayInputItem => {
        const og = openItems.get(symbol) ?? null;
        const a = aPool.get(symbol) ?? null;
        const q = runtimeQuote(ctx, symbol);
        return {
            ...emptyInput(symbol, a?.name ?? og?.name ?? symbol),
            last_price: q.last_price,
            change_pct: q.change_pct,
            open_confirm: og?.open_confirm ?? null,
            open_score: og?.final_open_score ?? null,
            tradeable_candidate: og?.tradeable_candidate ?? false,
            a_score: a?.a_score ?? og?.a_score ?? null,
            data_blocked: og?.data_blocked ?? false,
            chase_risk: og?.risk.chase_risk ?? null,
            vwap_pos_pct: og?.metrics.vwap_pos_pct ?? null,
            c_reasons: [
                ...(og?.reasons ?? []),
                ...(a?.sector ? [`族群：${a.sector}`] : []),
            ],
            c_risks: [
                ...(og?.risks ?? []),
                ...(a?.warning_status ? ['注意股'] : []),
                ...(a?.disposition_status ? ['處置股'] : []),
            ],
            score_coverage_pct: og?.score_coverage_pct ?? null,
        };
    };

    // After hours / preopen: never reuse a dead C batch (C=0, no last price)
    // as "today look at these". A-pool is tomorrow/open prep only.
    if (mode === 'PREOPEN' || mode === 'AFTER_HOURS') {
        return ctx.openGateV2.candidates
            .list()
            .slice()
            .sort((a, b) => (b.a_score ?? 0) - (a.a_score ?? 0))
            .slice(0, 20)
            .map((a) => fromAPoolPrep(a.symbol));
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
        const rankBy = new Map(rankItems.map((c) => [c.symbol, c]));
        const seen = new Set<string>();
        const out: TodayInputItem[] = [];
        const take = (symbol: string) => {
            if (seen.has(symbol)) return;
            seen.add(symbol);
            const c = rankBy.get(symbol);
            out.push(c ? fromRank(c) : fromOpenOrA(symbol));
        };
        const bList = [...openItems.values()].sort((a, b) => {
            const by = confirmOrder(a.open_confirm) - confirmOrder(b.open_confirm);
            if (by !== 0) return by;
            return (b.final_open_score ?? 0) - (a.final_open_score ?? 0);
        });
        for (const b of bList) take(b.symbol);
        for (const a of [...aPool.values()].sort(
            (x, y) => (y.a_score ?? 0) - (x.a_score ?? 0),
        )) {
            take(a.symbol);
        }
        for (const c of rankItems) take(c.symbol);
        return out.slice(0, 20);
    }

    return rankItems.map(fromRank);
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
