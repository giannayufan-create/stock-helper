// server/src/lib/market-intelligence/news/news-dedupe.ts

import { createHash } from 'node:crypto';
import type { NewsArticle, NewsScope } from '../types.ts';

export function normalizeTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '')
        .slice(0, 120);
}

export function newsHash(opts: {
    title: string;
    source: string;
    url?: string | null;
}): string {
    const canon =
        (opts.url?.trim() || '') +
        '|' +
        normalizeTitle(opts.title) +
        '|' +
        opts.source.trim().toLowerCase();
    return createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

export function mergeArticle(
    existing: NewsArticle,
    incoming: Partial<NewsArticle> & {
        scopes?: NewsScope[];
        related_symbols?: string[];
        related_sectors?: string[];
        related_themes?: string[];
    },
): NewsArticle {
    const uniq = <T>(arr: T[]) => [...new Set(arr)];
    return {
        ...existing,
        scopes: uniq([
            ...existing.scopes,
            ...(incoming.scopes ?? []),
        ]),
        related_symbols: uniq([
            ...existing.related_symbols,
            ...(incoming.related_symbols ?? []),
        ]),
        related_sectors: uniq([
            ...existing.related_sectors,
            ...(incoming.related_sectors ?? []),
        ]),
        related_themes: uniq([
            ...existing.related_themes,
            ...(incoming.related_themes ?? []),
        ]),
    };
}
