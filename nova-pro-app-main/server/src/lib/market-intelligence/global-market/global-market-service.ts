// server/src/lib/market-intelligence/global-market/global-market-service.ts
// Reuses shared yahoo-chart + us-indices. Never invents missing values.

import { fetchUsIndices, scoreUsOvernightBias } from '../../us-indices.ts';
import { fetchYahooChartMeta } from '../../yahoo-chart.ts';
import type {
    ContextStrength,
    GlobalAssetQuote,
    MarketContextBlock,
    MiAssetStatus,
    RiskEnvironment,
} from '../types.ts';
import type { GlobalAssetSpec } from './global-market-types.ts';

export const GLOBAL_ASSET_SPECS: GlobalAssetSpec[] = [
    { id: 'spx', name: 'S&P 500', yahoo: '^GSPC', group: 'us' },
    { id: 'nasdaq', name: 'NASDAQ', yahoo: '^IXIC', group: 'us' },
    { id: 'dow', name: 'Dow Jones', yahoo: '^DJI', group: 'us' },
    { id: 'sox', name: 'SOX', yahoo: '^SOX', group: 'us' },
    { id: 'taiex', name: 'TAIEX', yahoo: '^TWII', group: 'taiwan' },
    { id: 'tpex', name: 'TPEx', yahoo: '^TWOII', group: 'taiwan' },
    { id: 'vix', name: 'VIX', yahoo: '^VIX', group: 'vol' },
    { id: 'us10y', name: 'US 10Y', yahoo: '^TNX', group: 'rates' },
    { id: 'dxy', name: 'DXY', yahoo: 'DX-Y.NYB', group: 'fx' },
    { id: 'usdtwd', name: 'USD/TWD', yahoo: 'TWD=X', group: 'fx' },
    { id: 'nikkei', name: 'Nikkei', yahoo: '^N225', group: 'asia' },
    { id: 'kospi', name: 'KOSPI', yahoo: '^KS11', group: 'asia' },
    { id: 'hsi', name: 'Hang Seng', yahoo: '^HSI', group: 'asia' },
    { id: 'shanghai', name: 'Shanghai', yahoo: '000001.SS', group: 'asia' },
    { id: 'csi300', name: 'CSI 300', yahoo: '000300.SS', group: 'asia' },
    { id: 'gold', name: 'Gold', yahoo: 'GC=F', group: 'commodity' },
    { id: 'wti', name: 'WTI', yahoo: 'CL=F', group: 'commodity' },
    { id: 'copper', name: 'Copper', yahoo: 'HG=F', group: 'commodity' },
];

function unavailable(spec: GlobalAssetSpec, status: MiAssetStatus = 'UNAVAILABLE'): GlobalAssetQuote {
    return {
        id: spec.id,
        name: spec.name,
        value: null,
        change: null,
        change_pct: null,
        timestamp: null,
        source: 'yahoo',
        freshness: 'unknown',
        status,
        yahoo_symbol: spec.yahoo,
    };
}

function strengthFromChg(chg: number | null | undefined): ContextStrength {
    if (chg == null || !Number.isFinite(chg)) return '未知';
    if (chg >= 1.2) return '強';
    if (chg >= 0.4) return '偏強';
    if (chg <= -1.2) return '弱';
    if (chg <= -0.4) return '偏弱';
    return '中性';
}

export class GlobalMarketService {
    private cache: {
        at: number;
        assets: GlobalAssetQuote[];
        context: MarketContextBlock;
    } | null = null;
    private lastError: string | null = null;

    getLastError(): string | null {
        return this.lastError;
    }

    getCached(): {
        assets: GlobalAssetQuote[];
        context: MarketContextBlock;
        at: number;
    } | null {
        if (!this.cache) return null;
        return {
            assets: this.cache.assets,
            context: this.cache.context,
            at: this.cache.at,
        };
    }

    async refresh(force = false): Promise<{
        assets: GlobalAssetQuote[];
        context: MarketContextBlock;
    }> {
        if (!force && this.cache && Date.now() - this.cache.at < 55_000) {
            return { assets: this.cache.assets, context: this.cache.context };
        }

        const assets: GlobalAssetQuote[] = [];
        try {
            // Prefer shared US path for core four, then fill rest
            const us = await fetchUsIndices().catch(() => []);
            const usMap = new Map(us.map((q) => [q.symbol, q]));

            await Promise.all(
                GLOBAL_ASSET_SPECS.map(async (spec) => {
                    const fromUs = usMap.get(spec.yahoo);
                    if (fromUs) {
                        assets.push({
                            id: spec.id,
                            name: spec.name,
                            value: fromUs.close,
                            change: null,
                            change_pct: fromUs.changeRate,
                            timestamp: fromUs.asOf,
                            source: 'yahoo',
                            freshness: 'unknown',
                            status: 'HEALTHY',
                            yahoo_symbol: spec.yahoo,
                        });
                        return;
                    }
                    const meta = await fetchYahooChartMeta(spec.yahoo);
                    if (!meta) {
                        assets.push(unavailable(spec));
                        return;
                    }
                    assets.push({
                        id: spec.id,
                        name: spec.name,
                        value: meta.price,
                        change: meta.change,
                        change_pct: meta.changePct,
                        timestamp:
                            meta.marketTime != null
                                ? new Date(meta.marketTime * 1000).toISOString()
                                : null,
                        source: 'yahoo',
                        freshness: 'unknown',
                        status: 'HEALTHY',
                        yahoo_symbol: spec.yahoo,
                    });
                }),
            );

            // Stable order by spec
            const byId = new Map(assets.map((a) => [a.id, a]));
            const ordered = GLOBAL_ASSET_SPECS.map(
                (s) => byId.get(s.id) ?? unavailable(s),
            );

            const context = this.buildContext(ordered, us);
            this.cache = { at: Date.now(), assets: ordered, context };
            this.lastError = null;
            return { assets: ordered, context };
        } catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            if (this.cache) {
                return { assets: this.cache.assets, context: this.cache.context };
            }
            const empty = GLOBAL_ASSET_SPECS.map((s) => unavailable(s, 'ERROR'));
            const context: MarketContextBlock = {
                risk_environment: 'UNKNOWN',
                market_regime: null,
                market_score: null,
                semiconductor_context: '未知',
                tech_context: '未知',
                asia_context: '未知',
                fx_context: '未知',
                summary: `全球市場資料暫不可用：${this.lastError}`,
            };
            return { assets: empty, context };
        }
    }

    private buildContext(
        assets: GlobalAssetQuote[],
        usQuotes: Awaited<ReturnType<typeof fetchUsIndices>>,
    ): MarketContextBlock {
        const get = (id: string) =>
            assets.find((a) => a.id === id && a.status === 'HEALTHY') ?? null;
        const pct = (id: string) => get(id)?.change_pct ?? null;

        const nasdaq = pct('nasdaq');
        const sox = pct('sox');
        const vix = pct('vix');
        const vixLevel = get('vix')?.value ?? null;
        const asiaAvg = avgAvailable([
            pct('nikkei'),
            pct('kospi'),
            pct('hsi'),
            pct('shanghai'),
            pct('csi300'),
        ]);
        const fx = pct('usdtwd');

        const usBias = scoreUsOvernightBias(usQuotes);
        let risk: RiskEnvironment = 'UNKNOWN';
        if (usQuotes.length || nasdaq != null || sox != null) {
            const tech = avgAvailable([nasdaq, sox]);
            if (
                (tech != null && tech >= 0.7 && (vixLevel == null || vixLevel < 25)) ||
                usBias.scoreAdj >= 3
            ) {
                risk = 'RISK_ON';
            } else if (
                (tech != null && tech <= -0.7) ||
                (vixLevel != null && vixLevel >= 28) ||
                usBias.scoreAdj <= -3
            ) {
                risk = 'RISK_OFF';
            } else if (tech != null || vix != null || usQuotes.length) {
                risk = 'NEUTRAL';
            }
        }

        const bits: string[] = [];
        if (nasdaq != null) bits.push(`那斯達克 ${fmt(nasdaq)}`);
        if (sox != null) bits.push(`費半 ${fmt(sox)}`);
        if (get('taiex')?.change_pct != null) {
            bits.push(`加權 ${fmt(get('taiex')!.change_pct!)}`);
        }

        return {
            risk_environment: risk,
            market_regime: null,
            market_score: null,
            semiconductor_context: strengthFromChg(sox),
            tech_context: strengthFromChg(nasdaq),
            asia_context: strengthFromChg(asiaAvg),
            fx_context: strengthFromChg(fx != null ? -fx : null), // TWD weaker = USD stronger
            summary: bits.length
                ? `全球參考：${bits.join('、')}｜環境 ${risk}`
                : '全球指數資料不足',
        };
    }
}

function avgAvailable(vals: Array<number | null>): number | null {
    const ok = vals.filter((v): v is number => v != null && Number.isFinite(v));
    if (!ok.length) return null;
    return ok.reduce((a, b) => a + b, 0) / ok.length;
}

function fmt(n: number): string {
    return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}
