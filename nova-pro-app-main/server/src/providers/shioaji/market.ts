// server/src/providers/shioaji/market.ts — Sinopac Shioaji via local Python bridge
// Bridge: SHIOAJI_BRIDGE_URL (default http://127.0.0.1:18080)
// Keys live in cloud env (SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY); bridge logs in.

import type {
    ContractInfo,
    CreditEnquire,
    HistoryTicks,
    KBars,
    OptContract,
    ScannerItem,
    ScannerType,
    SecurityType,
    ShortSource,
    Snapshot,
    SseBidAsk,
    SseTick,
} from '../../types/dto.ts';
import type {
    BidAskChannel,
    ContractKey,
    MarketDataProvider,
    StreamQuoteType,
    TickChannel,
} from '../market-data.ts';
import { bidaskChannelFor, tickChannelFor } from '../market-data.ts';
import { fetchRegulatoryLists } from '../fugle/regulatory.ts';
import { fetchTwOvernightPool } from '../../lib/tw-overnight-pool.ts';

const DEFAULT_BRIDGE =
    process.env.SHIOAJI_BRIDGE_URL?.replace(/\/$/, '') ||
    'http://127.0.0.1:18080';

function todayTaipei(): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

function splitIso(iso: string): { date: string; time: string } {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
        const t = todayTaipei();
        return { date: t, time: '00:00:00.000000' };
    }
    const date = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
    const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Taipei',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).format(d);
    return { date, time: `${time}.000000` };
}

export class ShioajiMarketDataProvider implements MarketDataProvider {
    private bridge = DEFAULT_BRIDGE;
    private lastPrices = new Map<string, number>();
    private names = new Map<string, string>();
    private tickCbs: ((ch: TickChannel, t: SseTick) => void)[] = [];
    private bidaskCbs: ((ch: BidAskChannel, b: SseBidAsk) => void)[] = [];
    private disposed = false;
    private abort: AbortController | null = null;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private subs = new Map<string, Set<StreamQuoteType>>();

    async init(): Promise<void> {
        const health = await this.getJson<{
            logged_in?: boolean;
            detail?: string;
            has_keys?: boolean;
        }>('/health');
        if (!health.has_keys) {
            throw new Error(
                'Shioaji bridge 未設定 SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY',
            );
        }
        if (!health.logged_in) {
            // force login by calling search
            await this.getJson('/search?q=2330');
        }
        this.startEventPump();
        // REST poll fallback for subscribed symbols (in case SSE gaps)
        this.pollTimer = setInterval(() => {
            void this.pollSubscribed();
        }, 8000);
    }

    contractCount(): number {
        return this.names.size || 1;
    }

    private async getJson<T>(path: string): Promise<T> {
        const res = await fetch(`${this.bridge}${path}`, {
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`shioaji ${path}: ${res.status} ${text.slice(0, 200)}`);
        }
        return (await res.json()) as T;
    }

    private async postJson<T>(path: string, body: unknown): Promise<T> {
        const res = await fetch(`${this.bridge}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`shioaji ${path}: ${res.status} ${text.slice(0, 200)}`);
        }
        return (await res.json()) as T;
    }

    async resolveContract(
        code: string,
        type: SecurityType,
    ): Promise<ContractInfo | null> {
        if (type !== 'STK') return null;
        try {
            const c = await this.getJson<ContractInfo>(
                `/contracts/${encodeURIComponent(code)}?security_type=STK`,
            );
            if (c?.name) this.names.set(c.code, c.name);
            return c;
        } catch {
            return null;
        }
    }

    async searchSymbols(
        q: string,
    ): Promise<Array<{ code: string; name: string }>> {
        const res = await this.getJson<{ hits: Array<{ code: string; name: string }> }>(
            `/search?q=${encodeURIComponent(q)}`,
        );
        for (const h of res.hits ?? []) {
            if (h.name) this.names.set(h.code, h.name);
        }
        return res.hits ?? [];
    }

    async listOptionContracts(): Promise<OptContract[]> {
        return [];
    }

    async snapshots(keys: ContractKey[]): Promise<Snapshot[]> {
        const contracts = keys
            .filter(
                (k) =>
                    k.security_type === 'STK' || k.security_type === 'FUT',
            )
            .map((k) => ({
                security_type: k.security_type,
                exchange:
                    k.exchange ??
                    (k.security_type === 'FUT' ? 'TAIFEX' : 'TSE'),
                code: k.code,
            }));
        if (!contracts.length) return [];
        const rows = await this.postJson<Snapshot[]>('/snapshots', {
            contracts,
        });
        for (const s of rows) {
            if (s.close > 0) this.lastPrices.set(s.code, s.close);
        }
        return rows;
    }

    async kbars(key: ContractKey, start: string, end: string): Promise<KBars> {
        return this.postJson<KBars>('/kbars', {
            contract: {
                security_type: key.security_type,
                exchange: key.exchange ?? 'TSE',
                code: key.code,
            },
            start,
            end,
        });
    }

    async ticks(
        key: ContractKey,
        date: string,
        lastCount?: number,
    ): Promise<HistoryTicks> {
        const raw = await this.postJson<{
            date: string;
            datetime: string[];
            close: number[];
            volume: number[];
            bid_price?: number[];
            ask_price?: number[];
        }>('/ticks', {
            contract: {
                security_type: key.security_type,
                exchange: key.exchange ?? 'TSE',
                code: key.code,
            },
            date,
            last_cnt: lastCount,
        });
        return {
            datetime: raw.datetime,
            close: raw.close,
            volume: raw.volume,
            bid_price: raw.bid_price ?? [],
            bid_volume: [],
            ask_price: raw.ask_price ?? [],
            ask_volume: [],
            tick_type: [],
        };
    }

    async scanner(
        type: ScannerType,
        count: number,
        ascending: boolean,
    ): Promise<ScannerItem[]> {
        try {
            const rows = await this.postJson<ScannerItem[]>('/scanner', {
                scanner_type: type,
                count,
                ascending,
            });
            if (rows?.length) return rows;
        } catch (err) {
            console.warn(
                'shioaji scanner failed:',
                err instanceof Error ? err.message : err,
            );
        }
        return fetchTwOvernightPool(type, count);
    }

    async creditEnquire(_keys: ContractKey[]): Promise<CreditEnquire[]> {
        return [];
    }

    async shortStockSources(_keys: ContractKey[]): Promise<ShortSource[]> {
        return [];
    }

    async regulatoryPunish(): Promise<{ code: string[]; attention: string[] }> {
        return fetchRegulatoryLists();
    }

    async subscribe(key: ContractKey, quote: StreamQuoteType): Promise<void> {
        // Bridge is equity-only for now — skip futures/options/warrants quietly.
        if (key.security_type !== 'STK') return;
        const code = key.code.trim();
        if (!/^\d{4,6}$/.test(code)) return;

        const set = this.subs.get(code) ?? new Set();
        if (set.has(quote)) return;
        set.add(quote);
        this.subs.set(code, set);
        try {
            await this.postJson('/subscribe', {
                security_type: key.security_type,
                exchange: key.exchange ?? 'TSE',
                code,
                quote_type: quote,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Unknown code (warrant/ETF edge) — drop and keep going.
            if (/404|找不到商品/.test(msg)) {
                set.delete(quote);
                if (!set.size) this.subs.delete(code);
                return;
            }
            console.warn('shioaji subscribe:', msg);
        }
    }

    async unsubscribe(key: ContractKey, quote: StreamQuoteType): Promise<void> {
        const set = this.subs.get(key.code);
        if (!set?.has(quote)) return;
        set.delete(quote);
        if (!set.size) this.subs.delete(key.code);
        try {
            await this.postJson('/unsubscribe', {
                security_type: key.security_type,
                exchange: key.exchange ?? 'TSE',
                code: key.code,
                quote_type: quote,
            });
        } catch {
            // ignore
        }
    }

    onTick(cb: (channel: TickChannel, tick: SseTick) => void): void {
        this.tickCbs.push(cb);
    }

    onBidAsk(cb: (channel: BidAskChannel, bidask: SseBidAsk) => void): void {
        this.bidaskCbs.push(cb);
    }

    lastPrice(code: string): number | undefined {
        return this.lastPrices.get(code);
    }

    displayName(code: string): string | undefined {
        return this.names.get(code);
    }

    aliasTarget(_code: string): string | undefined {
        return undefined;
    }

    dispose(): void {
        this.disposed = true;
        this.abort?.abort();
        this.abort = null;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private startEventPump(): void {
        this.abort = new AbortController();
        const signal = this.abort.signal;
        void (async () => {
            while (!this.disposed) {
                try {
                    const res = await fetch(`${this.bridge}/events`, {
                        signal,
                        headers: { Accept: 'text/event-stream' },
                    });
                    if (!res.ok || !res.body) {
                        await sleep(2000);
                        continue;
                    }
                    const reader = res.body.getReader();
                    const dec = new TextDecoder();
                    let buf = '';
                    while (!this.disposed) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buf += dec.decode(value, { stream: true });
                        const parts = buf.split('\n\n');
                        buf = parts.pop() ?? '';
                        for (const chunk of parts) {
                            const line = chunk
                                .split('\n')
                                .find((l) => l.startsWith('data:'));
                            if (!line) continue;
                            const raw = line.slice(5).trim();
                            if (!raw) continue;
                            try {
                                this.handleBridgeEvent(
                                    JSON.parse(raw) as Record<string, unknown>,
                                );
                            } catch {
                                // ignore bad event
                            }
                        }
                    }
                } catch {
                    if (this.disposed) return;
                    await sleep(2000);
                }
            }
        })();
    }

    private handleBridgeEvent(ev: Record<string, unknown>): void {
        if (ev.type !== 'quote') return;
        const topic = String(ev.topic ?? '');
        const quote = (ev.quote ?? {}) as Record<string, unknown>;
        // Topics look like: QUT/id/TSE/2330 or MKT/... or BIDASK/...
        const codeMatch = topic.match(/\/(\d{4,6})(?:\/|$)/) || [];
        const code =
            String(quote.code ?? quote.Code ?? codeMatch[1] ?? '').trim();
        if (!code) return;

        const close = Number(
            quote.close ?? quote.Close ?? quote.price ?? quote.last_price ?? 0,
        );
        if (close > 0) this.lastPrices.set(code, close);

        const isBidAsk =
            /bidask|bid_ask|BO\/|QUOTE/i.test(topic) ||
            Array.isArray(quote.bid_price) ||
            Array.isArray(quote.BidPrice);

        const key: ContractKey = {
            security_type: 'STK',
            exchange: topic.includes('OTC') ? 'OTC' : 'TSE',
            code,
        };
        const { date, time } = splitIso(
            String(quote.datetime ?? quote.ts ?? new Date().toISOString()),
        );

        if (isBidAsk) {
            const bidPrices = toStrArr(
                quote.bid_price ?? quote.BidPrice ?? quote.bid_price,
            );
            const askPrices = toStrArr(
                quote.ask_price ?? quote.AskPrice ?? quote.ask_price,
            );
            const bidVol = toNumArr(
                quote.bid_volume ?? quote.BidVolume ?? quote.bid_volume,
            );
            const askVol = toNumArr(
                quote.ask_volume ?? quote.AskVolume ?? quote.ask_volume,
            );
            const ba: SseBidAsk = {
                code,
                date,
                time,
                bid_price: bidPrices,
                bid_volume: bidVol,
                ask_price: askPrices,
                ask_volume: askVol,
            };
            const ch = bidaskChannelFor(key);
            for (const cb of this.bidaskCbs) cb(ch, ba);
            return;
        }

        if (!(close > 0)) return;
        const tick: SseTick = {
            code,
            date,
            time,
            open: String(quote.open ?? close),
            high: String(quote.high ?? close),
            low: String(quote.low ?? close),
            close: String(close),
            volume: Number(quote.volume ?? 0) || 0,
            total_volume: Number(quote.total_volume ?? quote.volume ?? 0) || 0,
            tick_type: 0,
        };
        const ch = tickChannelFor(key);
        for (const cb of this.tickCbs) cb(ch, tick);
    }

    private async pollSubscribed(): Promise<void> {
        const codes = [...this.subs.keys()].slice(0, 40);
        if (!codes.length) return;
        try {
            const snaps = await this.snapshots(
                codes.map((code) => ({
                    security_type: 'STK' as const,
                    exchange: 'TSE',
                    code,
                })),
            );
            for (const s of snaps) {
                if (!(s.close > 0)) continue;
                const { date, time } = splitIso(s.datetime);
                const tick: SseTick = {
                    code: s.code,
                    date,
                    time,
                    open: String(s.open),
                    high: String(s.high),
                    low: String(s.low),
                    close: String(s.close),
                    volume: s.volume,
                    total_volume: s.total_volume,
                    tick_type: 0,
                };
                for (const cb of this.tickCbs) cb('tick_stk', tick);
            }
        } catch {
            // ignore poll errors
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function toStrArr(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x ?? ''));
}

function toNumArr(v: unknown): number[] {
    if (!Array.isArray(v)) return [];
    return v.map((x) => Number(x) || 0);
}
