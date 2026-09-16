// server/src/lib/event-intelligence/cluster.ts

import type { EventIntelligenceConfig } from './config.ts';
import type { EventType, MarketEvent } from './types.ts';

function tokenize(title: string): Set<string> {
    const parts = title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 2);
    // Also keep CJK bigrams
    const cjk = title.replace(/\s+/g, '');
    for (let i = 0; i < cjk.length - 1; i++) {
        const a = cjk[i]!;
        const b = cjk[i + 1]!;
        if (/[\u4e00-\u9fff]/.test(a) && /[\u4e00-\u9fff]/.test(b)) {
            parts.push(a + b);
        }
    }
    return new Set(parts);
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
}

export function clusterKey(
    eventType: EventType,
    title: string,
    publishedAt: string | null,
): string {
    const day = (publishedAt ?? '').slice(0, 10) || 'unknown';
    const tokens = [...tokenize(title)].slice(0, 8).sort().join('_');
    return `${eventType}:${day}:${tokens.slice(0, 48)}`;
}

/** Merge raw candidates into clusters — many headlines → few events. */
export function clusterEvents(
    raw: MarketEvent[],
    cfg: EventIntelligenceConfig,
): MarketEvent[] {
    const sorted = [...raw].sort((a, b) => {
        const ta = Date.parse(a.published_at ?? a.fetched_at) || 0;
        const tb = Date.parse(b.published_at ?? b.fetched_at) || 0;
        return tb - ta;
    });

    const clusters: MarketEvent[] = [];

    for (const ev of sorted) {
        const toks = tokenize(ev.title);
        const t = Date.parse(ev.published_at ?? ev.fetched_at) || Date.now();
        let merged = false;
        for (const c of clusters) {
            if (c.event_type !== ev.event_type) continue;
            const ct = Date.parse(c.published_at ?? c.fetched_at) || 0;
            if (Math.abs(t - ct) > cfg.cluster_window_ms) continue;
            const sim = jaccard(toks, tokenize(c.title));
            const sharedEntity =
                ev.entities.some((e) => c.entities.includes(e)) ||
                ev.raw_tags.some((x) => c.raw_tags.includes(x));
            const sharedAnchor =
                /紅海|霍爾木茲|台積|制裁|疫情|原油|油價/.test(ev.title) &&
                /紅海|霍爾木茲|台積|制裁|疫情|原油|油價/.test(c.title) &&
                (() => {
                    const anchors = ['紅海', '霍爾木茲', '台積', '制裁', '疫情', '原油', '油價'];
                    return anchors.some((a) => ev.title.includes(a) && c.title.includes(a));
                })();
            if (
                sim >= 0.28 ||
                (sim >= 0.15 && sharedEntity) ||
                sim >= 0.35 ||
                (sharedAnchor && sim >= 0.08) ||
                (sharedEntity && sharedAnchor)
            ) {
                c.sources_count += 1;
                if (!c.source_list.includes(ev.source)) {
                    c.source_list.push(ev.source);
                }
                c.latest_update_at = ev.fetched_at;
                if ((ev.severity ?? 0) > (c.severity ?? 0)) {
                    c.severity = ev.severity;
                }
                // Keep higher confidence
                if (
                    ev.confidence === 'HIGH' ||
                    (ev.confidence === 'MEDIUM' && c.confidence === 'LOW')
                ) {
                    c.confidence = ev.confidence;
                }
                c.entities = [...new Set([...c.entities, ...ev.entities])];
                c.raw_tags = [...new Set([...c.raw_tags, ...ev.raw_tags])];
                merged = true;
                break;
            }
        }
        if (!merged) {
            clusters.push({
                ...ev,
                cluster_id: ev.cluster_id || ev.event_id,
                sources_count: Math.max(1, ev.sources_count),
                source_list: [...(ev.source_list?.length ? ev.source_list : [ev.source])],
            });
        }
    }
    return clusters;
}
