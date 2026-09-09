// server/src/lib/tw-chips.ts — TWSE/TPEx 三大法人 + 融資融券（公開資料）
// Free alternative to paid 分點籌碼；資料通常 T+1，盤中僅供參考。

export interface TwChipRow {
    code: string;
    name: string;
    market: 'tse' | 'otc';
    asOf: string; // YYYY-MM-DD
    foreignNet: number; // 股
    trustNet: number;
    dealerNet: number;
    instNet: number; // 三大法人合計
    marginBal: number; // 張
    marginPrev: number;
    marginDelta: number;
    shortBal: number;
    shortPrev: number;
    shortDelta: number;
}

export interface TwChipsBundle {
    asOf: string;
    loadedAt: number;
    byCode: Map<string, TwChipRow>;
}

const CACHE_MS = 45 * 60 * 1000;
const HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; StockHelper/1.0)',
    Accept: 'application/json,text/plain,*/*',
    Referer: 'https://www.twse.com.tw/',
};

let cache: TwChipsBundle | null = null;
let inflight: Promise<TwChipsBundle> | null = null;

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

function ymd(d: Date): string {
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function ymdDash(raw: string): string {
    const s = raw.replace(/\D/g, '');
    if (s.length !== 8) return raw;
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function slashDate(d: Date): string {
    return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function rocSlash(d: Date): string {
    const y = d.getFullYear() - 1911;
    return `${y}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function recentWeekdays(max = 12): Date[] {
    const out: Date[] = [];
    const d = new Date();
    // TWSE publishes prior session; start from yesterday-ish in Taipei
    for (let i = 0; i < 20 && out.length < max; i++) {
        const t = new Date(d.getTime() - i * 86400000);
        const wd = t.getDay();
        if (wd === 0 || wd === 6) continue;
        out.push(t);
    }
    return out;
}

function parseNum(v: unknown): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'string') return 0;
    const cleaned = v.replace(/,/g, '').replace(/--/g, '').trim();
    if (!cleaned || cleaned === '-') return 0;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
}

function fieldIndex(fields: string[], preds: Array<(f: string) => boolean>): number {
    for (let i = 0; i < fields.length; i++) {
        const f = fields[i] ?? '';
        if (preds.some((p) => p(f))) return i;
    }
    return -1;
}

async function fetchJson(url: string): Promise<unknown | null> {
    try {
        const res = await fetch(url, {
            headers: HEADERS,
            signal: AbortSignal.timeout(18000),
        });
        if (!res.ok) return null;
        const text = await res.text();
        if (!text || text.startsWith('<')) return null;
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

function rowsFromPayload(payload: unknown): { fields: string[]; data: unknown[][] } | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.fields) && Array.isArray(p.data)) {
        return {
            fields: p.fields.map(String),
            data: p.data as unknown[][],
        };
    }
    if (Array.isArray(p.tables)) {
        for (const t of p.tables) {
            if (!t || typeof t !== 'object') continue;
            const table = t as Record<string, unknown>;
            if (Array.isArray(table.fields) && Array.isArray(table.data)) {
                const fields = table.fields.map(String);
                const hasCode = fields.some(
                    (f) => f.includes('代號') || f.includes('代碼') || f === '股票代號',
                );
                if (hasCode && (table.data as unknown[]).length > 0) {
                    return { fields, data: table.data as unknown[][] };
                }
            }
        }
    }
    // TPEx sometimes wraps under tables[0].data differently
    if (Array.isArray(p.data) && p.data.length && typeof p.data[0] === 'object') {
        // object rows — convert later
        return null;
    }
    return null;
}

function parseInstRows(
    fields: string[],
    data: unknown[][],
    market: 'tse' | 'otc',
    asOf: string,
): TwChipRow[] {
    const iCode = fieldIndex(fields, [
        (f) => f.includes('證券代號') || f.includes('股票代號') || f === '代號',
    ]);
    const iName = fieldIndex(fields, [(f) => f.includes('名稱')]);
    const iForeign = fieldIndex(fields, [
        (f) => f.includes('外陸資買賣超') || f.includes('外資買賣超') || f.includes('外陸資買賣超股數'),
    ]);
    const iTrust = fieldIndex(fields, [(f) => f.includes('投信買賣超')]);
    const iDealer = fieldIndex(fields, [
        (f) =>
            (f.includes('自營商買賣超') && !f.includes('避險') && !f.includes('自行')) ||
            f === '自營商買賣超股數',
    ]);
    const iDealerSelf = fieldIndex(fields, [
        (f) => f.includes('自營商買賣超') && f.includes('自行'),
    ]);
    const iDealerHedge = fieldIndex(fields, [
        (f) => f.includes('自營商買賣超') && f.includes('避險'),
    ]);
    const iInst = fieldIndex(fields, [
        (f) => f.includes('三大法人買賣超') || f.includes('三大法人合計'),
    ]);
    if (iCode < 0) return [];

    const out: TwChipRow[] = [];
    for (const row of data) {
        if (!Array.isArray(row)) continue;
        const code = String(row[iCode] ?? '')
            .trim()
            .replace(/=|"/g, '');
        if (!/^\d{4,6}$/.test(code)) continue;
        const foreignNet = iForeign >= 0 ? parseNum(row[iForeign]) : 0;
        const trustNet = iTrust >= 0 ? parseNum(row[iTrust]) : 0;
        let dealerNet = 0;
        if (iDealerSelf >= 0 || iDealerHedge >= 0) {
            dealerNet =
                (iDealerSelf >= 0 ? parseNum(row[iDealerSelf]) : 0) +
                (iDealerHedge >= 0 ? parseNum(row[iDealerHedge]) : 0);
        } else if (iDealer >= 0) {
            dealerNet = parseNum(row[iDealer]);
        }
        const instNet =
            iInst >= 0
                ? parseNum(row[iInst])
                : foreignNet + trustNet + dealerNet;
        out.push({
            code,
            name: iName >= 0 ? String(row[iName] ?? '').trim() : '',
            market,
            asOf,
            foreignNet,
            trustNet,
            dealerNet,
            instNet,
            marginBal: 0,
            marginPrev: 0,
            marginDelta: 0,
            shortBal: 0,
            shortPrev: 0,
            shortDelta: 0,
        });
    }
    return out;
}

function parseMarginRows(
    fields: string[],
    data: unknown[][],
): Map<
    string,
    {
        marginBal: number;
        marginPrev: number;
        marginDelta: number;
        shortBal: number;
        shortPrev: number;
        shortDelta: number;
        name?: string;
    }
> {
    const map = new Map<
        string,
        {
            marginBal: number;
            marginPrev: number;
            marginDelta: number;
            shortBal: number;
            shortPrev: number;
            shortDelta: number;
            name?: string;
        }
    >();
    const iCode = fieldIndex(fields, [
        (f) => f.includes('股票代號') || f.includes('證券代號') || f === '代號',
    ]);
    const iName = fieldIndex(fields, [(f) => f.includes('名稱')]);

    // TWSE MI_MARGN fields are duplicated (融資區塊再來融券區塊),
    // e.g. 代號,名稱,買進,賣出,現金償還,前日餘額,今日餘額,...,現券償還,前日餘額,今日餘額,...
    let iMarToday = fieldIndex(fields, [
        (f) => f.includes('融資') && f.includes('今日餘額'),
    ]);
    let iMarPrev = fieldIndex(fields, [
        (f) => f.includes('融資') && f.includes('前日餘額'),
    ]);
    let iShortToday = fieldIndex(fields, [
        (f) => f.includes('融券') && f.includes('今日餘額'),
    ]);
    let iShortPrev = fieldIndex(fields, [
        (f) => f.includes('融券') && f.includes('前日餘額'),
    ]);

    if (iMarToday < 0) {
        const cashRepay = fieldIndex(fields, [(f) => f.includes('現金償還')]);
        const stockRepay = fieldIndex(fields, [(f) => f.includes('現券償還')]);
        const todayIdxs: number[] = [];
        const prevIdxs: number[] = [];
        fields.forEach((f, i) => {
            if (f.includes('今日餘額')) todayIdxs.push(i);
            if (f.includes('前日餘額')) prevIdxs.push(i);
        });
        if (cashRepay >= 0 && todayIdxs.length >= 1) {
            // positional: first 今日/前日 = 融資, second = 融券
            iMarToday = todayIdxs[0] ?? -1;
            iMarPrev = prevIdxs[0] ?? -1;
            iShortToday = todayIdxs[1] ?? -1;
            iShortPrev = prevIdxs[1] ?? -1;
        } else if (stockRepay >= 0 && todayIdxs.length >= 2) {
            iMarToday = todayIdxs[0] ?? -1;
            iMarPrev = prevIdxs[0] ?? -1;
            iShortToday = todayIdxs[1] ?? -1;
            iShortPrev = prevIdxs[1] ?? -1;
        }
    }

    if (iCode < 0 || iMarToday < 0) return map;

    for (const row of data) {
        if (!Array.isArray(row)) continue;
        const code = String(row[iCode] ?? '')
            .trim()
            .replace(/=|"/g, '');
        if (!/^\d{4,6}$/.test(code)) continue;
        const marginBal = parseNum(row[iMarToday]);
        const marginPrev = iMarPrev >= 0 ? parseNum(row[iMarPrev]) : marginBal;
        const shortBal = iShortToday >= 0 ? parseNum(row[iShortToday]) : 0;
        const shortPrev = iShortPrev >= 0 ? parseNum(row[iShortPrev]) : shortBal;
        map.set(code, {
            marginBal,
            marginPrev,
            marginDelta: marginBal - marginPrev,
            shortBal,
            shortPrev,
            shortDelta: shortBal - shortPrev,
            name: iName >= 0 ? String(row[iName] ?? '').trim() : undefined,
        });
    }
    return map;
}

async function loadTwseInst(d: Date): Promise<TwChipRow[]> {
    const date = ymd(d);
    const url =
        `https://www.twse.com.tw/rwd/zh/fund/T86?response=json` +
        `&date=${date}&selectType=ALLBUT0999`;
    const payload = await fetchJson(url);
    const parsed = rowsFromPayload(payload);
    if (!parsed?.data.length) return [];
    const asOf =
        payload && typeof payload === 'object' && 'date' in payload
            ? ymdDash(String((payload as { date?: string }).date ?? date))
            : ymdDash(date);
    return parseInstRows(parsed.fields, parsed.data, 'tse', asOf);
}

async function loadTwseMargin(
    d: Date,
): Promise<Map<string, ReturnType<typeof parseMarginRows> extends Map<string, infer V> ? V : never>> {
    const date = ymd(d);
    const url =
        `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json` +
        `&date=${date}&selectType=STOCK`;
    const payload = await fetchJson(url);
    const parsed = rowsFromPayload(payload);
    if (!parsed?.data.length) return new Map();
    return parseMarginRows(parsed.fields, parsed.data);
}

async function loadTpexInst(d: Date): Promise<TwChipRow[]> {
    const candidates = [
        `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?response=json&date=${encodeURIComponent(slashDate(d))}&type=Daily`,
        `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&o=json&se=EW&t=D&d=${encodeURIComponent(rocSlash(d))}`,
    ];
    for (const url of candidates) {
        const payload = await fetchJson(url);
        const parsed = rowsFromPayload(payload);
        if (!parsed?.data.length) continue;
        return parseInstRows(parsed.fields, parsed.data, 'otc', slashDate(d).replace(/\//g, '-'));
    }
    return [];
}

async function loadTpexMargin(d: Date): Promise<ReturnType<typeof parseMarginRows>> {
    const candidates = [
        `https://www.tpex.org.tw/www/zh-tw/margin/balance?response=json&date=${encodeURIComponent(slashDate(d))}`,
        `https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d=${encodeURIComponent(rocSlash(d))}`,
    ];
    for (const url of candidates) {
        const payload = await fetchJson(url);
        const parsed = rowsFromPayload(payload);
        if (!parsed?.data.length) continue;
        return parseMarginRows(parsed.fields, parsed.data);
    }
    return new Map();
}

function mergeRows(
    inst: TwChipRow[],
    margin: ReturnType<typeof parseMarginRows>,
): Map<string, TwChipRow> {
    const byCode = new Map<string, TwChipRow>();
    for (const row of inst) {
        byCode.set(row.code, { ...row });
    }
    for (const [code, m] of margin) {
        const cur = byCode.get(code);
        if (cur) {
            cur.marginBal = m.marginBal;
            cur.marginPrev = m.marginPrev;
            cur.marginDelta = m.marginDelta;
            cur.shortBal = m.shortBal;
            cur.shortPrev = m.shortPrev;
            cur.shortDelta = m.shortDelta;
            if (!cur.name && m.name) cur.name = m.name;
        } else {
            byCode.set(code, {
                code,
                name: m.name ?? '',
                market: code.startsWith('00') ? 'tse' : 'tse',
                asOf: '',
                foreignNet: 0,
                trustNet: 0,
                dealerNet: 0,
                instNet: 0,
                marginBal: m.marginBal,
                marginPrev: m.marginPrev,
                marginDelta: m.marginDelta,
                shortBal: m.shortBal,
                shortPrev: m.shortPrev,
                shortDelta: m.shortDelta,
            });
        }
    }
    return byCode;
}

async function loadFresh(): Promise<TwChipsBundle> {
    const days = recentWeekdays(10);
    let bestInst: TwChipRow[] = [];
    let bestMargin: ReturnType<typeof parseMarginRows> = new Map();
    let asOf = '';

    for (const d of days) {
        const [tseInst, tseMar] = await Promise.all([
            loadTwseInst(d),
            loadTwseMargin(d),
        ]);
        if (tseInst.length >= 50) {
            bestInst = tseInst;
            bestMargin = tseMar;
            asOf = tseInst[0]?.asOf || ymdDash(ymd(d));
            // OTC best-effort same day
            const [otcInst, otcMar] = await Promise.all([
                loadTpexInst(d),
                loadTpexMargin(d),
            ]);
            bestInst = bestInst.concat(otcInst);
            for (const [k, v] of otcMar) bestMargin.set(k, v);
            break;
        }
    }

    // if TSE failed entirely, still try OTC on latest day
    if (!bestInst.length && days[0]) {
        const d = days[0]!;
        const [otcInst, otcMar] = await Promise.all([
            loadTpexInst(d),
            loadTpexMargin(d),
        ]);
        bestInst = otcInst;
        bestMargin = otcMar;
        asOf = otcInst[0]?.asOf || slashDate(d).replace(/\//g, '-');
    }

    const byCode = mergeRows(bestInst, bestMargin);
    if (!asOf) {
        const first = byCode.values().next().value as TwChipRow | undefined;
        asOf = first?.asOf || new Date().toISOString().slice(0, 10);
    }
    for (const row of byCode.values()) {
        if (!row.asOf) row.asOf = asOf;
    }

    return { asOf, loadedAt: Date.now(), byCode };
}

export async function ensureTwChipsLoaded(): Promise<TwChipsBundle> {
    if (cache && Date.now() - cache.loadedAt < CACHE_MS && cache.byCode.size > 0) {
        return cache;
    }
    if (inflight) return inflight;
    inflight = loadFresh()
        .then((bundle) => {
            if (bundle.byCode.size > 0) cache = bundle;
            else if (cache) return cache;
            else cache = bundle;
            return cache!;
        })
        .finally(() => {
            inflight = null;
        });
    return inflight;
}

export async function getChipRow(code: string): Promise<TwChipRow | null> {
    const bundle = await ensureTwChipsLoaded();
    return bundle.byCode.get(code.trim()) ?? null;
}

export async function getChipRows(
    codes: string[],
): Promise<{ asOf: string; rows: TwChipRow[] }> {
    const bundle = await ensureTwChipsLoaded();
    const rows = codes
        .map((c) => bundle.byCode.get(c.trim()))
        .filter((r): r is TwChipRow => Boolean(r));
    return { asOf: bundle.asOf, rows };
}

export function chipRowToDto(row: TwChipRow) {
    return {
        code: row.code,
        name: row.name,
        market: row.market,
        as_of: row.asOf,
        foreign_net: row.foreignNet,
        trust_net: row.trustNet,
        dealer_net: row.dealerNet,
        inst_net: row.instNet,
        margin_bal: row.marginBal,
        margin_prev: row.marginPrev,
        margin_delta: row.marginDelta,
        short_bal: row.shortBal,
        short_prev: row.shortPrev,
        short_delta: row.shortDelta,
    };
}
