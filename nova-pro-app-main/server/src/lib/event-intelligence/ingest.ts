// server/src/lib/event-intelligence/ingest.ts

import { createHash } from 'node:crypto';
import type { EventIntelligenceConfig } from './config.ts';
import {
    classifyTitle,
    sourceConfidence,
    taiwanRelevance,
} from './classify.ts';
import { ageMs, classifyFreshness } from './freshness.ts';
import { clusterKey } from './cluster.ts';
import type { MarketEvent, EventPriority } from './types.ts';
import { EI_VERSION } from './types.ts';

function decodeXml(s: string): string {
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/<[^>]+>/g, '')
        .trim();
}

function parseRss(xml: string, limit: number) {
    const items: Array<{
        title: string;
        source: string;
        published?: string;
        url?: string;
    }> = [];
    const blocks = xml.split(/<item[\s>]/i).slice(1);
    for (const block of blocks) {
        const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const sourceMatch =
            block.match(/<source[^>]*>([\s\S]*?)<\/source>/i) ||
            block.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
        const dateMatch = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
        const linkMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
        const title = decodeXml(titleMatch?.[1] ?? '');
        if (!title) continue;
        items.push({
            title: title.slice(0, 160),
            source: decodeXml(sourceMatch?.[1] ?? 'Google News').slice(0, 40),
            published: decodeXml(dateMatch?.[1] ?? '') || undefined,
            url: decodeXml(linkMatch?.[1] ?? '') || undefined,
        });
        if (items.length >= limit) break;
    }
    return items;
}

async function fetchGoogleRss(query: string): Promise<string> {
    const url =
        'https://news.google.com/rss/search?' +
        new URLSearchParams({
            q: query,
            hl: 'zh-TW',
            gl: 'TW',
            ceid: 'TW:zh-Hant',
        }).toString();
    const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; stock-helper/1.0)',
            Accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
    });
    if (!res.ok) throw new Error(`news HTTP ${res.status}`);
    return res.text();
}

function toIso(pub?: string): string | null {
    if (!pub) return null;
    const t = Date.parse(pub);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function priorityOf(ev: {
    confidence: string;
    severity: number;
    taiwan_relevance: number;
    freshness: string;
}): EventPriority {
    if (ev.freshness === 'ARCHIVED' || ev.freshness === 'STALE') return 'LOW';
    if (ev.confidence === 'LOW') return 'LOW';
    const score =
        ev.severity * 0.4 + ev.taiwan_relevance * 0.4 + (ev.confidence === 'HIGH' ? 20 : 10);
    if (score >= 85 && ev.taiwan_relevance >= 50) return 'CRITICAL';
    if (score >= 70) return 'HIGH';
    if (score >= 45) return 'MEDIUM';
    return 'LOW';
}

function makeEvent(input: {
    title: string;
    source: string;
    source_type: MarketEvent['source_type'];
    url?: string | null;
    published?: string | null;
    fetchedAt: string;
    cfg: EventIntelligenceConfig;
}): MarketEvent {
    const cls = classifyTitle(input.title);
    const published_at = toIso(input.published ?? undefined);
    const age = ageMs(published_at);
    const freshness = classifyFreshness(age, input.cfg);
    const confidence = sourceConfidence(input.source, input.source_type);
    const taiwan_relevance = taiwanRelevance(input.title, cls.event_type);
    const event_relevance = Math.min(
        100,
        Math.round(cls.severity * 0.55 + taiwan_relevance * 0.45),
    );
    const id = createHash('sha1')
        .update(`${cls.event_type}|${input.title}|${published_at ?? ''}`)
        .digest('hex')
        .slice(0, 16);
    const cluster_id = clusterKey(cls.event_type, input.title, published_at);
    const base = {
        confidence,
        severity: cls.severity,
        taiwan_relevance,
        freshness,
    };
    const priority = priorityOf(base);

    return {
        event_id: id,
        cluster_id,
        event_type: cls.event_type,
        event_subtype: null,
        title: input.title,
        summary: null,
        source: input.source,
        source_type: input.source_type,
        source_url: input.url ?? null,
        published_at,
        observed_at: published_at,
        fetched_at: input.fetchedAt,
        country: null,
        region: null,
        entities: cls.matched,
        commodities: cls.event_type === 'ENERGY' ? ['oil'] : [],
        industries: [],
        companies: [],
        severity: cls.severity,
        confidence,
        freshness,
        age_ms: age,
        status: freshness === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
        raw_tags: cls.matched,
        schema_version: EI_VERSION,
        sources_count: 1,
        source_list: [input.source],
        latest_update_at: input.fetchedAt,
        taiwan_relevance,
        event_relevance,
        priority,
        notification_candidate: false,
    };
}

export async function ingestGoogleNewsEvents(
    cfg: EventIntelligenceConfig,
): Promise<MarketEvent[]> {
    const fetchedAt = new Date().toISOString();
    const out: MarketEvent[] = [];
    for (const q of cfg.news_queries) {
        try {
            const xml = await fetchGoogleRss(q);
            for (const item of parseRss(xml, 8)) {
                const ev = makeEvent({
                    title: item.title,
                    source: item.source,
                    source_type: 'ESTABLISHED_NEWS',
                    url: item.url,
                    published: item.published,
                    fetchedAt,
                    cfg,
                });
                if (ev.event_type === 'OTHER' && ev.severity < 40) continue;
                out.push(ev);
            }
        } catch {
            // soft-fail per query
        }
    }
    return out;
}

/** Optional GDELT DOC API — soft-fail → empty. */
export async function ingestGdeltEvents(
    cfg: EventIntelligenceConfig,
): Promise<MarketEvent[]> {
    if (!cfg.gdelt_enabled) return [];
    const fetchedAt = new Date().toISOString();
    const queries = [
        'Red Sea shipping',
        'sanctions semiconductor',
        'epidemic outbreak',
    ];
    const out: MarketEvent[] = [];
    for (const q of queries) {
        try {
            const url =
                'https://api.gdeltproject.org/api/v2/doc/doc?' +
                new URLSearchParams({
                    query: q,
                    mode: 'ArtList',
                    maxrecords: '5',
                    format: 'json',
                    sort: 'HybridRel',
                }).toString();
            const res = await fetch(url, {
                signal: AbortSignal.timeout(7000),
            });
            if (!res.ok) continue;
            const json = (await res.json()) as {
                articles?: Array<{
                    title?: string;
                    url?: string;
                    seendate?: string;
                    sourcecountry?: string;
                    domain?: string;
                }>;
            };
            for (const a of json.articles ?? []) {
                if (!a.title) continue;
                const pub = a.seendate
                    ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}T${a.seendate.slice(8, 10) || '00'}:00:00.000Z`
                    : null;
                out.push(
                    makeEvent({
                        title: a.title,
                        source: a.domain ?? 'GDELT',
                        source_type: 'GLOBAL_FEED',
                        url: a.url,
                        published: pub,
                        fetchedAt,
                        cfg,
                    }),
                );
            }
        } catch {
            // GDELT optional
        }
    }
    return out;
}

export function ingestSyntheticForTest(
    partial: Partial<MarketEvent> & { title: string; event_type: MarketEvent['event_type'] },
    cfg: EventIntelligenceConfig,
): MarketEvent {
    const fetchedAt = partial.fetched_at ?? new Date().toISOString();
    const published_at = partial.published_at ?? fetchedAt;
    const age = ageMs(published_at);
    const freshness = classifyFreshness(age, cfg);
    const id =
        partial.event_id ??
        createHash('sha1').update(partial.title).digest('hex').slice(0, 16);
    const confidence = partial.confidence ?? 'HIGH';
    let priority = partial.priority ?? 'HIGH';
    if (confidence === 'LOW' && (priority === 'CRITICAL' || priority === 'HIGH')) {
        priority = 'LOW';
    }
    if (freshness === 'STALE' || freshness === 'ARCHIVED') {
        priority = 'LOW';
    }
    return {
        event_id: id,
        cluster_id: partial.cluster_id ?? id,
        event_type: partial.event_type,
        event_subtype: null,
        title: partial.title,
        summary: partial.summary ?? null,
        source: partial.source ?? 'test',
        source_type: partial.source_type ?? 'ESTABLISHED_NEWS',
        source_url: null,
        published_at,
        observed_at: published_at,
        fetched_at: fetchedAt,
        country: null,
        region: null,
        entities: partial.entities ?? [],
        commodities: partial.commodities ?? [],
        industries: partial.industries ?? [],
        companies: partial.companies ?? [],
        severity: partial.severity ?? 80,
        confidence,
        freshness,
        age_ms: age,
        status: 'ACTIVE',
        raw_tags: partial.raw_tags ?? [],
        schema_version: EI_VERSION,
        sources_count: partial.sources_count ?? 1,
        source_list: partial.source_list ?? [partial.source ?? 'test'],
        latest_update_at: fetchedAt,
        taiwan_relevance: partial.taiwan_relevance ?? 80,
        event_relevance: partial.event_relevance ?? 90,
        priority,
        notification_candidate: false,
    };
}
