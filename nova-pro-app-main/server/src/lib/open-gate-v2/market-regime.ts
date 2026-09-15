// server/src/lib/open-gate-v2/market-regime.ts — rule-based (NOT AI/LLM)

import {
    fetchUsIndices,
    scoreUsOvernightBias,
} from '../us-indices.ts';
import type { OpenGateConfig } from './config.ts';
import type { MarketRegimeLabel } from './types.ts';

export interface MarketRegimeResult {
    market_score: number;
    market_regime: MarketRegimeLabel;
    market_adjustment: number;
    components: {
        taiex: { available: boolean; value: number | null };
        tpex: { available: boolean; value: number | null };
        breadth: { available: boolean; value: number | null };
        us_overnight: { available: boolean; value: number | null };
    };
    notes: string[];
}

interface YahooMeta {
    chart?: {
        result?: Array<{
            meta?: {
                regularMarketPrice?: number;
                chartPreviousClose?: number;
                previousClose?: number;
            };
        }>;
    };
}

async function yahooChange(symbol: string): Promise<number | null> {
    try {
        const url =
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
            '?interval=1d&range=5d';
        const res = await fetch(url, {
            signal: AbortSignal.timeout(8000),
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: 'application/json',
            },
        });
        if (!res.ok) return null;
        const json = (await res.json()) as YahooMeta;
        const meta = json.chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) return null;
        const prev = meta.chartPreviousClose ?? meta.previousClose;
        if (!prev) return null;
        return ((meta.regularMarketPrice - prev) / prev) * 100;
    } catch {
        return null;
    }
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

function chgToScore(chg: number): number {
    // -3% → 0, 0% → 50, +3% → 100
    return clamp(50 + (chg / 3) * 50, 0, 100);
}

function labelFromScore(score: number): MarketRegimeLabel {
    if (score >= 80) return 'strong_bull';
    if (score >= 62) return 'bull';
    if (score >= 42) return 'neutral';
    if (score >= 25) return 'bear';
    return 'strong_bear';
}

export class MarketRegimeService {
    private cache: { at: number; value: MarketRegimeResult } | null = null;

    constructor(private cfg: OpenGateConfig) {}

    async evaluate(breadthPct: number | null = null): Promise<MarketRegimeResult> {
        const now = Date.now();
        if (this.cache && now - this.cache.at < 60_000) {
            return this.cache.value;
        }

        const [taiex, tpex] = await Promise.all([
            yahooChange('%5ETWII'),
            yahooChange('%5ETPEX'),
        ]);

        let usAdj: number | null = null;
        try {
            const us = await fetchUsIndices();
            usAdj = scoreUsOvernightBias(us).scoreAdj;
        } catch {
            usAdj = null;
        }

        const comps = {
            taiex: {
                available: taiex != null,
                value: taiex != null ? chgToScore(taiex) : null,
            },
            tpex: {
                available: tpex != null,
                value: tpex != null ? chgToScore(tpex) : null,
            },
            breadth: {
                available: breadthPct != null && Number.isFinite(breadthPct),
                value:
                    breadthPct != null
                        ? clamp(breadthPct, 0, 100)
                        : null,
            },
            us_overnight: {
                available: usAdj != null,
                // map -10..+10 → 0..100
                value:
                    usAdj != null ? clamp(50 + usAdj * 5, 0, 100) : null,
            },
        };

        const w = this.cfg.market_regime.weights;
        const parts: Array<{ w: number; s: number; name: string }> = [];
        if (comps.taiex.available && comps.taiex.value != null) {
            parts.push({ w: w.taiex, s: comps.taiex.value, name: 'taiex' });
        }
        if (comps.tpex.available && comps.tpex.value != null) {
            parts.push({ w: w.tpex, s: comps.tpex.value, name: 'tpex' });
        }
        if (comps.breadth.available && comps.breadth.value != null) {
            parts.push({
                w: w.breadth,
                s: comps.breadth.value,
                name: 'breadth',
            });
        }
        if (comps.us_overnight.available && comps.us_overnight.value != null) {
            parts.push({
                w: w.us_overnight,
                s: comps.us_overnight.value,
                name: 'us',
            });
        }

        const notes: string[] = [];
        let market_score = 50;
        if (!parts.length) {
            notes.push('market data unavailable — neutral default');
        } else {
            const wSum = parts.reduce((a, p) => a + p.w, 0);
            market_score = parts.reduce((a, p) => a + (p.w / wSum) * p.s, 0);
            const missing = (
                ['taiex', 'tpex', 'breadth', 'us_overnight'] as const
            ).filter((k) => !comps[k].available);
            if (missing.length) {
                notes.push(
                    `missing ${missing.join(',')} — weights renormalized`,
                );
            }
        }

        const lim = this.cfg.market_regime.adjustment_limits;
        // score 50 → 0 adj; 100 → max; 0 → min
        const market_adjustment = clamp(
            ((market_score - 50) / 50) * lim.max,
            lim.min,
            lim.max,
        );

        const value: MarketRegimeResult = {
            market_score: Math.round(market_score),
            market_regime: labelFromScore(market_score),
            market_adjustment: Math.round(market_adjustment * 10) / 10,
            components: comps,
            notes,
        };
        this.cache = { at: now, value };
        return value;
    }

    /**
     * Replay / offline: only use provided point-in-time index changes.
     * Missing components → available=false (never fill 0 as real data).
     */
    evaluateOffline(opts: {
        taiexChangePct: number | null;
        tpexChangePct: number | null;
        breadthPct?: number | null;
        nowMs?: number;
    }): MarketRegimeResult {
        const comps = {
            taiex: {
                available: opts.taiexChangePct != null,
                value:
                    opts.taiexChangePct != null
                        ? chgToScore(opts.taiexChangePct)
                        : null,
            },
            tpex: {
                available: opts.tpexChangePct != null,
                value:
                    opts.tpexChangePct != null
                        ? chgToScore(opts.tpexChangePct)
                        : null,
            },
            breadth: {
                available:
                    opts.breadthPct != null &&
                    Number.isFinite(opts.breadthPct),
                value:
                    opts.breadthPct != null
                        ? clamp(opts.breadthPct, 0, 100)
                        : null,
            },
            us_overnight: {
                available: false,
                value: null,
            },
        };

        const w = this.cfg.market_regime.weights;
        const parts: Array<{ w: number; s: number }> = [];
        if (comps.taiex.available && comps.taiex.value != null) {
            parts.push({ w: w.taiex, s: comps.taiex.value });
        }
        if (comps.tpex.available && comps.tpex.value != null) {
            parts.push({ w: w.tpex, s: comps.tpex.value });
        }
        if (comps.breadth.available && comps.breadth.value != null) {
            parts.push({ w: w.breadth, s: comps.breadth.value });
        }

        const notes: string[] = [];
        let market_score = 50;
        if (!parts.length) {
            notes.push('market data unavailable — neutral default');
            notes.push('data_available=false');
        } else {
            const wSum = parts.reduce((a, p) => a + p.w, 0);
            market_score = parts.reduce((a, p) => a + (p.w / wSum) * p.s, 0);
            notes.push('replay offline regime — weights renormalized');
        }

        const lim = this.cfg.market_regime.adjustment_limits;
        const market_adjustment = clamp(
            ((market_score - 50) / 50) * lim.max,
            lim.min,
            lim.max,
        );

        return {
            market_score: Math.round(market_score),
            market_regime: labelFromScore(market_score),
            market_adjustment: Math.round(market_adjustment * 10) / 10,
            components: comps,
            notes,
        };
    }
}
