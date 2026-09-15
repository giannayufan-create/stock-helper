// server/src/lib/market-intelligence/company-events/company-event-service.ts

import { fetchRegulatoryLists } from '../../../providers/fugle/regulatory.ts';
import { ensureOpenApiBundle } from '../../tw-openapi-enrich.ts';
import type { CompanyEventItem } from '../types.ts';

export class CompanyEventService {
    private cache: { at: number; events: CompanyEventItem[] } | null = null;
    private lastError: string | null = null;

    /** Full MOPS material info is NOT available in v1. */
    readonly material_info_available = false;
    readonly material_info_coverage = 'PARTIAL' as const;

    getLastError(): string | null {
        return this.lastError;
    }

    getCached(): CompanyEventItem[] {
        return this.cache?.events ?? [];
    }

    async refresh(): Promise<CompanyEventItem[]> {
        try {
            const [reg, bundle] = await Promise.all([
                fetchRegulatoryLists().catch(() => ({
                    code: [] as string[],
                    attention: [] as string[],
                })),
                ensureOpenApiBundle().catch(() => null),
            ]);
            const events: CompanyEventItem[] = [];
            const now = new Date().toISOString().slice(0, 10);

            for (const code of reg.code ?? []) {
                events.push({
                    event_type: 'punish',
                    symbol: code,
                    title: `${code} 處置／警示相關公告`,
                    published_at: now,
                    source: 'TWSE_announcement',
                    severity: 'critical',
                });
            }
            for (const code of reg.attention ?? []) {
                events.push({
                    event_type: 'attention',
                    symbol: code,
                    title: `${code} 注意股公告`,
                    published_at: now,
                    source: 'TWSE_announcement',
                    severity: 'warning',
                });
            }

            if (bundle) {
                let n = 0;
                for (const [code, e] of bundle.byCode) {
                    if (n >= 40) break;
                    if (e.exDiv?.soon && e.exDiv.date) {
                        events.push({
                            event_type: 'ex_dividend',
                            symbol: code,
                            title: `${code} 即將除權息（${e.exDiv.date}）`,
                            published_at: e.exDiv.date,
                            source: 'TWSE_OPENAPI',
                            severity: 'info',
                        });
                        n++;
                    }
                    if (
                        e.revenue?.yoyPct != null &&
                        Math.abs(e.revenue.yoyPct) >= 30
                    ) {
                        events.push({
                            event_type: 'monthly_revenue',
                            symbol: code,
                            title: `${code} 月營收年增 ${e.revenue.yoyPct.toFixed(1)}%`,
                            published_at: null,
                            source: 'MOPS_via_OpenAPI',
                            severity: 'info',
                        });
                        n++;
                    }
                }
            }

            this.cache = { at: Date.now(), events };
            this.lastError = null;
            return events;
        } catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            return this.cache?.events ?? [];
        }
    }

    forSymbol(symbol: string): CompanyEventItem[] {
        return this.getCached().filter((e) => e.symbol === symbol);
    }
}
