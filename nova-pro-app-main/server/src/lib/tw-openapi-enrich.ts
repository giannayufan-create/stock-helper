// server/src/lib/tw-openapi-enrich.ts — TWSE/TPEx OpenAPI snapshots useful for screening
// No key required. Whole-market GETs, cached in-process.
//
// Included (screener-relevant):
//   TWSE: BWIBBU_ALL, STOCK_DAY_AVG_ALL, TWTB4U, TWT48U_ALL, t187ap05_L, t187ap03_L,
//         announcement punish/notetrans, FMTQIK (market tape)
//   TPEx: tpex_mainboard_peratio_analysis, disposal/warning (via regulatory),
//         mopsfin monthly revenue if available

import { fetchRegulatoryLists } from '../providers/fugle/regulatory.ts';

const TWSE = 'https://openapi.twse.com.tw/v1';
const TPEX = 'https://www.tpex.org.tw/openapi/v1';

const CACHE_MS = 45 * 60 * 1000;
const HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; StockHelper/1.0)',
    Accept: 'application/json,text/plain,*/*',
};

export interface OpenApiValuation {
    pe: number | null;
    pb: number | null;
    yieldPct: number | null;
}

export interface OpenApiRevenue {
    momPct: number | null;
    yoyPct: number | null;
    monthRevenue: number | null;
}

export interface OpenApiDayTrade {
    /** 當沖成交比重 % if available */
    ratioPct: number | null;
}

export interface OpenApiExDiv {
    date: string | null; // YYYY-MM-DD if parseable
    soon: boolean; // within ~10 calendar days
}

export interface OpenApiProfile {
    industry: string | null;
}

export interface OpenApiEnrichment {
    valuation: OpenApiValuation | null;
    revenue: OpenApiRevenue | null;
    dayTrade: OpenApiDayTrade | null;
    exDiv: OpenApiExDiv | null;
    profile: OpenApiProfile | null;
    punished: boolean;
    attention: boolean;
    /** Additive strength −14..+12 */
    openapiDelta: number;
    notes: string[];
}

export interface OpenApiMarketTape {
    date: string | null;
    /** advance / (advance+decline) if available */
    breadth: number | null;
    note: string;
}

export interface OpenApiBundle {
    loadedAt: number;
    valuationCount: number;
    revenueCount: number;
    dayTradeCount: number;
    exDivCount: number;
    profileCount: number;
    punishCount: number;
    attentionCount: number;
    market: OpenApiMarketTape;
    byCode: Map<string, OpenApiEnrichment>;
}

let cache: OpenApiBundle | null = null;
let inflight: Promise<OpenApiBundle> | null = null;

function parseNum(v: unknown): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'string') return null;
    const cleaned = v.replace(/,/g, '').replace(/%/g, '').replace(/--/g, '').trim();
    if (!cleaned || cleaned === '-' || cleaned === 'N/A' || cleaned === 'nan')
        return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

function codeOf(row: Record<string, unknown>): string {
    const raw =
        row.Code ??
        row.code ??
        row.SecuritiesCompanyCode ??
        row['公司代號'] ??
        row['證券代號'] ??
        row['股票代號'] ??
        '';
    return String(raw).trim().replace(/=|"/g, '');
}

function pick(row: Record<string, unknown>, keys: string[]): unknown {
    for (const k of keys) {
        if (row[k] != null && row[k] !== '') return row[k];
    }
    const lower = Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]),
    );
    for (const k of keys) {
        const hit = lower[k.toLowerCase()];
        if (hit != null && hit !== '') return hit;
    }
    return undefined;
}

function rocToIso(raw: string): string | null {
    const s = String(raw ?? '').replace(/\D/g, '');
    if (s.length === 7) {
        const y = Number(s.slice(0, 3)) + 1911;
        return `${y}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
    }
    if (s.length === 8) {
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    }
    return null;
}

async function fetchArray(url: string): Promise<Record<string, unknown>[]> {
    try {
        const res = await fetch(url, {
            headers: HEADERS,
            signal: AbortSignal.timeout(25000),
        });
        if (!res.ok) return [];
        const text = await res.text();
        if (!text || text.startsWith('<')) return [];
        const json = JSON.parse(text) as unknown;
        if (!Array.isArray(json)) return [];
        return json.filter(
            (x): x is Record<string, unknown> =>
                !!x && typeof x === 'object' && !Array.isArray(x),
        );
    } catch {
        return [];
    }
}

function daysUntil(iso: string): number | null {
    const t = Date.parse(`${iso}T00:00:00+08:00`);
    if (!Number.isFinite(t)) return null;
    const now = Date.now();
    return Math.round((t - now) / 86400000);
}

function emptyEnrich(): OpenApiEnrichment {
    return {
        valuation: null,
        revenue: null,
        dayTrade: null,
        exDiv: null,
        profile: null,
        punished: false,
        attention: false,
        openapiDelta: 0,
        notes: [],
    };
}

function ensure(
    map: Map<string, OpenApiEnrichment>,
    code: string,
): OpenApiEnrichment {
    let e = map.get(code);
    if (!e) {
        e = emptyEnrich();
        map.set(code, e);
    }
    return e;
}

function scoreEnrichment(e: OpenApiEnrichment): void {
    const notes: string[] = [];
    let delta = 0;

    if (e.punished) {
        delta -= 14;
        notes.push('處置股');
    } else if (e.attention) {
        delta -= 6;
        notes.push('注意股');
    }

    const pe = e.valuation?.pe;
    const pb = e.valuation?.pb;
    const yld = e.valuation?.yieldPct;
    if (pe != null && pe > 0 && pe <= 12) {
        delta += 2;
        notes.push(`本益比 ${pe.toFixed(1)}`);
    } else if (pe != null && pe > 40) {
        delta -= 2;
        notes.push(`本益比偏高 ${pe.toFixed(0)}`);
    }
    if (pb != null && pb > 0 && pb <= 1.2) {
        delta += 1;
    } else if (pb != null && pb >= 5) {
        delta -= 1;
    }
    if (yld != null && yld >= 5) {
        delta += 2;
        notes.push(`殖利率 ${yld.toFixed(1)}%`);
    }

    const yoy = e.revenue?.yoyPct;
    const mom = e.revenue?.momPct;
    if (yoy != null && yoy >= 20) {
        delta += 4;
        notes.push(`營收年增 ${yoy.toFixed(0)}%`);
    } else if (yoy != null && yoy >= 5) {
        delta += 2;
        notes.push(`營收年增 ${yoy.toFixed(0)}%`);
    } else if (yoy != null && yoy <= -15) {
        delta -= 3;
        notes.push(`營收年減 ${yoy.toFixed(0)}%`);
    }
    if (mom != null && mom >= 15) {
        delta += 2;
        notes.push(`營收月增 ${mom.toFixed(0)}%`);
    } else if (mom != null && mom <= -15) {
        delta -= 2;
    }

    const dt = e.dayTrade?.ratioPct;
    if (dt != null && dt >= 40) {
        delta -= 3;
        notes.push(`當沖比 ${dt.toFixed(0)}%`);
    } else if (dt != null && dt >= 25) {
        delta -= 1;
        notes.push(`當沖比 ${dt.toFixed(0)}%`);
    }

    if (e.exDiv?.soon) {
        delta -= 4;
        notes.push(
            e.exDiv.date ? `近除權息 ${e.exDiv.date}` : '近除權息',
        );
    }

    e.openapiDelta = Math.max(-14, Math.min(12, Math.round(delta)));
    e.notes = notes;
}

function parseMarketTape(rows: Record<string, unknown>[]): OpenApiMarketTape {
    if (!rows.length) {
        return { date: null, breadth: null, note: '尚無大盤量能摘要' };
    }
    // FMTQIK fields often: Date, TradeVolume, TradeValue, Transaction, TAIex, Change
    const last = rows[rows.length - 1]!;
    const date = rocToIso(String(pick(last, ['Date', '日期']) ?? ''));
    const change = parseNum(pick(last, ['Change', '漲跌點數', '漲跌']));
    let note = '大盤量能';
    if (change != null) {
        note =
            change > 0
                ? `大盤偏強（+${change}）`
                : change < 0
                  ? `大盤偏弱（${change}）`
                  : '大盤持平';
    }
    return { date, breadth: null, note };
}

async function buildBundle(): Promise<OpenApiBundle> {
    const [
        bwibbu,
        tpexPe,
        dayAvg,
        dayTrade,
        exDiv,
        revenueL,
        revenueO,
        profileL,
        profileO,
        fmtqik,
        regulatory,
    ] = await Promise.all([
        fetchArray(`${TWSE}/exchangeReport/BWIBBU_ALL`),
        fetchArray(`${TPEX}/tpex_mainboard_peratio_analysis`),
        fetchArray(`${TWSE}/exchangeReport/STOCK_DAY_AVG_ALL`),
        fetchArray(`${TWSE}/exchangeReport/TWTB4U`),
        fetchArray(`${TWSE}/exchangeReport/TWT48U_ALL`),
        fetchArray(`${TWSE}/opendata/t187ap05_L`),
        fetchArray(`${TPEX}/mopsfin_t187ap05_O`).catch(() => [] as Record<string, unknown>[]),
        fetchArray(`${TWSE}/opendata/t187ap03_L`),
        fetchArray(`${TPEX}/mopsfin_t187ap03_O`).catch(() => [] as Record<string, unknown>[]),
        fetchArray(`${TWSE}/exchangeReport/FMTQIK`),
        fetchRegulatoryLists().catch(() => ({ code: [] as string[], attention: [] as string[] })),
    ]);

    // Some TPEx paths use alternate names
    let revenueOtc = revenueO;
    if (!revenueOtc.length) {
        revenueOtc = await fetchArray(
            `${TPEX}/tpex_mainboard_monthly_revenue`,
        );
    }
    let profileOtc = profileO;
    if (!profileOtc.length) {
        profileOtc = await fetchArray(`${TPEX}/tpex_mainboard_company_basic`);
    }

    const byCode = new Map<string, OpenApiEnrichment>();

    for (const row of [...bwibbu, ...tpexPe]) {
        const code = codeOf(row);
        if (!/^\d{4}$/.test(code)) continue;
        const e = ensure(byCode, code);
        e.valuation = {
            pe: parseNum(
                pick(row, [
                    'PEratio',
                    'PE',
                    '本益比',
                    'PriceEarningRatio',
                ]),
            ),
            pb: parseNum(
                pick(row, [
                    'PBratio',
                    'PB',
                    '股價淨值比',
                    'PriceBookRatio',
                ]),
            ),
            yieldPct: parseNum(
                pick(row, [
                    'DividendYield',
                    'Yield',
                    '殖利率',
                    'DividendYieldRatio',
                ]),
            ),
        };
    }

    // Monthly average as soft valuation context (store in notes via pe path later if needed)
    for (const row of dayAvg) {
        const code = codeOf(row);
        if (!/^\d{4}$/.test(code)) continue;
        const e = ensure(byCode, code);
        const close = parseNum(
            pick(row, ['ClosingPrice', '收盤價', 'Close']),
        );
        const monthAvg = parseNum(
            pick(row, ['MonthlyAveragePrice', '月平均價', 'Average']),
        );
        if (close != null && monthAvg != null && monthAvg > 0) {
            const vs = close / monthAvg - 1;
            // mild: above monthly avg = strength, far above = chase risk
            if (vs >= 0.08) {
                e.notes.push(`較月均高 ${(vs * 100).toFixed(0)}%`);
            } else if (vs <= -0.08) {
                e.notes.push(`較月均低 ${(vs * 100).toFixed(0)}%`);
            }
            // stash via dayTrade slot? Better add temporary field — apply in score:
            if (!e.dayTrade) e.dayTrade = { ratioPct: null };
            // encode monthly stretch into openapiDelta later in dedicated pass
            (e as OpenApiEnrichment & { _vsMonth?: number })._vsMonth = vs;
        }
    }

    for (const row of dayTrade) {
        const code = codeOf(row);
        if (!/^\d{4}$/.test(code)) continue;
        const e = ensure(byCode, code);
        // Field names vary: 當沖比率 / DayTradeVolume / 成交量值比重
        const ratio =
            parseNum(
                pick(row, [
                    'DayTradeVolumeRatio',
                    '當日沖銷買賣成交量比重',
                    '當沖比率',
                    '比率',
                ]),
            ) ??
            (() => {
                const vol = parseNum(
                    pick(row, ['TotalVolume', '成交股數', 'TradeVolume']),
                );
                const dt = parseNum(
                    pick(row, [
                        'DayTradeVolume',
                        '當日沖銷買賣成交股數',
                        '當沖量',
                    ]),
                );
                if (vol && dt != null && vol > 0) return (dt / vol) * 100;
                return null;
            })();
        e.dayTrade = { ratioPct: ratio };
    }

    for (const row of exDiv) {
        const code = codeOf(row);
        if (!/^\d{4}$/.test(code)) continue;
        const e = ensure(byCode, code);
        const dateRaw = String(
            pick(row, [
                'Date',
                'ExDividendDate',
                '除權息日期',
                '除權交易日',
                '除息交易日',
            ]) ?? '',
        );
        const iso = rocToIso(dateRaw) ?? (/\d{4}-\d{2}-\d{2}/.test(dateRaw) ? dateRaw.slice(0, 10) : null);
        const until = iso ? daysUntil(iso) : null;
        e.exDiv = {
            date: iso,
            soon: until != null && until >= -1 && until <= 10,
        };
    }

    for (const row of [...revenueL, ...revenueOtc]) {
        const code = codeOf(row);
        if (!/^\d{4}$/.test(code)) continue;
        const e = ensure(byCode, code);
        e.revenue = {
            monthRevenue: parseNum(
                pick(row, [
                    '營業收入-當月營收',
                    '當月營收',
                    'MonthlyRevenue',
                    'Revenue',
                ]),
            ),
            momPct: parseNum(
                pick(row, [
                    '營業收入-上月比較增減(%)',
                    '上月比較增減(%)',
                    'MoM',
                    '月增率',
                ]),
            ),
            yoyPct: parseNum(
                pick(row, [
                    '營業收入-去年同月增減(%)',
                    '去年同月增減(%)',
                    'YoY',
                    '年增率',
                ]),
            ),
        };
    }

    for (const row of [...profileL, ...profileOtc]) {
        const code = codeOf(row);
        if (!/^\d{4}$/.test(code)) continue;
        const e = ensure(byCode, code);
        e.profile = {
            industry: String(
                pick(row, [
                    '產業別',
                    'Industry',
                    '產業類別',
                    'CompanyType',
                ]) ?? '',
            ).trim() || null,
        };
    }

    for (const code of regulatory.code) {
        if (!/^\d{4}$/.test(code)) continue;
        ensure(byCode, code).punished = true;
    }
    for (const code of regulatory.attention) {
        if (!/^\d{4}$/.test(code)) continue;
        ensure(byCode, code).attention = true;
    }

    // Finalize scores (include vs monthly avg soft nudge)
    for (const e of byCode.values()) {
        const vs = (e as OpenApiEnrichment & { _vsMonth?: number })._vsMonth;
        scoreEnrichment(e);
        if (vs != null) {
            if (vs >= 0.12) {
                e.openapiDelta = Math.max(-14, e.openapiDelta - 2);
            } else if (vs >= 0.03 && vs < 0.08) {
                e.openapiDelta = Math.min(12, e.openapiDelta + 1);
            } else if (vs <= -0.1) {
                e.openapiDelta = Math.max(-14, e.openapiDelta - 1);
            }
            delete (e as OpenApiEnrichment & { _vsMonth?: number })._vsMonth;
        }
        // re-clamp after month nudge
        e.openapiDelta = Math.max(-14, Math.min(12, e.openapiDelta));
    }

    return {
        loadedAt: Date.now(),
        valuationCount: [...byCode.values()].filter((x) => x.valuation).length,
        revenueCount: [...byCode.values()].filter((x) => x.revenue).length,
        dayTradeCount: [...byCode.values()].filter((x) => x.dayTrade?.ratioPct != null)
            .length,
        exDivCount: [...byCode.values()].filter((x) => x.exDiv?.date).length,
        profileCount: [...byCode.values()].filter((x) => x.profile?.industry)
            .length,
        punishCount: regulatory.code.length,
        attentionCount: regulatory.attention.length,
        market: parseMarketTape(fmtqik),
        byCode,
    };
}

export async function ensureOpenApiBundle(): Promise<OpenApiBundle> {
    if (cache && Date.now() - cache.loadedAt < CACHE_MS) return cache;
    if (inflight) return inflight;
    inflight = buildBundle()
        .then((b) => {
            cache = b;
            inflight = null;
            return b;
        })
        .catch((err) => {
            inflight = null;
            throw err;
        });
    return inflight;
}

export async function getOpenApiEnrichment(
    codes: string[],
): Promise<{
    market: OpenApiMarketTape;
    items: Record<string, OpenApiEnrichment>;
    stats: Omit<OpenApiBundle, 'byCode' | 'market'>;
}> {
    const bundle = await ensureOpenApiBundle();
    const items: Record<string, OpenApiEnrichment> = {};
    for (const code of codes) {
        const hit = bundle.byCode.get(code);
        if (hit) items[code] = hit;
    }
    return {
        market: bundle.market,
        items,
        stats: {
            loadedAt: bundle.loadedAt,
            valuationCount: bundle.valuationCount,
            revenueCount: bundle.revenueCount,
            dayTradeCount: bundle.dayTradeCount,
            exDivCount: bundle.exDivCount,
            profileCount: bundle.profileCount,
            punishCount: bundle.punishCount,
            attentionCount: bundle.attentionCount,
        },
    };
}

export function openApiDto(e: OpenApiEnrichment) {
    return {
        pe: e.valuation?.pe ?? null,
        pb: e.valuation?.pb ?? null,
        yield_pct: e.valuation?.yieldPct ?? null,
        revenue_yoy: e.revenue?.yoyPct ?? null,
        revenue_mom: e.revenue?.momPct ?? null,
        day_trade_pct: e.dayTrade?.ratioPct ?? null,
        ex_div_date: e.exDiv?.date ?? null,
        ex_div_soon: e.exDiv?.soon ?? false,
        industry: e.profile?.industry ?? null,
        punished: e.punished,
        attention: e.attention,
        openapi_delta: e.openapiDelta,
        notes: e.notes,
    };
}
