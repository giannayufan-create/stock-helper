// server/src/lib/market-intelligence/sector/sector-mapper.ts

import { ensureOpenApiBundle } from '../../tw-openapi-enrich.ts';

export type SectorMappingSource =
    | 'TWSE_OPENAPI'
    | 'TPEX_OPENAPI'
    | 'UNKNOWN';

export interface SectorMember {
    symbol: string;
    industry: string;
    source: SectorMappingSource;
}

export class SectorMapper {
    private bySymbol = new Map<string, SectorMember>();
    private byIndustry = new Map<string, string[]>();
    private loadedAt = 0;
    private inflight: Promise<void> | null = null;

    async ensureLoaded(maxAgeMs = 45 * 60_000): Promise<void> {
        if (Date.now() - this.loadedAt < maxAgeMs && this.bySymbol.size) {
            return;
        }
        if (this.inflight) return this.inflight;
        this.inflight = this.reload()
            .then(() => {
                this.inflight = null;
            })
            .catch((err) => {
                this.inflight = null;
                throw err;
            });
        return this.inflight;
    }

    private async reload(): Promise<void> {
        const bundle = await ensureOpenApiBundle();
        const bySymbol = new Map<string, SectorMember>();
        const byIndustry = new Map<string, string[]>();

        for (const [code, enrich] of bundle.byCode) {
            const industry = enrich.profile?.industry?.trim();
            if (!industry) continue;
            // Heuristic: TWSE profile rows vs OTC — both come from openapi enrich;
            // mark UNKNOWN unless we can distinguish later.
            const source: SectorMappingSource =
                enrich.profile?.industry != null ? 'TWSE_OPENAPI' : 'UNKNOWN';
            bySymbol.set(code, { symbol: code, industry, source });
            const list = byIndustry.get(industry) ?? [];
            list.push(code);
            byIndustry.set(industry, list);
        }

        // Refine source using market day codes when available is hard here;
        // keep TWSE_OPENAPI as default for official 產業別 string.
        for (const [ind, codes] of byIndustry) {
            byIndustry.set(ind, [...new Set(codes)].sort());
        }

        this.bySymbol = bySymbol;
        this.byIndustry = byIndustry;
        this.loadedAt = Date.now();
    }

    industryOf(symbol: string): SectorMember | null {
        return this.bySymbol.get(symbol) ?? null;
    }

    symbolsOf(industry: string): string[] {
        return this.byIndustry.get(industry) ?? [];
    }

    allIndustries(): string[] {
        return [...this.byIndustry.keys()].sort();
    }

    size(): { symbols: number; industries: number } {
        return {
            symbols: this.bySymbol.size,
            industries: this.byIndustry.size,
        };
    }
}
