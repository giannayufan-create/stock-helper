// server/src/lib/event-intelligence/classify.ts

import type { EventType, SourceConfidence } from './types.ts';

const RULES: Array<{ type: EventType; keys: string[]; severity: number }> = [
    {
        type: 'SHIPPING_DISRUPTION',
        keys: ['紅海', '霍爾木茲', '航運中斷', '運價', '貨櫃', '封鎖航線', '襲擊商船'],
        severity: 75,
    },
    {
        type: 'WAR_CONFLICT',
        keys: ['戰爭', '開戰', '導彈', '空襲', '武裝衝突', '入侵', '戰火'],
        severity: 85,
    },
    {
        type: 'GEOPOLITICAL',
        keys: ['地緣', '緊張', '軍事演習', '衝突升溫'],
        severity: 65,
    },
    {
        type: 'SANCTION',
        keys: ['制裁', '禁運', '實體清單'],
        severity: 70,
    },
    {
        type: 'EXPORT_CONTROL',
        keys: ['出口管制', '晶片管制', '先進製程限制'],
        severity: 72,
    },
    {
        type: 'EPIDEMIC',
        keys: ['疫情', '傳染病', 'CDC', '流感', '呼吸道', '確診暴增', '病毒'],
        severity: 70,
    },
    {
        type: 'EARTHQUAKE',
        keys: ['地震', '餘震'],
        severity: 60,
    },
    {
        type: 'NATURAL_DISASTER',
        keys: ['颱風', '洪水', '天災', '豪雨成災'],
        severity: 55,
    },
    {
        type: 'ENERGY',
        keys: ['油價', '原油', 'WTI', '布倫特', '石油'],
        severity: 60,
    },
    {
        type: 'COMMODITY',
        keys: ['銅價', '金價', '原物料'],
        severity: 50,
    },
    {
        type: 'SEMICONDUCTOR',
        keys: ['半導體', '晶圓', '先進封裝'],
        severity: 55,
    },
];

export function classifyTitle(title: string): {
    event_type: EventType;
    severity: number;
    matched: string[];
} {
    const t = title.toLowerCase();
    const matched: string[] = [];
    let best: { type: EventType; severity: number } | null = null;
    for (const r of RULES) {
        const hits = r.keys.filter((k) => title.includes(k) || t.includes(k.toLowerCase()));
        if (!hits.length) continue;
        matched.push(...hits);
        if (!best || r.severity > best.severity) {
            best = { type: r.type, severity: r.severity };
        }
    }
    return {
        event_type: best?.type ?? 'OTHER',
        severity: best?.severity ?? 30,
        matched: [...new Set(matched)],
    };
}

export function sourceConfidence(
    source: string,
    sourceType: string,
): SourceConfidence {
    const s = source.toLowerCase();
    if (
        sourceType === 'OFFICIAL' ||
        /cdc|衛福|疾管|證交所|櫃買|mops|政府|官方/.test(s)
    ) {
        return 'HIGH';
    }
    if (
        /reuters|bloomberg|路透|彭博|中央社|經濟日報|工商時報|聯合|yahoo|cnbc/.test(
            s,
        )
    ) {
        return 'HIGH';
    }
    if (sourceType === 'ESTABLISHED_NEWS' || sourceType === 'GLOBAL_FEED') {
        return 'MEDIUM';
    }
    if (sourceType === 'AGGREGATOR' || /google|aggregator/.test(s)) {
        return 'MEDIUM';
    }
    return 'LOW';
}

export function taiwanRelevance(title: string, eventType: EventType): number {
    let score = 40;
    if (/台股|台灣|臺|台積|航運|貨櫃/.test(title)) score += 35;
    if (
        eventType === 'SHIPPING_DISRUPTION' ||
        eventType === 'SEMICONDUCTOR' ||
        eventType === 'EXPORT_CONTROL'
    ) {
        score += 20;
    }
    if (eventType === 'WAR_CONFLICT' || eventType === 'GEOPOLITICAL') score += 10;
    return Math.min(100, score);
}
