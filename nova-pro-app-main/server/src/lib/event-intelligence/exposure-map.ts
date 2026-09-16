// server/src/lib/event-intelligence/exposure-map.ts

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
    CompanyExposureProfile,
    EventType,
    ExposureItem,
    TransmissionChannel,
} from './types.ts';

interface ThemeDef {
    theme_id: string;
    name: string;
    aliases: string[];
    symbols: string[];
    confidence: string;
}

/** Curated product keywords — evidence for exposure. Not revenue %. */
const PRODUCT_EVIDENCE: Array<{
    symbols?: string[];
    keywords: string[];
    channels: TransmissionChannel[];
    event_types: EventType[];
    direction: ExposureItem['direction'];
    evidence: string;
}> = [
    {
        symbols: ['4130', '6547', '3164'], // placeholder testing-ish names if present
        keywords: ['快篩', 'PCR', '試劑', '核酸檢測', '抗原'],
        channels: ['TESTING_DEMAND'],
        event_types: ['EPIDEMIC'],
        direction: 'POSITIVE',
        evidence: 'product_keyword_testing',
    },
    {
        keywords: ['口罩', '防護衣', 'N95', '隔離衣'],
        channels: ['PPE_DEMAND'],
        event_types: ['EPIDEMIC'],
        direction: 'POSITIVE',
        evidence: 'product_keyword_ppe',
    },
    {
        keywords: ['醫美', '玻尿酸', '肉毒'],
        channels: ['MEDICAL_DEMAND'],
        event_types: ['EPIDEMIC'],
        direction: 'UNKNOWN',
        evidence: 'product_keyword_aesthetic_not_outbreak',
    },
];

function loadThemes(): ThemeDef[] {
    const here = dirname(fileURLToPath(import.meta.url));
    const paths = [
        join(here, '../../../config/theme-map.json'),
        join(process.cwd(), 'config/theme-map.json'),
        join(process.cwd(), 'server/config/theme-map.json'),
    ];
    for (const p of paths) {
        if (!existsSync(p)) continue;
        try {
            const raw = JSON.parse(readFileSync(p, 'utf8')) as {
                themes?: ThemeDef[];
            };
            return raw.themes ?? [];
        } catch {
            // continue
        }
    }
    return [];
}

export class CompanyExposureMap {
    private themes = loadThemes();
    private industryOf: ((symbol: string) => string | null) | null = null;
    /** Optional product/name hints from callers (tests / openapi). */
    private nameHints = new Map<string, string>();

    setIndustryResolver(fn: (symbol: string) => string | null): void {
        this.industryOf = fn;
    }

    setNameHint(symbol: string, name: string): void {
        this.nameHints.set(symbol, name);
    }

    profile(
        symbol: string,
        eventType: EventType,
        nowIso = new Date().toISOString(),
    ): CompanyExposureProfile {
        const industry = this.industryOf?.(symbol) ?? null;
        const name = this.nameHints.get(symbol) ?? symbol;
        const products: string[] = [];
        const keywords: string[] = [];
        const exposures: ExposureItem[] = [];
        const channels: TransmissionChannel[] = [];

        // Theme membership evidence
        for (const th of this.themes) {
            if (!th.symbols.includes(symbol)) continue;
            keywords.push(th.name, ...th.aliases);
            if (th.theme_id === 'shipping') {
                if (
                    eventType === 'SHIPPING_DISRUPTION' ||
                    eventType === 'WAR_CONFLICT' ||
                    eventType === 'GEOPOLITICAL' ||
                    eventType === 'ENERGY'
                ) {
                    exposures.push({
                        event_type: eventType,
                        channel: 'FREIGHT_RATE',
                        direction: 'MIXED',
                        confidence: th.confidence === 'high' ? 'HIGH' : 'MEDIUM',
                        evidence_type: 'theme_map',
                        evidence_source: `theme:${th.theme_id}`,
                        last_verified_at: nowIso,
                    });
                    channels.push('FREIGHT_RATE', 'FUEL_COST');
                }
            }
            if (th.theme_id === 'defense') {
                if (eventType === 'WAR_CONFLICT' || eventType === 'GEOPOLITICAL') {
                    exposures.push({
                        event_type: eventType,
                        channel: 'DEFENSE_DEMAND',
                        direction: 'POSITIVE',
                        confidence: 'MEDIUM',
                        evidence_type: 'theme_map',
                        evidence_source: `theme:${th.theme_id}`,
                        last_verified_at: nowIso,
                    });
                    channels.push('DEFENSE_DEMAND');
                }
            }
        }

        // Industry-only biotech without product evidence → LOW / not HIGH
        const isBio =
            (industry && /生技|醫療|製藥|生醫/.test(industry)) ||
            /生技|醫美/.test(name);
        if (eventType === 'EPIDEMIC' && isBio) {
            let matchedProduct = false;
            for (const rule of PRODUCT_EVIDENCE) {
                const hitKw = rule.keywords.some(
                    (k) => name.includes(k) || keywords.some((x) => x.includes(k)),
                );
                const hitSym = rule.symbols?.includes(symbol);
                if (!hitKw && !hitSym) continue;
                if (rule.evidence.includes('aesthetic')) {
                    exposures.push({
                        event_type: 'EPIDEMIC',
                        channel: 'MEDICAL_DEMAND',
                        direction: 'UNKNOWN',
                        confidence: 'LOW',
                        evidence_type: 'product_keyword',
                        evidence_source: rule.evidence,
                        last_verified_at: nowIso,
                    });
                    products.push(...rule.keywords.filter((k) => name.includes(k)));
                    matchedProduct = true;
                    continue;
                }
                if (rule.event_types.includes('EPIDEMIC')) {
                    exposures.push({
                        event_type: 'EPIDEMIC',
                        channel: rule.channels[0]!,
                        direction: rule.direction,
                        confidence: 'HIGH',
                        evidence_type: 'product_keyword',
                        evidence_source: rule.evidence,
                        last_verified_at: nowIso,
                    });
                    channels.push(...rule.channels);
                    products.push(...rule.keywords.filter((k) => name.includes(k)));
                    matchedProduct = true;
                }
            }
            if (!matchedProduct) {
                exposures.push({
                    event_type: 'EPIDEMIC',
                    channel: 'MEDICAL_DEMAND',
                    direction: 'UNKNOWN',
                    confidence: 'LOW',
                    evidence_type: 'industry_label_only',
                    evidence_source: 'industry_classification',
                    last_verified_at: nowIso,
                });
            }
        }

        const confs = exposures.map((e) => e.confidence);
        const overall =
            confs.includes('HIGH') &&
            !exposures.every((e) => e.evidence_type === 'industry_label_only')
                ? 'HIGH'
                : confs.includes('MEDIUM')
                  ? 'MEDIUM'
                  : confs.length
                    ? 'LOW'
                    : 'LOW';

        return {
            symbol,
            company_name: name,
            industry,
            sub_industry: null,
            products,
            business_keywords: keywords,
            event_channels: [...new Set(channels)],
            exposures,
            revenue_exposure_available: false,
            overall_confidence: overall,
        };
    }

    /** Explicit evidence injection for tests / future openapi products. */
    profileWithEvidence(
        symbol: string,
        name: string,
        eventType: EventType,
        evidenceKeywords: string[],
    ): CompanyExposureProfile {
        this.setNameHint(symbol, `${name} ${evidenceKeywords.join(' ')}`);
        return this.profile(symbol, eventType);
    }
}
