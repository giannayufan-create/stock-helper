// server/src/lib/open-gate-v2/a-candidate-repository.ts
// Future: A Screener Server owns the pool. MVP still accepts frontend POST.

import type { ACandidate } from './types.ts';
import {
    adaptACandidates,
    type ACandidateRaw,
} from './a-candidate-adapter.ts';

export class ACandidateRepository {
    private bySymbol = new Map<string, ACandidate>();
    private updatedAt: string | null = null;

    list(): ACandidate[] {
        return [...this.bySymbol.values()];
    }

    get(symbol: string): ACandidate | undefined {
        return this.bySymbol.get(symbol);
    }

    /** MVP: frontend posts A pool (a_score_source = legacy_frontend). */
    replaceFromFrontend(raws: ACandidateRaw[]): ACandidate[] {
        const list = adaptACandidates(raws).map((c) => ({
            ...c,
            a_score_source: 'legacy_frontend' as const,
        }));
        this.bySymbol.clear();
        for (const c of list) this.bySymbol.set(c.symbol, c);
        this.updatedAt = new Date().toISOString();
        return list;
    }

    /** Future server-owned A screener. */
    replaceFromServer(candidates: ACandidate[]): ACandidate[] {
        this.bySymbol.clear();
        for (const c of candidates) {
            this.bySymbol.set(c.symbol, {
                ...c,
                a_score_source: 'server',
            });
        }
        this.updatedAt = new Date().toISOString();
        return this.list();
    }

    lastUpdatedAt(): string | null {
        return this.updatedAt;
    }
}
