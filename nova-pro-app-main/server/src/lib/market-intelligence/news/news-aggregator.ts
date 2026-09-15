// server/src/lib/market-intelligence/news/news-aggregator.ts
// Google News RSS only — in-memory cache. UI GETs must NOT trigger refresh.

import type { MarketIntelligenceConfig } from '../config.ts';
import type { NewsArticle, NewsScope } from '../types.ts';
import { mergeArticle, newsHash } from './news-dedupe.ts';
import { heuristicSentiment } from './news-sentiment.ts';

interface CacheEntry {
    at: number;
    articles: NewsArticle[];
    error: string | null;
}

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

function parseRss(
    xml: string,
    limit: number,
): Array<{ title: string; source: string; published?: string; url?: string }> {
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
            title: title.slice(0, 120),
            source: decodeXml(sourceMatch?.[1] ?? '網路新聞').slice(0, 40),
            published: decodeXml(dateMatch?.[1] ?? '') || undefined,
            url: decodeXml(linkMatch?.[1] ?? '') || undefined,
        });
        if (items.length >= limit) break;
    }
    return items;
}

async function fetchGoogleNewsRss(query: string): Promise<string> {
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

const GLOBAL_QUERIES = [
    '全球股市 when:2d',
    '美股 when:2d',
    '半導體 when:2d',
    'Fed OR 聯準會 when:3d',
    'interest rate OR 升息 OR 降息 when:3d',
    'inflation OR 通膨 when:3d',
    'Taiwan economy OR 台灣經濟 when:3d',
];

export class NewsAggregator {
    private cache = new Map<string, CacheEntry>();
    private articlesById = new Map<string, NewsArticle>();
    private lastGlobalAt = 0;
    private lastError: string | null = null;

    constructor(private cfg: MarketIntelligenceConfig) {}

    getLastError(): string | null {
        return this.lastError;
    }

    /** Read-only: never hits network. */
    getCachedHeadlines(limit = 12): NewsArticle[] {
        return [...this.articlesById.values()]
            .sort((a, b) => (b.fetched_at > a.fetched_at ? 1 : -1))
            .slice(0, limit);
    }

    getCachedByScope(
        scope: NewsScope,
        key: string,
        limit = 8,
    ): NewsArticle[] {
        const ck = `${scope}:${key}`;
        const hit = this.cache.get(ck);
        if (hit) return hit.articles.slice(0, limit);
        return this.getCachedHeadlines(limit).filter((a) => {
            if (scope === 'SYMBOL') return a.related_symbols.includes(key);
            if (scope === 'SECTOR') return a.related_sectors.includes(key);
            if (scope === 'THEME') return a.related_themes.includes(key);
            return a.scopes.includes('GLOBAL');
        });
    }

    async refreshBackground(opts: {
        sectors: string[];
        themes: Array<{ id: string; name: string; aliases: string[] }>;
    }): Promise<void> {
        try {
            await this.refreshGlobal();
            for (const sector of opts.sectors.slice(0, 5)) {
                await this.queryAndStore({
                    scope: 'SECTOR',
                    key: sector,
                    query: `"${sector}" 台股 when:3d`,
                    related_sectors: [sector],
                    ttl: this.cfg.news.sector_ttl_sec * 1000,
                });
            }
            for (const theme of opts.themes.slice(0, 5)) {
                const q = [theme.name, ...theme.aliases.slice(0, 2)]
                    .map((a) => `"${a}"`)
                    .join(' OR ');
                await this.queryAndStore({
                    scope: 'THEME',
                    key: theme.id,
                    query: `${q} when:3d`,
                    related_themes: [theme.id],
                    ttl: this.cfg.news.theme_ttl_sec * 1000,
                });
            }
            this.lastError = null;
        } catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
        }
    }

    async ensureSymbolNews(
        code: string,
        name?: string,
    ): Promise<NewsArticle[]> {
        const key = code;
        const ck = `SYMBOL:${key}`;
        const hit = this.cache.get(ck);
        const ttl = this.cfg.news.symbol_ttl_sec * 1000;
        if (hit && Date.now() - hit.at < ttl) return hit.articles;

        const qParts = [`"${code}"`];
        if (name) qParts.push(`"${name.replace(/\*$/, '')}"`);
        qParts.push('when:3d');
        return this.queryAndStore({
            scope: 'SYMBOL',
            key,
            query: qParts.join(' OR '),
            related_symbols: [code],
            ttl,
        });
    }

    private async refreshGlobal(): Promise<void> {
        const ttl = this.cfg.news.global_ttl_sec * 1000;
        if (Date.now() - this.lastGlobalAt < ttl * 0.9) return;
        for (const q of GLOBAL_QUERIES) {
            await this.queryAndStore({
                scope: 'GLOBAL',
                key: q.slice(0, 40),
                query: q,
                ttl,
            });
        }
        this.lastGlobalAt = Date.now();
    }

    private async queryAndStore(opts: {
        scope: NewsScope;
        key: string;
        query: string;
        related_symbols?: string[];
        related_sectors?: string[];
        related_themes?: string[];
        ttl: number;
    }): Promise<NewsArticle[]> {
        const ck = `${opts.scope}:${opts.key}`;
        const existing = this.cache.get(ck);
        if (existing && Date.now() - existing.at < opts.ttl) {
            return existing.articles;
        }
        try {
            const xml = await fetchGoogleNewsRss(opts.query);
            const raw = parseRss(xml, this.cfg.news.max_per_query);
            const nowIso = new Date().toISOString();
            const out: NewsArticle[] = [];
            for (const r of raw) {
                const id = newsHash({
                    title: r.title,
                    source: r.source,
                    url: r.url,
                });
                const base: NewsArticle = {
                    id,
                    title: r.title,
                    source: r.source,
                    published_at: r.published ?? null,
                    url: r.url ?? null,
                    snippet: null,
                    sentiment: heuristicSentiment(r.title),
                    sentiment_source: 'heuristic',
                    scopes: [opts.scope],
                    related_symbols: opts.related_symbols ?? [],
                    related_sectors: opts.related_sectors ?? [],
                    related_themes: opts.related_themes ?? [],
                    fetched_at: nowIso,
                };
                const prev = this.articlesById.get(id);
                const merged = prev ? mergeArticle(prev, base) : base;
                this.articlesById.set(id, merged);
                out.push(merged);
            }
            this.cache.set(ck, { at: Date.now(), articles: out, error: null });
            // bound memory
            if (this.articlesById.size > 400) {
                const keys = [...this.articlesById.keys()].slice(0, 100);
                for (const k of keys) this.articlesById.delete(k);
            }
            return out;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.lastError = msg;
            this.cache.set(ck, {
                at: Date.now(),
                articles: existing?.articles ?? [],
                error: msg,
            });
            return existing?.articles ?? [];
        }
    }
}
