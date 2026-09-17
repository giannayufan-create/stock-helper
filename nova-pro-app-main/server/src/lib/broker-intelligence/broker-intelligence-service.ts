// server/src/lib/broker-intelligence/broker-intelligence-service.ts
// Context only — NEVER mutates A/B/C. No fabricated branch rows.

import { scoreChips } from '../../ai/chips-signal.ts';
import type { IntradayRankService } from '../intraday-rank/service.ts';
import { getChipRow } from '../tw-chips.ts';
import { computeAlignment } from './alignment.ts';
import {
    UnavailableBrokerBranchProvider,
    PROVIDER_CAPABILITY_AUDIT,
    type BrokerBranchProvider,
} from './broker-provider.ts';
import { computeConcentration } from './branch/branch-concentration-engine.ts';
import { buildBranchHistory } from './branch/branch-history-engine.ts';
import {
    rankBuyBranches,
    rankSellBranches,
} from './branch/branch-ranking-engine.ts';
import {
    loadBrokerIntelligenceConfig,
    type BrokerIntelligenceConfig,
} from './config.ts';
import { estimateMainForce } from './main-force/main-force-engine.ts';
import { BrokerIntelligenceRepository } from './repository/broker-intelligence-repository.ts';
import type {
    BranchDayBundle,
    BranchHistoryReport,
    BrokerIntelligenceHealth,
    BrokerSymbolSummary,
    InstitutionalContext,
    RankingRow,
} from './types.ts';
import { BI_VERSION } from './types.ts';

function lookbackDates(n: number): { start: string; end: string } {
    const end = new Date();
    const start = new Date(end.getTime() - n * 86400000 * 1.6);
    const fmt = (d: Date) =>
        new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Taipei',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(d);
    return { start: fmt(start), end: fmt(end) };
}

export class BrokerIntelligenceService {
    readonly cfg: BrokerIntelligenceConfig;
    private provider: BrokerBranchProvider;
    private repo = new BrokerIntelligenceRepository();
    private dayCache = new Map<string, { at: number; bundle: BranchDayBundle }>();
    private summaryCache = new Map<
        string,
        { at: number; summary: BrokerSymbolSummary }
    >();

    constructor(
        private intradayRank: IntradayRankService,
        provider?: BrokerBranchProvider,
        cfg?: BrokerIntelligenceConfig,
    ) {
        this.cfg = cfg ?? loadBrokerIntelligenceConfig();
        this.provider = provider ?? new UnavailableBrokerBranchProvider();
    }

    getProvider(): BrokerBranchProvider {
        return this.provider;
    }

    /** Test/prod hook — never call with fabricated live data without a real provider. */
    setProvider(p: BrokerBranchProvider): void {
        this.provider = p;
        this.dayCache.clear();
        this.summaryCache.clear();
    }

    getHealth(): BrokerIntelligenceHealth {
        const cap = this.provider.capability();
        const available = cap.branch_trading;
        return {
            provider: this.provider.id,
            freshness: available ? 'EOD' : 'UNKNOWN',
            last_success_at: null,
            latest_trade_date: null,
            coverage_days: available ? null : 0,
            status: available ? 'PARTIAL' : 'UNAVAILABLE',
            error: available
                ? null
                : '尚未設定 FINMIND_KEY，無法載入券商分點',
            capability: cap,
            quota: this.provider.getQuota?.() ?? null,
        };
    }

    getCapabilityAudit() {
        return {
            version: BI_VERSION,
            wired_provider: this.provider.id,
            wired_capability: this.provider.capability(),
            market_providers: PROVIDER_CAPABILITY_AUDIT,
            note:
                '券商分點來自 FinMind（若已設 FINMIND_KEY）。' +
                'Fugle/Shioaji/TWSE/TPEx 沒有分點。Trade Aggression ≠ 分點身份。',
        };
    }

    async getBranches(symbol: string) {
        const code = symbol.trim();
        const bundle = await this.loadDay(code);
        const health = this.healthFromBundle(bundle);
        return {
            symbol: code,
            trade_date: bundle.trade_date || null,
            freshness: bundle.freshness,
            available: bundle.available,
            top_buy_branches: rankBuyBranches(bundle, 15),
            top_sell_branches: rankSellBranches(bundle, 15),
            summary: bundle.available
                ? `買超分點 ${rankBuyBranches(bundle, 15).length}／賣超 ${rankSellBranches(bundle, 15).length}`
                : '目前尚未接入券商分點資料來源',
            data_health: health,
            version: BI_VERSION,
            unavailable_reason: bundle.available ? null : bundle.error,
        };
    }

    async getHistory(symbol: string, days = 5): Promise<BranchHistoryReport> {
        const code = symbol.trim();
        const requested = [1, 3, 5, 10, 20].includes(days) ? days : 5;
        const { start, end } = lookbackDates(
            this.cfg.history.max_lookback_days,
        );
        const bundles = await this.provider.getBranchHistory(code, start, end);
        return buildBranchHistory(code, bundles, requested, this.cfg);
    }

    async getSummary(symbol: string): Promise<BrokerSymbolSummary> {
        const code = symbol.trim();
        const cached = this.summaryCache.get(code);
        if (
            cached &&
            Date.now() - cached.at < this.cfg.cache.eod_ttl_sec * 1000
        ) {
            return cached.summary;
        }

        const ranked = this.intradayRank.getSymbol(code);
        const bundle = await this.loadDay(code);
        const concentration = bundle.available
            ? computeConcentration(bundle, this.cfg)
            : null;
        const history_5d = bundle.available
            ? await this.getHistory(code, 5)
            : null;
        const main_force = estimateMainForce({
            concentration,
            history: history_5d,
            cfg: this.cfg,
        });
        const institutional = await this.loadInstitutional(code);
        const radar = ranked
            ? {
                  c_score: ranked.intraday_score,
                  stock_heat: ranked.heat_score,
                  state: ranked.state,
                  events: ranked.events ?? [],
              }
            : null;
        const { alignment, note } = computeAlignment({
            mainForce: main_force,
            cScore: radar?.c_score ?? null,
            state: radar?.state ?? null,
            events: radar?.events ?? [],
            stockHeat: radar?.stock_heat ?? null,
            cfg: this.cfg,
            branchAvailable: bundle.available,
        });

        const summary: BrokerSymbolSummary = {
            symbol: code,
            name: ranked?.name ?? null,
            trade_date: bundle.trade_date || null,
            freshness: bundle.freshness,
            branch_available: bundle.available,
            institutional,
            top_buy_branches: rankBuyBranches(bundle, 5),
            top_sell_branches: rankSellBranches(bundle, 5),
            concentration,
            history_5d,
            main_force,
            alignment,
            alignment_note: note,
            radar_context: radar,
            data_health: this.healthFromBundle(bundle),
            version: BI_VERSION,
            unavailable_reason: bundle.available ? null : bundle.error,
        };

        this.summaryCache.set(code, { at: Date.now(), summary });
        if (bundle.available) {
            this.repo.appendSummary({
                symbol: code,
                trade_date: bundle.trade_date,
                main_force: main_force.score,
                alignment,
                version: BI_VERSION,
            });
        }
        return summary;
    }

    async rankingConcentration(limit = 30): Promise<{
        available: boolean;
        items: RankingRow[];
        note: string;
    }> {
        if (!this.provider.capability().branch_trading) {
            return {
                available: false,
                items: [],
                note: '目前尚未接入券商分點資料來源，無法產生主力集中排行',
            };
        }
        const opened = await this.openedSummariesForRanking();
        const items = opened
            .filter((s) => s.branch_available)
            .map((s) => this.toRankingRow(s));
        items.sort(
            (a, b) => (b.main_force_score ?? 0) - (a.main_force_score ?? 0),
        );
        return {
            available: true,
            items: items
                .filter((x) => x.eligible_for_ranking)
                .slice(0, limit),
            note: this.rankingQuotaNote('主力集中度為分點集中推估，非真實身份'),
        };
    }

    async rankingPersistentBuy(limit = 30) {
        if (!this.provider.capability().branch_trading) {
            return {
                available: false,
                items: [] as RankingRow[],
                note: '目前尚未接入券商分點資料來源',
            };
        }
        const opened = await this.openedSummariesForRanking();
        const items = opened
            .filter((s) => s.branch_available && s.history_5d)
            .map((s) => this.toRankingRow(s));
        items.sort(
            (a, b) =>
                (b.consecutive_buy_days ?? 0) - (a.consecutive_buy_days ?? 0) ||
                (b.net_buy_5d ?? 0) - (a.net_buy_5d ?? 0),
        );
        return {
            available: true,
            items: items.slice(0, limit),
            note: this.rankingQuotaNote('連續買進依分點歷史推估'),
        };
    }

    async rankingAlignment(limit = 30) {
        if (!this.provider.capability().branch_trading) {
            return {
                available: false,
                items: [] as RankingRow[],
                note: '目前尚未接入券商分點資料來源；盤中動能仍可於雷達查看，但不與分點共振',
            };
        }
        const opened = await this.openedSummariesForRanking();
        const items = opened
            .filter((s) => s.alignment === 'BULLISH_ALIGNMENT')
            .map((s) => this.toRankingRow(s));
        items.sort((a, b) => (b.c_score ?? 0) - (a.c_score ?? 0));
        return {
            available: true,
            items: items.slice(0, limit),
            note: this.rankingQuotaNote('籌碼＋動能同向僅供觀察，非買進訊號'),
        };
    }

    /** Optional feature snapshot for future Outcome — point-in-time only. */
    brokerContextSnapshot(summary: BrokerSymbolSummary) {
        return {
            available: summary.branch_available,
            main_force_score: summary.main_force.score,
            top3_concentration: summary.concentration?.concentration_top3 ?? null,
            net_buy_5d: summary.history_5d?.insufficient
                ? null
                : summary.history_5d?.rows[0]?.net_volume ?? null,
            consecutive_buy_days: summary.history_5d?.insufficient
                ? null
                : summary.history_5d?.rows[0]?.consecutive_buy_days ?? null,
            freshness: summary.freshness,
            inferred: true as const,
        };
    }

    private rankingQuotaNote(base: string): string {
        return `${base}。免費 600 次/小時：排行只含已開過個股分點的快取，不會對雷達全市場打 FinMind`;
    }

    /**
     * Free-tier guard: never N+1 lastBatch through FinMind.
     * Ranking may only read summaryCache or provider.peekCached (already fetched).
     */
    private async openedSummariesForRanking(): Promise<BrokerSymbolSummary[]> {
        const ttlMs = this.cfg.cache.eod_ttl_sec * 1000;
        const codes = new Set<string>();
        for (const [code, cached] of this.summaryCache) {
            if (Date.now() - cached.at < ttlMs) codes.add(code);
        }
        const batch = this.intradayRank.getLastBatch();
        for (const it of batch?.items ?? []) {
            if (this.provider.peekCached?.(it.symbol)) codes.add(it.symbol);
        }
        const out: BrokerSymbolSummary[] = [];
        for (const code of codes) {
            const cached = this.summaryCache.get(code);
            if (cached && Date.now() - cached.at < ttlMs) {
                out.push(cached.summary);
                continue;
            }
            if (this.provider.peekCached?.(code)) {
                out.push(await this.getSummary(code));
            }
        }
        return out;
    }

    private toRankingRow(s: BrokerSymbolSummary): RankingRow {
        return {
            symbol: s.symbol,
            name: s.name,
            main_force_score: s.main_force.score,
            confidence: s.main_force.confidence,
            concentration_top3: s.concentration?.concentration_top3 ?? null,
            net_buy_5d: s.history_5d?.insufficient
                ? null
                : s.history_5d?.rows.reduce((a, r) => a + Math.max(0, r.net_volume), 0) ??
                  null,
            consecutive_buy_days: s.history_5d?.insufficient
                ? null
                : s.history_5d?.rows[0]?.consecutive_buy_days ?? null,
            c_score: s.radar_context?.c_score ?? null,
            stock_heat: s.radar_context?.stock_heat ?? null,
            state: s.radar_context?.state ?? null,
            events: s.radar_context?.events ?? [],
            alignment: s.alignment,
            eligible_for_ranking:
                s.concentration?.eligible_for_ranking === true &&
                s.main_force.confidence !== 'LOW',
            freshness: s.freshness,
        };
    }

    private async loadDay(symbol: string): Promise<BranchDayBundle> {
        const hit = this.dayCache.get(symbol);
        if (hit && Date.now() - hit.at < this.cfg.cache.eod_ttl_sec * 1000) {
            return hit.bundle;
        }
        const bundle = await this.provider.getBranchTrading(symbol);
        this.dayCache.set(symbol, { at: Date.now(), bundle });
        return bundle;
    }

    private healthFromBundle(bundle: BranchDayBundle): BrokerIntelligenceHealth {
        const cap = this.provider.capability();
        if (!bundle.available) {
            return {
                provider: this.provider.id,
                freshness: bundle.freshness,
                last_success_at: null,
                latest_trade_date: null,
                coverage_days: 0,
                status: 'UNAVAILABLE',
                error: bundle.error,
                capability: cap,
                quota: this.provider.getQuota?.() ?? null,
            };
        }
        return {
            provider: this.provider.id,
            freshness: bundle.freshness,
            last_success_at: new Date().toISOString(),
            latest_trade_date: bundle.trade_date || null,
            coverage_days: 1,
            status: 'HEALTHY',
            error: null,
            capability: cap,
            quota: this.provider.getQuota?.() ?? null,
        };
    }

    private async loadInstitutional(
        code: string,
    ): Promise<InstitutionalContext> {
        const note =
            '三大法人／融資為公開盤後資料（通常 T+1），與券商分點分開顯示；非盤中身份';
        try {
            const row = await getChipRow(code);
            if (!row) {
                return {
                    available: false,
                    freshness: 'UNKNOWN',
                    as_of: null,
                    foreign_net: null,
                    trust_net: null,
                    dealer_net: null,
                    inst_net: null,
                    label: null,
                    summary: null,
                    note,
                };
            }
            const scored = scoreChips(row);
            return {
                available: scored.available,
                freshness: 'T_PLUS_1',
                as_of: scored.asOf ?? null,
                foreign_net: scored.foreignNet,
                trust_net: scored.trustNet,
                dealer_net: scored.dealerNet,
                inst_net: scored.instNet,
                label: scored.label,
                summary: scored.summary
                    ? `近期法人籌碼背景：${scored.summary}`
                    : null,
                note,
            };
        } catch {
            return {
                available: false,
                freshness: 'UNKNOWN',
                as_of: null,
                foreign_net: null,
                trust_net: null,
                dealer_net: null,
                inst_net: null,
                label: null,
                summary: null,
                note,
            };
        }
    }
}
