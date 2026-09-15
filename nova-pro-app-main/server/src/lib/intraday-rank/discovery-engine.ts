// server/src/lib/intraday-rank/discovery-engine.ts
// C1: Scanner union + A/B sources → discovery_pool

import type { MarketManager } from '../../providers/manager.ts';
import type { ScannerItem, ScannerType } from '../../types/dto.ts';
import type { OpenGateV2Service } from '../open-gate-v2/service.ts';
import type { IntradayRankConfig } from './config.ts';
import type {
    CandidateOrigin,
    CandidateSource,
    DiscoveryItem,
} from './types.ts';

interface Acc {
    symbol: string;
    name: string;
    sources: Set<CandidateSource>;
    ranks: DiscoveryItem['scanner_ranks'];
    change_pct: number | null;
    total_amount: number | null;
    total_volume: number | null;
    a_score: number | null;
    open_score: number | null;
    open_gate_status: string | null;
}

function rankPoints(rank: number | undefined, weight: number): number {
    if (rank == null || rank <= 0) return 0;
    return Math.max(0, weight * (1 - (rank - 1) / 50));
}

function originOf(sources: CandidateSource[]): CandidateOrigin {
    const hasA = sources.includes('A');
    const hasB =
        sources.includes('B_PASS') || sources.includes('B_WATCH');
    const hasScan = sources.some((s) => s.startsWith('SCANNER_'));
    if (hasScan && !hasA && !hasB) return 'intraday_scanner';
    if ((hasA || hasB) && hasScan) return 'mixed';
    if (hasB) return 'open_gate';
    if (hasA) return 'eod_a';
    return 'intraday_scanner';
}

export class DiscoveryEngine {
    private lastPool: DiscoveryItem[] = [];
    private lastAt = 0;

    constructor(
        private market: MarketManager,
        private openGate: OpenGateV2Service,
        private cfg: IntradayRankConfig,
    ) {}

    getLastPool(): DiscoveryItem[] {
        return this.lastPool;
    }

    setConfig(cfg: IntradayRankConfig): void {
        this.cfg = cfg;
    }

    async refresh(force = false): Promise<DiscoveryItem[]> {
        const now = Date.now();
        if (
            !force &&
            this.lastPool.length &&
            now - this.lastAt < this.cfg.scanner_interval_sec * 1000
        ) {
            return this.lastPool;
        }

        const map = new Map<string, Acc>();
        const ensure = (code: string, name?: string): Acc => {
            let a = map.get(code);
            if (!a) {
                a = {
                    symbol: code,
                    name: name || code,
                    sources: new Set(),
                    ranks: {},
                    change_pct: null,
                    total_amount: null,
                    total_volume: null,
                    a_score: null,
                    open_score: null,
                    open_gate_status: null,
                };
                map.set(code, a);
            } else if (name && a.name === a.symbol) {
                a.name = name;
            }
            return a;
        };

        const n = this.cfg.scanner_top_n;
        const jobs: Array<{
            type: ScannerType;
            count: number;
            source: CandidateSource;
            rankKey: keyof DiscoveryItem['scanner_ranks'];
        }> = [
            {
                type: 'ChangePercentRank',
                count: n.change_percent,
                source: 'SCANNER_CHANGE',
                rankKey: 'change',
            },
            {
                type: 'VolumeRank',
                count: n.volume,
                source: 'SCANNER_VOLUME',
                rankKey: 'volume',
            },
            {
                type: 'AmountRank',
                count: n.amount,
                source: 'SCANNER_AMOUNT',
                rankKey: 'amount',
            },
            {
                type: 'TickCountRank',
                count: n.tick_count,
                source: 'SCANNER_TICK',
                rankKey: 'tick',
            },
            {
                type: 'DayRangeRank',
                count: n.day_range,
                source: 'SCANNER_DAYRANGE',
                rankKey: 'day_range',
            },
        ];

        const results = await Promise.all(
            jobs.map(async (j) => {
                try {
                    const items = await this.market.scanner(
                        j.type,
                        j.count,
                        false,
                    );
                    return { j, items };
                } catch {
                    return { j, items: [] as ScannerItem[] };
                }
            }),
        );

        for (const { j, items } of results) {
            items.forEach((it, idx) => {
                const a = ensure(it.code, it.name);
                a.sources.add(j.source);
                a.ranks[j.rankKey] = idx + 1;
                if (it.close > 0 && it.change_price) {
                    a.change_pct =
                        (it.change_price / (it.close - it.change_price)) * 100;
                }
                a.total_amount = it.total_amount || a.total_amount;
                a.total_volume = it.total_volume || a.total_volume;
            });
        }

        const bBatch = this.openGate.getLastBatch();
        if (bBatch?.items?.length) {
            for (const b of bBatch.items) {
                if (
                    b.open_confirm !== 'pass' &&
                    b.open_confirm !== 'early_pass' &&
                    b.open_confirm !== 'watch'
                ) {
                    continue;
                }
                const a = ensure(b.symbol, b.name);
                if (
                    b.open_confirm === 'pass' ||
                    b.open_confirm === 'early_pass'
                ) {
                    a.sources.add('B_PASS');
                } else {
                    a.sources.add('B_WATCH');
                }
                a.open_score = b.final_open_score;
                a.open_gate_status = b.open_confirm;
                a.a_score = b.a_score;
            }
        }

        for (const c of this.openGate.candidates.list()) {
            const a = ensure(c.symbol, c.name);
            a.sources.add('A');
            a.a_score = c.a_score;
        }

        const w = this.cfg.discovery_weights;
        const scored: DiscoveryItem[] = [...map.values()].map((a) => {
            let score =
                rankPoints(a.ranks.amount, w.amount_rank) +
                rankPoints(a.ranks.tick, w.tick_rank) +
                rankPoints(a.ranks.volume, w.volume_rank) +
                rankPoints(a.ranks.change, w.change_rank) +
                rankPoints(a.ranks.day_range, w.day_range_rank);
            if (a.sources.has('B_PASS')) score += w.b_bonus;
            else if (a.sources.has('B_WATCH')) score += w.b_bonus * 0.5;
            if (a.sources.has('A') && (a.a_score ?? 0) >= 55) {
                score += w.a_bonus * Math.min(1, (a.a_score ?? 0) / 100);
            }
            const sources = [...a.sources];
            return {
                symbol: a.symbol,
                name: a.name,
                candidate_sources: sources,
                candidate_origin: originOf(sources),
                discovery_score: Math.round(Math.min(100, score)),
                a_score: a.a_score,
                open_score: a.open_score,
                open_gate_status: a.open_gate_status,
                scanner_ranks: a.ranks,
                change_pct: a.change_pct,
                total_amount: a.total_amount,
                total_volume: a.total_volume,
            };
        });

        scored.sort((x, y) => y.discovery_score - x.discovery_score);
        this.lastPool = scored.slice(0, this.cfg.max_discovery_pool);
        this.lastAt = now;
        return this.lastPool;
    }
}
