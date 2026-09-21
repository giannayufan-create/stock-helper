// FinMind daily TaiwanStockPrice — one request per calendar day (quota-friendly).

import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DailyBar } from './types.ts';

const FINMIND_BASE = 'https://api.finmindtrade.com/api/v4/data';

export function resolveFinMindToken(): string | null {
    const t =
        process.env.FINMIND_KEY?.trim() ||
        process.env.FINMIND_TOKEN?.trim() ||
        '';
    return t || null;
}

function defaultCacheRoot(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, '..', '..', '..', 'data', 'board-attack', 'prices');
}

interface FinMindPriceRow {
    date?: string;
    stock_id?: string;
    open?: number | string;
    max?: number | string;
    min?: number | string;
    close?: number | string;
    Trading_Volume?: number | string;
    Trading_money?: number | string;
}

function num(v: unknown): number {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v !== 'string') return 0;
    const n = Number(v.replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
}

export function parseFinMindPriceRows(
    rows: FinMindPriceRow[],
    ymd: string,
): DailyBar[] {
    const out: DailyBar[] = [];
    for (const r of rows) {
        const symbol = String(r.stock_id ?? '').trim();
        if (!/^[1-9]\d{3}$/.test(symbol)) continue; // skip ETF 00xx / warrants
        const open = num(r.open);
        const high = num(r.max);
        const low = num(r.min);
        const close = num(r.close);
        if (!(close > 0) || !(open > 0)) continue;
        out.push({
            date: String(r.date ?? ymd).slice(0, 10),
            symbol,
            open,
            high,
            low,
            close,
            volume: num(r.Trading_Volume),
            amount: r.Trading_money != null ? num(r.Trading_money) : null,
        });
    }
    return out;
}

export class FinMindDailyPriceStore {
    private root: string;
    private token: string | null;
    private fetchImpl: typeof fetch;

    constructor(
        opts: {
            cacheRoot?: string;
            token?: string | null;
            fetchImpl?: typeof fetch;
        } = {},
    ) {
        this.root = opts.cacheRoot ?? defaultCacheRoot();
        this.token =
            opts.token !== undefined ? opts.token : resolveFinMindToken();
        this.fetchImpl = opts.fetchImpl ?? fetch;
        if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true });
    }

    cachePath(ymd: string): string {
        return join(this.root, `${ymd}.json`);
    }

    loadCached(ymd: string): DailyBar[] | null {
        const p = this.cachePath(ymd);
        if (!existsSync(p)) return null;
        try {
            const raw = JSON.parse(readFileSync(p, 'utf8')) as FinMindPriceRow[];
            return parseFinMindPriceRows(raw, ymd);
        } catch {
            return null;
        }
    }

    saveCache(ymd: string, raw: FinMindPriceRow[]): void {
        writeFileSync(this.cachePath(ymd), JSON.stringify(raw), 'utf8');
    }

    async fetchDay(ymd: string): Promise<DailyBar[]> {
        const cached = this.loadCached(ymd);
        if (cached) return cached;
        if (!this.token) {
            throw new Error(
                'FINMIND_KEY / FINMIND_TOKEN missing and no cache for ' + ymd,
            );
        }
        const url = new URL(FINMIND_BASE);
        url.searchParams.set('dataset', 'TaiwanStockPrice');
        url.searchParams.set('start_date', ymd);
        url.searchParams.set('end_date', ymd);
        const res = await this.fetchImpl(url.toString(), {
            headers: { Authorization: `Bearer ${this.token}` },
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(
                `FinMind ${res.status} for ${ymd}: ${text.slice(0, 200)}`,
            );
        }
        const body = (await res.json()) as {
            msg?: string;
            data?: FinMindPriceRow[];
        };
        if (body.msg && body.msg !== 'success' && !body.data?.length) {
            throw new Error(`FinMind msg=${body.msg} for ${ymd}`);
        }
        const raw = body.data ?? [];
        this.saveCache(ymd, raw);
        return parseFinMindPriceRows(raw, ymd);
    }
}
