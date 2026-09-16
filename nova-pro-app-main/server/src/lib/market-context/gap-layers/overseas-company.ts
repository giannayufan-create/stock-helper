// server/src/lib/market-context/gap-layers/overseas-company.ts
// Formal TW↔overseas map + Yahoo overnight. No hardcoded NVIDIA→all AI.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchYahooChartMeta } from '../../yahoo-chart.ts';
import { buildMeta } from '../freshness.ts';
import type {
    LayerEnvelope,
    OverseasCompanyData,
    OverseasLink,
} from './types.ts';

function resolvePath(): string | null {
    const here = dirname(fileURLToPath(import.meta.url));
    const cands = [
        join(here, '../../../../config/overseas_company_map.json'),
        join(process.cwd(), 'config/overseas_company_map.json'),
        join(process.cwd(), 'server/config/overseas_company_map.json'),
    ];
    for (const p of cands) if (existsSync(p)) return p;
    return null;
}

export async function evaluateOverseasCompany(
    fetchedAt: string,
): Promise<LayerEnvelope<OverseasCompanyData>> {
    const path = resolvePath();
    let seed: Array<{
        taiwan_symbol: string;
        overseas_symbol: string;
        relation: OverseasLink['relation'];
        exposure_confidence: OverseasLink['exposure_confidence'];
        source: string;
    }> = [];
    if (path) {
        try {
            seed = JSON.parse(readFileSync(path, 'utf8')) as typeof seed;
        } catch {
            seed = [];
        }
    }

    const links: OverseasLink[] = [];
    for (const row of seed.slice(0, 12)) {
        let overnight: number | null = null;
        let freshness = 'map_only';
        if (row.exposure_confidence !== 'LOW') {
            const meta = await fetchYahooChartMeta(row.overseas_symbol).catch(
                () => null,
            );
            if (meta) {
                overnight = meta.changePct;
                freshness = 'yahoo_delayed';
            } else {
                freshness = 'yahoo_unavailable';
            }
        }
        links.push({
            taiwan_symbol: row.taiwan_symbol,
            overseas_symbol: row.overseas_symbol,
            relation: row.relation,
            exposure_confidence: row.exposure_confidence,
            overnight_change: overnight,
            relative_move: overnight,
            freshness,
            source: row.source,
        });
    }

    return {
        layer: 'OverseasCompanyContext',
        completeness: links.length > 0 ? 'PARTIAL' : 'UNAVAILABLE',
        available: links.length > 0,
        proxy: false,
        note: 'Requires explicit map + exposure_confidence. No theme-wide NVIDIA→AI inference.',
        meta: buildMeta({
            source: 'overseas_company_map.json+yahoo',
            source_type: 'overseas_company',
            fetched_at: fetchedAt,
            available: links.length > 0,
            realtime_level: 'DELAYED',
            confidence: 'MEDIUM',
            coverage_pct: Math.min(100, links.length * 10),
        }),
        data: {
            links,
            mapped_count: links.length,
        },
    };
}
