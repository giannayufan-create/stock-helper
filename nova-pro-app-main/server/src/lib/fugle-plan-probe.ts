// Read-only check of what the configured Fugle key can actually do: snapshot
// endpoints (Developer/Advanced only) and the per-connection WebSocket
// subscription cap (Developer 300, Advanced 2000). The key is never returned.
// Protocol: https://developer.fugle.tw/docs/data/websocket-api/getting-started

const REST = 'https://api.fugle.tw/marketdata/v1.0/stock';
const WS = 'wss://api.fugle.tw/marketdata/v1.0/stock/streaming';

export interface RestProbe {
    path: string;
    status: number | null;
    ms: number;
    rate_headers: Record<string, string>;
    date: string | null;
    time: string | null;
    rows: number | null;
    sample: Array<Record<string, unknown>>;
    message: string | null;
    error?: string;
}

export async function probeFugleRest(apiKey: string, path: string): Promise<RestProbe> {
    const t0 = Date.now();
    try {
        const res = await fetch(`${REST}${path}`, {
            headers: { 'X-API-KEY': apiKey },
            signal: AbortSignal.timeout(20_000),
        });
        const rate_headers = Object.fromEntries(
            [...res.headers].filter(([k]) => /rate|limit|quota|remaining|reset|plan/i.test(k)),
        );
        let body: any = null;
        try {
            body = await res.json();
        } catch {
            body = null;
        }
        const data: any[] = Array.isArray(body?.data) ? body.data : [];
        return {
            path,
            status: res.status,
            ms: Date.now() - t0,
            rate_headers,
            date: body?.date ?? null,
            time: body?.time ?? null,
            rows: Array.isArray(body?.data) ? data.length : null,
            sample: data.slice(0, 3).map((r) => ({
                symbol: r.symbol,
                name: r.name,
                closePrice: r.closePrice,
                lastPrice: r.lastPrice,
                change: r.change,
                changePercent: r.changePercent,
                tradeVolume: r.tradeVolume,
                tradeValue: r.tradeValue,
            })),
            message: typeof body?.message === 'string' ? body.message : null,
        };
    } catch (err) {
        return {
            path,
            status: null,
            ms: Date.now() - t0,
            rate_headers: {},
            date: null,
            time: null,
            rows: null,
            sample: [],
            message: null,
            error: err instanceof Error ? err.name : 'error',
        };
    }
}

export async function fugleSnapshotSymbols(apiKey: string, market: 'TSE' | 'OTC'): Promise<string[]> {
    try {
        const res = await fetch(`${REST}/snapshot/quotes/${market}?type=COMMONSTOCK`, {
            headers: { 'X-API-KEY': apiKey },
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return [];
        const body: any = await res.json();
        return Array.isArray(body?.data) ? body.data.map((r: any) => String(r.symbol)).filter(Boolean) : [];
    } catch {
        return [];
    }
}

export interface WsProbe {
    requested: number;
    authenticated: boolean;
    subscribed_acks: number;
    subscriptions_listed: number | null;
    errors: string[];
    closed_by_server: { code: number; reason: string } | null;
    ms: number;
}

/** Opens a separate connection, subscribes `symbols` to trades, lists subscriptions, disconnects. */
export function probeFugleWsCap(apiKey: string, symbols: readonly string[], timeoutMs = 25_000): Promise<WsProbe> {
    const t0 = Date.now();
    const out: WsProbe = {
        requested: symbols.length,
        authenticated: false,
        subscribed_acks: 0,
        subscriptions_listed: null,
        errors: [],
        closed_by_server: null,
        ms: 0,
    };
    return new Promise((resolve) => {
        let done = false;
        let listTimer: ReturnType<typeof setTimeout> | null = null;
        const ws = new WebSocket(WS);
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(hardStop);
            if (listTimer) clearTimeout(listTimer);
            try {
                ws.close();
            } catch {
                /* already closed */
            }
            out.ms = Date.now() - t0;
            resolve(out);
        };
        const hardStop = setTimeout(finish, timeoutMs);
        const scheduleList = () => {
            if (listTimer) clearTimeout(listTimer);
            listTimer = setTimeout(() => ws.send(JSON.stringify({ event: 'subscriptions' })), 4_000);
        };
        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ event: 'auth', data: { apikey: apiKey } }));
        });
        ws.addEventListener('message', (ev) => {
            let msg: any;
            try {
                msg = JSON.parse(String(ev.data));
            } catch {
                return;
            }
            if (msg?.event === 'authenticated') {
                out.authenticated = true;
                for (let i = 0; i < symbols.length; i += 100) {
                    ws.send(
                        JSON.stringify({
                            event: 'subscribe',
                            data: { channel: 'trades', symbols: symbols.slice(i, i + 100) },
                        }),
                    );
                }
                scheduleList();
            } else if (msg?.event === 'subscribed') {
                out.subscribed_acks += Array.isArray(msg.data) ? msg.data.length : 1;
                scheduleList();
            } else if (msg?.event === 'error') {
                const m = String(msg?.data?.message ?? JSON.stringify(msg.data ?? ''));
                if (out.errors.length < 5 && !out.errors.includes(m)) out.errors.push(m.slice(0, 200));
            } else if (msg?.event === 'subscriptions') {
                out.subscriptions_listed = Array.isArray(msg.data) ? msg.data.length : 0;
                finish();
            }
        });
        ws.addEventListener('close', (ev) => {
            if (!done) out.closed_by_server = { code: ev.code, reason: String(ev.reason ?? '').slice(0, 200) };
            finish();
        });
        ws.addEventListener('error', () => {
            if (out.errors.length < 5) out.errors.push('websocket error');
        });
    });
}
