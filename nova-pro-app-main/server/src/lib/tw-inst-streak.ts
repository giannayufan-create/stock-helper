// server/src/lib/tw-inst-streak.ts — consecutive 三大法人 buy/sell days (T+1)

const HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; StockHelper/1.0)',
    Accept: 'application/json,text/plain,*/*',
    Referer: 'https://www.twse.com.tw/',
};

const CACHE_MS = 45 * 60 * 1000;

export interface InstStreakInfo {
    /** Positive = consecutive buy days; negative = consecutive sell days */
    streak: number;
    lastInstNet: number; // shares
    asOf?: string;
    delta: number; // strength nudge
    note?: string;
}

let cache: {
    at: number;
    byCode: Map<string, number[]>; // newest-first inst nets (shares)
    asOf?: string;
} | null = null;
let inflight: Promise<void> | null = null;

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

function parseNum(v: unknown): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'string') return 0;
    const cleaned = v.replace(/,/g, '').replace(/--/g, '').trim();
    if (!cleaned || cleaned === '-') return 0;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
}

function recentWeekdays(max = 8): Date[] {
    const out: Date[] = [];
    const d = new Date();
    for (let i = 1; i < 20 && out.length < max; i++) {
        const t = new Date(d.getTime() - i * 86400000);
        const wd = t.getDay();
        if (wd === 0 || wd === 6) continue;
        out.push(t);
    }
    return out;
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

function fieldIndex(fields: string[], pred: (f: string) => boolean): number {
    for (let i = 0; i < fields.length; i++) {
        if (pred(fields[i] ?? '')) return i;
    }
    return -1;
}

/** Load newest-first inst net series for TWSE (+ best-effort TPEx via same day files). */
async function ensureStreakSeries(): Promise<void> {
    if (cache && Date.now() - cache.at < CACHE_MS) return;
    if (inflight) return inflight;
    inflight = (async () => {
        const byCode = new Map<string, number[]>();
        let asOf: string | undefined;
        for (const d of recentWeekdays(6)) {
            const date = ymd(d);
            const url =
                `https://www.twse.com.tw/rwd/zh/fund/T86?response=json` +
                `&date=${date}&selectType=ALLBUT0999`;
            const payload = await fetchJson(url);
            if (!payload || typeof payload !== 'object') continue;
            const p = payload as {
                fields?: string[];
                data?: unknown[][];
                date?: string;
            };
            if (!Array.isArray(p.fields) || !Array.isArray(p.data) || !p.data.length) {
                continue;
            }
            if (!asOf) asOf = ymdDash(String(p.date ?? date));
            const fields = p.fields.map(String);
            const iCode = fieldIndex(
                fields,
                (f) =>
                    f.includes('證券代號') ||
                    f.includes('股票代號') ||
                    f === '代號',
            );
            const iInst = fieldIndex(
                fields,
                (f) =>
                    f.includes('三大法人買賣超') || f.includes('三大法人合計'),
            );
            const iForeign = fieldIndex(
                fields,
                (f) => f.includes('外陸資買賣超') || f.includes('外資買賣超'),
            );
            const iTrust = fieldIndex(fields, (f) => f.includes('投信買賣超'));
            const iDealer = fieldIndex(
                fields,
                (f) => f.includes('自營商買賣超') && !f.includes('避險'),
            );
            if (iCode < 0) continue;
            for (const row of p.data) {
                if (!Array.isArray(row)) continue;
                const code = String(row[iCode] ?? '')
                    .trim()
                    .replace(/=|"/g, '');
                if (!/^\d{4}$/.test(code)) continue;
                let inst =
                    iInst >= 0
                        ? parseNum(row[iInst])
                        : (iForeign >= 0 ? parseNum(row[iForeign]) : 0) +
                          (iTrust >= 0 ? parseNum(row[iTrust]) : 0) +
                          (iDealer >= 0 ? parseNum(row[iDealer]) : 0);
                const arr = byCode.get(code) ?? [];
                arr.push(inst);
                byCode.set(code, arr);
            }
        }
        cache = { at: Date.now(), byCode, asOf };
        inflight = null;
    })().catch((err) => {
        inflight = null;
        throw err;
    });
    return inflight;
}

function streakFromSeries(nets: number[]): number {
    if (!nets.length) return 0;
    const first = nets[0]!;
    if (first > 50_000) {
        let n = 0;
        for (const v of nets) {
            if (v > 50_000) n += 1;
            else break;
        }
        return n;
    }
    if (first < -50_000) {
        let n = 0;
        for (const v of nets) {
            if (v < -50_000) n += 1;
            else break;
        }
        return -n;
    }
    return 0;
}

export async function getInstStreakMap(
    codes: string[],
): Promise<Map<string, InstStreakInfo>> {
    try {
        await ensureStreakSeries();
    } catch {
        return new Map();
    }
    const out = new Map<string, InstStreakInfo>();
    if (!cache) return out;
    for (const code of codes) {
        const series = cache.byCode.get(code);
        if (!series?.length) continue;
        const streak = streakFromSeries(series);
        const lastInstNet = series[0] ?? 0;
        let delta = 0;
        let note: string | undefined;
        if (streak >= 3) {
            delta = 6;
            note = `法人連買 ${streak} 日`;
        } else if (streak === 2) {
            delta = 3;
            note = `法人連買 2 日`;
        } else if (streak <= -3) {
            delta = -5;
            note = `法人連賣 ${Math.abs(streak)} 日`;
        } else if (streak === -2) {
            delta = -3;
            note = `法人連賣 2 日`;
        }
        out.set(code, {
            streak,
            lastInstNet,
            asOf: cache.asOf,
            delta,
            note,
        });
    }
    return out;
}
