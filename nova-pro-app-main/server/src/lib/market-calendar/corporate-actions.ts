// TWSE / TPEx corporate action fetch + parse. Never invent missing fields.

import type { MarketCalendarConfig } from './config.ts';
import type {
    ConfidenceLevel,
    CorporateAction,
    CorporateActionType,
} from './types.ts';
import { addCalendarDays, taipeiYmd } from './trading-day.ts';

const TWSE_OPENAPI = 'https://openapi.twse.com.tw/v1';
const TWSE_WWW = 'https://www.twse.com.tw';
const TPEX_OPENAPI = 'https://www.tpex.org.tw/openapi/v1';
const TPEX_WEB = 'https://www.tpex.org.tw';

const HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; StockHelper/1.0)',
    Accept: 'application/json,text/plain,*/*',
};

function pick(row: Record<string, unknown>, keys: string[]): unknown {
    for (const k of keys) {
        if (row[k] != null && String(row[k]).trim() !== '') return row[k];
    }
    return undefined;
}

function parseNum(v: unknown): number | null {
    if (v == null) return null;
    const s = String(v).replace(/,/g, '').trim();
    if (!s || s === '-' || s === '尚未公告' || s === 'N/A') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/** ROC YYYYMMDD or YYYY/MM/DD or ISO → YYYY-MM-DD */
export function normalizeActionDate(raw: string): string | null {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // ROC compact 1150916
    if (/^\d{6,7}$/.test(s)) {
        const roc = Number(s.slice(0, s.length - 4));
        const mm = s.slice(-4, -2);
        const dd = s.slice(-2);
        const y = roc + 1911;
        return `${y}-${mm}-${dd}`;
    }
    // 115/09/16 or 2026/09/16
    const m = s.match(/^(\d{2,4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (m) {
        let y = Number(m[1]);
        if (y < 1911) y += 1911;
        const mm = String(Number(m[2])).padStart(2, '0');
        const dd = String(Number(m[3])).padStart(2, '0');
        return `${y}-${mm}-${dd}`;
    }
    return null;
}

export function mapActionType(raw: unknown): CorporateActionType {
    const s = String(raw ?? '').trim();
    if (s.includes('權息') || s === 'DR' || /right.?div/i.test(s)) {
        return 'EX_RIGHT_DIVIDEND';
    }
    if (s === '權' || s.includes('除權') || s === 'R' || /right/i.test(s)) {
        return 'EX_RIGHT';
    }
    return 'EX_DIVIDEND';
}

function codeOf(row: Record<string, unknown>): string {
    return String(
        pick(row, ['Code', '證券代號', '股票代號', '代號', 'StockNo', 'code']) ??
            '',
    )
        .trim()
        .replace(/\.0$/, '');
}

async function fetchJson(
    url: string,
    timeoutMs: number,
): Promise<unknown> {
    const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const text = await res.text();
    if (!text || text.trim().startsWith('<')) return null;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

async function fetchArray(
    url: string,
    timeoutMs: number,
): Promise<Record<string, unknown>[]> {
    try {
        const raw = await fetchJson(url, timeoutMs);
        if (Array.isArray(raw)) return raw as Record<string, unknown>[];
        if (raw && typeof raw === 'object') {
            const o = raw as Record<string, unknown>;
            if (Array.isArray(o.data)) return o.data as Record<string, unknown>[];
            if (Array.isArray(o.aaData)) return o.aaData as Record<string, unknown>[];
            if (Array.isArray(o.tables)) {
                // some TWSE html-json hybrids
            }
        }
        return [];
    } catch {
        return [];
    }
}

function ymdToYmdCompact(ymd: string): string {
    return ymd.replace(/-/g, '');
}

function ymdToRocSlash(ymd: string): string {
    const [ys, ms, ds] = ymd.split('-');
    const roc = Number(ys) - 1911;
    return `${roc}/${ms}/${ds}`;
}

function baseAction(
    partial: Partial<CorporateAction> &
        Pick<CorporateAction, 'symbol' | 'name' | 'action_date' | 'action_type' | 'market' | 'source' | 'fetched_at'>,
): CorporateAction {
    return {
        cash_dividend: null,
        stock_dividend: null,
        free_share_ratio: null,
        cash_capital_ratio: null,
        subscription_price: null,
        previous_close: null,
        previous_close_available: false,
        ex_reference_price: null,
        ex_reference_price_available: false,
        opening_reference_price: null,
        opening_reference_price_available: false,
        published_at: null,
        confidence: 'MEDIUM',
        ...partial,
    };
}

function parseTwseForecast(
    rows: Record<string, unknown>[],
    fetched_at: string,
): CorporateAction[] {
    const out: CorporateAction[] = [];
    for (const row of rows) {
        const symbol = codeOf(row);
        if (!/^\d{4}[A-Z]?$/.test(symbol) && !/^\d{4,6}[A-Z]?$/.test(symbol)) {
            continue;
        }
        // Prefer equity codes 4 digits for stock context; keep ETFs too
        const dateRaw = String(
            pick(row, [
                'Date',
                'ExDividendDate',
                '除權息日期',
                '除權交易日',
                '除息交易日',
            ]) ?? '',
        );
        const action_date = normalizeActionDate(dateRaw);
        if (!action_date) continue;
        const name = String(
            pick(row, ['Name', '名稱', '證券名稱', '股票名稱']) ?? '',
        ).trim();
        const action_type = mapActionType(
            pick(row, ['Exdividend', '除權息', '權息', '權/息']),
        );
        const cash = parseNum(pick(row, ['CashDividend', '現金股利', '息值']));
        const free = parseNum(
            pick(row, [
                'StockDividendRatio',
                '無償配股率',
                'free_share_ratio',
            ]),
        );
        const cap = parseNum(
            pick(row, ['SubscriptionRatio', '現金增資配股率']),
        );
        const sub = parseNum(
            pick(row, ['SubscriptionPricePerShare', '現金增資認購價']),
        );
        out.push(
            baseAction({
                symbol,
                name,
                action_date,
                action_type,
                market: 'TWSE',
                cash_dividend: cash,
                free_share_ratio: free,
                cash_capital_ratio: cap,
                subscription_price: sub,
                source: 'TWSE:TWT48U_ALL',
                fetched_at,
                confidence: 'MEDIUM',
            }),
        );
    }
    return out;
}

/** TWT49U / calc result rows → merge reference prices. */
function parseTwseCalc(
    rows: Record<string, unknown>[],
    fetched_at: string,
): Map<string, Partial<CorporateAction>> {
    const map = new Map<string, Partial<CorporateAction>>();
    for (const row of rows) {
        // HTML/JSON table may be array-of-arrays or objects
        let symbol = '';
        let action_date: string | null = null;
        let prev: number | null = null;
        let exRef: number | null = null;
        let openRef: number | null = null;
        let cash: number | null = null;
        let actionType: CorporateActionType | null = null;

        if (Array.isArray(row)) {
            const arr = row as unknown[];
            // Typical: date, code, name, prevClose, exRef, ...
            action_date = normalizeActionDate(String(arr[0] ?? ''));
            symbol = String(arr[1] ?? '').trim();
            prev = parseNum(arr[3]);
            exRef = parseNum(arr[4]);
            openRef = parseNum(arr[11] ?? arr[10]);
            cash = parseNum(arr[13] ?? arr[6]);
            actionType = mapActionType(arr[8]);
        } else {
            const r = row as Record<string, unknown>;
            symbol = codeOf(r);
            action_date = normalizeActionDate(
                String(
                    pick(r, [
                        'Date',
                        '除權息日期',
                        '日期',
                        'ExDate',
                    ]) ?? '',
                ),
            );
            prev = parseNum(
                pick(r, [
                    '除權前參考價',
                    '除權息前收盤價',
                    'PreviousClose',
                    'ClosingPriceBefore',
                ]),
            );
            exRef = parseNum(
                pick(r, [
                    '除權參考價',
                    '除權息參考價',
                    'ExReferencePrice',
                    'ReferencePrice',
                ]),
            );
            openRef = parseNum(
                pick(r, [
                    '開盤競價基準',
                    '開始交易基準價',
                    'OpeningReferencePrice',
                ]),
            );
            cash = parseNum(pick(r, ['現金股利', '息值', 'CashDividend']));
            actionType = mapActionType(pick(r, ['權/息', '除權息', 'ExType']));
        }
        if (!symbol || !action_date) continue;
        const key = `${symbol}|${action_date}`;
        map.set(key, {
            symbol,
            action_date,
            action_type: actionType ?? undefined,
            previous_close: prev,
            previous_close_available: prev != null,
            ex_reference_price: exRef,
            ex_reference_price_available: exRef != null,
            opening_reference_price: openRef,
            opening_reference_price_available: openRef != null,
            cash_dividend: cash,
            source: 'TWSE:TWT49U',
            fetched_at,
            confidence: exRef != null ? 'HIGH' : 'MEDIUM',
        });
    }
    return map;
}

function parseTpexForecast(
    rows: Record<string, unknown>[],
    fetched_at: string,
): CorporateAction[] {
    const out: CorporateAction[] = [];
    for (const row of rows) {
        let symbol = '';
        let action_date: string | null = null;
        let name = '';
        let action_type: CorporateActionType = 'EX_DIVIDEND';
        let cash: number | null = null;
        let free: number | null = null;

        if (Array.isArray(row)) {
            const arr = row as unknown[];
            action_date = normalizeActionDate(String(arr[0] ?? ''));
            symbol = String(arr[1] ?? '').trim();
            name = String(arr[2] ?? '').trim();
            action_type = mapActionType(arr[3]);
            free = parseNum(arr[4]);
            cash = parseNum(arr[7] ?? arr[6]);
        } else {
            const r = row as Record<string, unknown>;
            symbol = codeOf(r);
            action_date = normalizeActionDate(
                String(
                    pick(r, ['Date', '除權息日期', 'ExDate', 'date']) ?? '',
                ),
            );
            name = String(
                pick(r, ['Name', '名稱', '證券名稱', 'name']) ?? '',
            ).trim();
            action_type = mapActionType(
                pick(r, ['Exdividend', '除權息', '權息']),
            );
            cash = parseNum(pick(r, ['CashDividend', '現金股利']));
            free = parseNum(pick(r, ['StockDividendRatio', '無償配股率']));
        }
        if (!symbol || !action_date) continue;
        out.push(
            baseAction({
                symbol,
                name,
                action_date,
                action_type,
                market: 'TPEx',
                cash_dividend: cash,
                free_share_ratio: free,
                source: 'TPEx:exright_pre',
                fetched_at,
                confidence: 'MEDIUM',
            }),
        );
    }
    return out;
}

function parseTpexCalc(
    rows: Record<string, unknown>[],
    fetched_at: string,
): Map<string, Partial<CorporateAction>> {
    const map = new Map<string, Partial<CorporateAction>>();
    for (const row of rows) {
        let symbol = '';
        let action_date: string | null = null;
        let prev: number | null = null;
        let exRef: number | null = null;
        let openRef: number | null = null;
        let cash: number | null = null;
        let actionType: CorporateActionType | null = null;

        if (Array.isArray(row)) {
            const arr = row as unknown[];
            action_date = normalizeActionDate(String(arr[0] ?? ''));
            symbol = String(arr[1] ?? '').trim();
            prev = parseNum(arr[3]);
            exRef = parseNum(arr[4]);
            openRef = parseNum(arr[11]);
            cash = parseNum(arr[13] ?? arr[6]);
            actionType = mapActionType(arr[8]);
        } else {
            const r = row as Record<string, unknown>;
            symbol = codeOf(r);
            action_date = normalizeActionDate(
                String(pick(r, ['Date', '除權息日期', 'date']) ?? ''),
            );
            prev = parseNum(
                pick(r, ['除權息前收盤價', 'ClosingPriceBefore', 'prev']),
            );
            exRef = parseNum(
                pick(r, ['除權息參考價', 'ExReferencePrice', 'ex_ref']),
            );
            openRef = parseNum(
                pick(r, ['開始交易基準價', 'OpeningReferencePrice']),
            );
            cash = parseNum(pick(r, ['現金股利', 'CashDividend']));
            actionType = mapActionType(pick(r, ['權/息', '除權息']));
        }
        if (!symbol || !action_date) continue;
        map.set(`${symbol}|${action_date}`, {
            symbol,
            action_date,
            action_type: actionType ?? undefined,
            previous_close: prev,
            previous_close_available: prev != null,
            ex_reference_price: exRef,
            ex_reference_price_available: exRef != null,
            opening_reference_price: openRef,
            opening_reference_price_available: openRef != null,
            cash_dividend: cash,
            source: 'TPEx:exDailyQ',
            fetched_at,
            confidence: exRef != null ? 'HIGH' : 'MEDIUM',
        });
    }
    return map;
}

function mergeActions(
    forecast: CorporateAction[],
    calc: Map<string, Partial<CorporateAction>>,
): CorporateAction[] {
    const byKey = new Map<string, CorporateAction>();
    for (const a of forecast) {
        byKey.set(`${a.symbol}|${a.action_date}`, a);
    }
    for (const [key, c] of calc) {
        const existing = byKey.get(key);
        if (existing) {
            byKey.set(key, {
                ...existing,
                previous_close: c.previous_close ?? existing.previous_close,
                previous_close_available:
                    c.previous_close_available ??
                    existing.previous_close_available,
                ex_reference_price:
                    c.ex_reference_price ?? existing.ex_reference_price,
                ex_reference_price_available:
                    c.ex_reference_price_available ??
                    existing.ex_reference_price_available,
                opening_reference_price:
                    c.opening_reference_price ??
                    existing.opening_reference_price,
                opening_reference_price_available:
                    c.opening_reference_price_available ??
                    existing.opening_reference_price_available,
                cash_dividend: c.cash_dividend ?? existing.cash_dividend,
                action_type: c.action_type ?? existing.action_type,
                confidence:
                    c.ex_reference_price != null ? 'HIGH' : existing.confidence,
                source: `${existing.source}+${c.source ?? 'calc'}`,
            });
        } else if (c.symbol && c.action_date) {
            byKey.set(
                key,
                baseAction({
                    symbol: c.symbol,
                    name: '',
                    action_date: c.action_date,
                    action_type: c.action_type ?? 'EX_DIVIDEND',
                    market: (c as CorporateAction).market ?? 'UNKNOWN',
                    previous_close: c.previous_close ?? null,
                    previous_close_available: Boolean(c.previous_close_available),
                    ex_reference_price: c.ex_reference_price ?? null,
                    ex_reference_price_available: Boolean(
                        c.ex_reference_price_available,
                    ),
                    opening_reference_price: c.opening_reference_price ?? null,
                    opening_reference_price_available: Boolean(
                        c.opening_reference_price_available,
                    ),
                    cash_dividend: c.cash_dividend ?? null,
                    source: c.source ?? 'calc',
                    fetched_at: c.fetched_at ?? new Date().toISOString(),
                    confidence: (c.confidence as ConfidenceLevel) ?? 'MEDIUM',
                }),
            );
        }
    }
    return [...byKey.values()].sort((a, b) =>
        a.action_date.localeCompare(b.action_date),
    );
}

/**
 * Compute ex-reference when official calc missing but cash-only known.
 * Formula (cash only): prev - cash. Never invent stock-right adjustments.
 */
export function deriveCashOnlyExRef(action: CorporateAction): number | null {
    if (action.ex_reference_price_available && action.ex_reference_price != null) {
        return action.ex_reference_price;
    }
    if (
        action.action_type === 'EX_DIVIDEND' &&
        action.previous_close != null &&
        action.cash_dividend != null &&
        action.cash_dividend > 0 &&
        (action.free_share_ratio == null || action.free_share_ratio === 0) &&
        (action.cash_capital_ratio == null || action.cash_capital_ratio === 0)
    ) {
        return Math.round((action.previous_close - action.cash_dividend) * 100) / 100;
    }
    return null;
}

export interface CorporateActionFetchResult {
    actions: CorporateAction[];
    twse_ok: boolean;
    tpex_ok: boolean;
    fetched_at: string;
}

export async function fetchCorporateActions(
    cfg: MarketCalendarConfig,
    asOfYmd: string = taipeiYmd(),
): Promise<CorporateActionFetchResult> {
    const fetched_at = new Date().toISOString();
    const from = addCalendarDays(asOfYmd, -cfg.calc_lookback_days);
    const to = addCalendarDays(asOfYmd, cfg.calc_lookahead_days);
    const t = cfg.request_timeout_ms;

    const [
        twseForecast,
        twseCalcRaw,
        tpexOpenapi,
        tpexPre,
        tpexCalc,
    ] = await Promise.all([
        fetchArray(`${TWSE_OPENAPI}/exchangeReport/TWT48U_ALL`, t),
        fetchJson(
            `${TWSE_WWW}/exchangeReport/TWT49U?response=json&strDate=${ymdToYmdCompact(from)}&endDate=${ymdToYmdCompact(to)}`,
            t,
        ).catch(() => null),
        fetchArray(`${TPEX_OPENAPI}/tpex_exright_pre_announcement`, t).catch(
            () => [] as Record<string, unknown>[],
        ),
        fetchArray(
            `${TPEX_WEB}/web/stock/exright/preAnnounce/preAnnouce_result.php?l=zh-tw&d=${encodeURIComponent(ymdToRocSlash(from))}&ed=${encodeURIComponent(ymdToRocSlash(to))}`,
            t,
        ).catch(() => [] as Record<string, unknown>[]),
        fetchArray(
            `${TPEX_WEB}/web/stock/exright/dailyquo/exDailyQ_result.php?l=zh-tw&d=${encodeURIComponent(ymdToRocSlash(from))}&ed=${encodeURIComponent(ymdToRocSlash(to))}`,
            t,
        ).catch(() => [] as Record<string, unknown>[]),
    ]);

    let twseCalcRows: Record<string, unknown>[] = [];
    if (twseCalcRaw && typeof twseCalcRaw === 'object') {
        const o = twseCalcRaw as Record<string, unknown>;
        if (Array.isArray(o.data)) {
            twseCalcRows = o.data as Record<string, unknown>[];
        } else if (Array.isArray(o.tables)) {
            const tables = o.tables as Array<{ data?: unknown[] }>;
            for (const tb of tables) {
                if (Array.isArray(tb.data)) {
                    twseCalcRows.push(
                        ...(tb.data as Record<string, unknown>[]),
                    );
                }
            }
        }
    }

    const twseF = parseTwseForecast(twseForecast, fetched_at);
    const twseC = parseTwseCalc(twseCalcRows, fetched_at);
    const tpexF = [
        ...parseTpexForecast(tpexOpenapi, fetched_at),
        ...parseTpexForecast(tpexPre, fetched_at),
    ];
    const tpexC = parseTpexCalc(tpexCalc, fetched_at);

    const twseMerged = mergeActions(twseF, twseC).map((a) => ({
        ...a,
        market: 'TWSE' as const,
    }));
    const tpexMerged = mergeActions(tpexF, tpexC).map((a) => ({
        ...a,
        market: 'TPEx' as const,
    }));

    // Enrich cash-only derived ex_ref when official missing
    const actions = [...twseMerged, ...tpexMerged].map((a) => {
        if (!a.ex_reference_price_available) {
            const derived = deriveCashOnlyExRef(a);
            if (derived != null) {
                return {
                    ...a,
                    ex_reference_price: derived,
                    ex_reference_price_available: true,
                    confidence:
                        a.previous_close_available ? ('MEDIUM' as const) : a.confidence,
                    source: `${a.source}+derived_cash_ex_ref`,
                };
            }
        }
        return a;
    });

    return {
        actions,
        twse_ok: twseF.length > 0 || twseC.size > 0,
        tpex_ok: tpexF.length > 0 || tpexC.size > 0,
        fetched_at,
    };
}
