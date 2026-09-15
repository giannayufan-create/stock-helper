// server/src/lib/market-intelligence/ai/intelligence-summary.ts
// Optional Gemini brief — failure never blocks MI snapshot.

import type { AiBriefPayload, MarketIntelligenceSnapshot, RiskEnvironment } from '../types.ts';

const FORBIDDEN =
    /買進|賣出|必漲|必跌|目標價|建議買|建議賣|做多|做空|保證獲利/;

function sanitizeText(s: string): string | null {
    if (FORBIDDEN.test(s)) return null;
    return s.slice(0, 200);
}

export async function buildIntelligenceBrief(opts: {
    apiKey: string;
    snapshot: Pick<
        MarketIntelligenceSnapshot,
        | 'market_context'
        | 'global_markets'
        | 'sectors'
        | 'themes'
        | 'headlines'
        | 'data_health'
    >;
}): Promise<AiBriefPayload> {
    const empty = (error: string | null): AiBriefPayload => ({
        available: false,
        market_summary: null,
        risk_environment: null,
        hot_sectors: [],
        hot_themes: [],
        key_events: [],
        risks: [],
        generated_at: null,
        error,
        source: 'none',
    });

    if (!opts.apiKey) return empty('GEMINI_API_KEY not configured');

    const g = opts.snapshot.global_markets
        .filter((a) => a.status === 'HEALTHY' && a.change_pct != null)
        .slice(0, 10)
        .map(
            (a) =>
                `${a.name} ${a.change_pct! >= 0 ? '+' : ''}${a.change_pct!.toFixed(2)}%`,
        );
    const sectors = opts.snapshot.sectors
        .filter((s) => s.eligible_for_ranking && s.rank != null && s.rank <= 5)
        .map(
            (s) =>
                `${s.sector} heat=${s.heat_score} Δ5m=${s.heat_delta_5m ?? 'n/a'} conf=${s.confidence}`,
        );
    const themes = opts.snapshot.themes
        .filter((t) => t.eligible_for_ranking && t.rank != null && t.rank <= 5)
        .map(
            (t) =>
                `${t.theme} heat=${t.heat_score} Δ5m=${t.heat_delta_5m ?? 'n/a'}`,
        );
    const headlines = opts.snapshot.headlines
        .slice(0, 6)
        .map((h) => h.title);

    const prompt =
        '你是台股市場情報整理員。只描述「現在市場在發生什麼」，禁止建議買賣、目標價、必漲必跌。' +
        '請只輸出 JSON（不要 markdown）：' +
        '{"market_summary":"一句話","risk_environment":"RISK_ON|NEUTRAL|RISK_OFF|UNKNOWN",' +
        '"hot_sectors":[{"name":"...","reason":"..."}],"hot_themes":[{"name":"...","reason":"..."}],' +
        '"key_events":["..."],"risks":["..."]}\n' +
        `regime=${opts.snapshot.market_context.summary}\n` +
        `global=${g.join('; ')}\n` +
        `top_sectors=${sectors.join('; ')}\n` +
        `top_themes=${themes.join('; ')}\n` +
        `headlines=${headlines.join(' | ')}\n` +
        `health=${opts.snapshot.data_health.overall}`;

    try {
        const url =
            'https://generativelanguage.googleapis.com/v1beta/models/' +
            `gemini-3.6-flash:generateContent?key=${encodeURIComponent(opts.apiKey)}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.3,
                    maxOutputTokens: 500,
                    responseMimeType: 'application/json',
                },
            }),
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return empty(`Gemini HTTP ${res.status}: ${body.slice(0, 120)}`);
        }
        const payload = (await res.json()) as {
            candidates?: Array<{
                content?: { parts?: Array<{ text?: string }> };
            }>;
        };
        const text =
            payload.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
        const parsed = JSON.parse(text) as {
            market_summary?: string;
            risk_environment?: string;
            hot_sectors?: Array<{ name: string; reason: string }>;
            hot_themes?: Array<{ name: string; reason: string }>;
            key_events?: string[];
            risks?: string[];
        };

        const summary = sanitizeText(parsed.market_summary ?? '');
        if (!summary && parsed.market_summary) {
            return empty('AI output rejected by safety filter');
        }

        const risk = (
            ['RISK_ON', 'NEUTRAL', 'RISK_OFF', 'UNKNOWN'] as RiskEnvironment[]
        ).includes(parsed.risk_environment as RiskEnvironment)
            ? (parsed.risk_environment as RiskEnvironment)
            : opts.snapshot.market_context.risk_environment;

        const hot_sectors = (parsed.hot_sectors ?? [])
            .slice(0, 5)
            .map((x) => ({
                name: String(x.name).slice(0, 40),
                reason: sanitizeText(String(x.reason)) ?? '同步偏強',
            }))
            .filter((x) => !FORBIDDEN.test(x.reason));

        const hot_themes = (parsed.hot_themes ?? [])
            .slice(0, 5)
            .map((x) => ({
                name: String(x.name).slice(0, 40),
                reason: sanitizeText(String(x.reason)) ?? '題材同步升溫',
            }))
            .filter((x) => !FORBIDDEN.test(x.reason));

        return {
            available: true,
            market_summary: summary,
            risk_environment: risk,
            hot_sectors,
            hot_themes,
            key_events: (parsed.key_events ?? [])
                .slice(0, 5)
                .map((e) => sanitizeText(String(e)))
                .filter((e): e is string => Boolean(e)),
            risks: (parsed.risks ?? [])
                .slice(0, 5)
                .map((e) => sanitizeText(String(e)))
                .filter((e): e is string => Boolean(e)),
            generated_at: new Date().toISOString(),
            error: null,
            source: 'gemini',
        };
    } catch (err) {
        return empty(err instanceof Error ? err.message : String(err));
    }
}
