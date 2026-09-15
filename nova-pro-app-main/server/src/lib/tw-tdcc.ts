// server/src/lib/tw-tdcc.ts — TDCC 集保大戶比（≥400張）best-effort enrichment

export interface TdccInfo {
    largeHolderPct: number; // 400張以上持股比例 %
    asOf?: string;
    delta: number;
    note?: string;
}

const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; info: TdccInfo | null }>();

const HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; StockHelper/1.0)',
    Accept: 'application/json,text/html,*/*',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    Origin: 'https://www.tdcc.com.tw',
    Referer: 'https://www.tdcc.com.tw/portal/zh/smWeb/qryStock',
};

function parsePct(v: string): number {
    const n = Number(v.replace(/,/g, '').replace(/%/g, '').trim());
    return Number.isFinite(n) ? n : 0;
}

/** Sum ownership % for tiers that are typically ≥400 lots in TDCC tables. */
function parseLargePctFromHtml(html: string): number | null {
    // Prefer JSON-ish embedded tables; fall back to crude row scan
    const rows = [
        ...html.matchAll(
            /<tr[^>]*>[\s\S]*?<\/tr>/gi,
        ),
    ].map((m) => m[0]);
    let sum = 0;
    let hit = false;
    for (const row of rows) {
        const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
            (m) =>
                m[1]!
                    .replace(/<[^>]+>/g, '')
                    .replace(/&nbsp;/g, ' ')
                    .trim(),
        );
        if (cells.length < 3) continue;
        const label = cells[0] ?? '';
        // 15: 400-600, 16: 600-800, 17: 800-1000, 18: ≥1000 (common TDCC tiers)
        if (
            /400\s*[~～\-－]\s*600|600\s*[~～\-－]\s*800|800\s*[~～\-－]\s*1000|1,?000\s*張\s*以上|1000張以上|≧\s*1,?000/.test(
                label,
            ) ||
            /^1[5-8]$/.test(label)
        ) {
            const pctCell =
                cells.find((c) => c.includes('%')) ?? cells[cells.length - 2] ?? '';
            const pct = parsePct(pctCell);
            if (pct > 0 && pct <= 100) {
                sum += pct;
                hit = true;
            }
        }
    }
    return hit ? +sum.toFixed(2) : null;
}

async function fetchOne(code: string): Promise<TdccInfo | null> {
    const cached = cache.get(code);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.info;

    // Try open data first (weekly files vary); then AJAX portal
    try {
        const body = new URLSearchParams({
            REQ_OPR: 'qryStockData',
            STOCKNO: code,
            StockNo: code,
            sqlMethod: 'StockNo',
            stockNo: code,
        });
        const res = await fetch(
            'https://www.tdcc.com.tw/smWeb/QryStockAjax.do',
            {
                method: 'POST',
                headers: HEADERS,
                body: body.toString(),
                signal: AbortSignal.timeout(12000),
            },
        );
        if (res.ok) {
            const text = await res.text();
            let large: number | null = null;
            try {
                const json = JSON.parse(text) as {
                    data?: Array<{
                        percentage?: string;
                        stockLevel?: string;
                        title?: string;
                    }>;
                    scaDate?: string;
                };
                if (Array.isArray(json.data)) {
                    let sum = 0;
                    for (const row of json.data) {
                        const title = String(row.title ?? row.stockLevel ?? '');
                        if (
                            /400|600|800|1000|1,000/.test(title) &&
                            !/未滿\s*400|1\s*[~～].*400/.test(title)
                        ) {
                            // exclude tiers below 400 if labeled
                            if (/未滿|以下/.test(title) && /400/.test(title))
                                continue;
                            if (
                                /400\s*[~～]|600\s*[~～]|800\s*[~～]|1000|1,000|≧/.test(
                                    title,
                                ) ||
                                /^1[5-8]/.test(title)
                            ) {
                                sum += parsePct(String(row.percentage ?? '0'));
                            }
                        }
                    }
                    if (sum > 0) large = +sum.toFixed(2);
                }
            } catch {
                large = parseLargePctFromHtml(text);
            }
            if (large != null && large > 0) {
                let delta = 0;
                let note: string | undefined;
                if (large >= 40) {
                    delta = 5;
                    note = `集保大戶 ${large}%`;
                } else if (large >= 25) {
                    delta = 3;
                    note = `集保大戶 ${large}%`;
                } else if (large <= 8) {
                    delta = -2;
                    note = `集保大戶偏低 ${large}%`;
                }
                const info: TdccInfo = {
                    largeHolderPct: large,
                    delta,
                    note,
                };
                cache.set(code, { at: Date.now(), info });
                return info;
            }
        }
    } catch {
        // ignore
    }

    cache.set(code, { at: Date.now(), info: null });
    return null;
}

/** Enrich a small finalist set only — TDCC is slow / rate-limited. */
export async function fetchTdccBatch(
    codes: string[],
    concurrency = 3,
): Promise<Map<string, TdccInfo>> {
    const out = new Map<string, TdccInfo>();
    for (let i = 0; i < codes.length; i += concurrency) {
        const chunk = codes.slice(i, i + concurrency);
        const hits = await Promise.all(
            chunk.map(async (code) => {
                const info = await fetchOne(code);
                return info ? ([code, info] as const) : null;
            }),
        );
        for (const h of hits) {
            if (h) out.set(h[0], h[1]);
        }
    }
    return out;
}
