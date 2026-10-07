// server/src/routes/health.ts — /health, /info, /auth/accounts

import type { FastifyInstance } from 'fastify';
import { SERVER_VERSION, type AppContext } from '../context.ts';
import type { Health, ScannerType, ServerInfo } from '../types/dto.ts';
import {
    getFirebaseStatus,
    getAdminInitError,
} from '../lib/research-persistence/admin.ts';
import { hasPrimaryFirebaseCredentials } from '../lib/research-persistence/config.ts';
import {
    measureDisk,
    serverDataDir,
    type DiskUsage,
} from '../lib/data-janitor.ts';
import { readRuntimeTimeline } from '../lib/live-acceptance/runtime-timeline.ts';
import { join } from 'node:path';
import {
    fetchShioajiScanner,
    fetchShioajiSnapshots,
    fetchShioajiUsage,
} from '../providers/shioaji/bridge-scanner.ts';
import { fugleSnapshotSymbols, probeFugleRest, probeFugleWsCap } from '../lib/fugle-plan-probe.ts';
import {
    fetchFugleQueue,
    fuglePreopenRank,
    refreshFuglePrevClose,
} from '../lib/preopen-scan/fugle-preopen.ts';
import { isTradingDay } from '../lib/market-calendar/trading-day.ts';
import { sessionMinuteTaipei, taipeiYmd } from '../lib/shadow/session.ts';

const SECRET_KEY_PATTERN =
    /private[_-]?key|client[_-]?secret|credential|BEGIN (RSA )?PRIVATE/i;

function assertNoSecretLeak(payload: Record<string, unknown>): void {
    const blob = JSON.stringify(payload);
    if (SECRET_KEY_PATTERN.test(blob)) {
        throw new Error('health payload refused: potential secret leak');
    }
}

export function registerHealthRoutes(
    app: FastifyInstance,
    ctx: AppContext,
): void {
    app.get('/api/v1/health', async (): Promise<Health> => {
        const rp = ctx.researchRepos?.getHealth() ?? null;
        return {
            status: 'ok',
            version: SERVER_VERSION,
            timestamp: new Date().toISOString(),
            token_expires_in_seconds: 86_400,
            token_stale: false,
            contract_count: ctx.market.contractCount(),
            next_maintenance: '',
            research_persistence: rp,
        } as Health;
    });

    app.get('/api/v1/research/persistence/health', async () => {
        const rp = ctx.researchRepos?.getHealth();
        if (!rp) {
            return {
                enabled: false,
                research_persistence_available: false,
            };
        }
        return { research_persistence_available: true, ...rp };
    });

    /**
     * Production-safe research persistence status — no secrets.
     * GET /api/v1/system/research-persistence
     */
    app.get('/api/v1/system/research-persistence', async () => {
        const rp = ctx.researchRepos?.getHealth();
        const cfg = ctx.researchRepos?.cfg;
        const mode = rp?.effective_mode ?? cfg?.mode ?? 'jsonl';
        const firebase_configured = hasPrimaryFirebaseCredentials();
        const firebase_status = rp?.firebase_status ?? getFirebaseStatus();
        const latency = rp?.write_latency;
        const payload = {
            mode,
            configured_mode: rp?.configured_mode ?? cfg?.configured_mode ?? 'jsonl',
            primary_repository:
                rp?.primary_repository ??
                (mode === 'firestore'
                    ? 'FIRESTORE'
                    : mode === 'dual'
                      ? 'DUAL'
                      : 'JSONL'),
            firebase_configured,
            firebase_status,
            firestore_connected: rp?.firestore_connected ?? false,
            FIRESTORE_CONFIGURED: firebase_configured,
            FIRESTORE_CONNECTED: rp?.firestore_connected ?? false,
            FIRESTORE_ERROR:
                firebase_status === 'FIREBASE_ERROR'
                    ? (rp?.last_error ?? getAdminInitError())
                    : (rp?.last_error ?? null),
            queue_depth: rp?.queue_depth ?? 0,
            queue_pressure: rp?.queue_pressure ?? 'NORMAL',
            write_success: rp?.write_success_count ?? 0,
            write_failure: rp?.write_failure_count ?? 0,
            last_write_at:
                rp?.last_signal_write_at ?? rp?.last_outcome_write_at ?? null,
            last_write_latency_ms:
                rp?.last_write_latency_ms ?? latency?.max_ms ?? null,
            last_error: rp?.last_error ?? null,
            hydrate_status: rp?.hydrate_status ?? 'IDLE',
            last_hydrate_at: rp?.last_hydrate_at ?? null,
            env_conflict: rp?.env_conflict ?? false,
            status: rp?.status ?? 'UNAVAILABLE',
            write_latency: latency ?? null,
            notification_persistence_backend: 'disk_json',
            secrets_exported: false,
        };
        assertNoSecretLeak(payload as unknown as Record<string, unknown>);
        return payload;
    });

    let diskCache: { at: number; value: DiskUsage } | null = null;
    app.get('/api/v1/system/disk', async () => {
        if (!diskCache || Date.now() - diskCache.at > 60_000) {
            diskCache = { at: Date.now(), value: measureDisk(serverDataDir()) };
        }
        return diskCache.value;
    });

    /** Shioaji data-traffic quota — empty kbars usually means it is exhausted. */
    app.get<{ Querystring: { date?: string; from?: string; to?: string } }>(
        '/api/v1/system/runtime-timeline',
        async (req, reply) => {
            const date = req.query.date ?? '';
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                return reply.code(400).send({ detail: 'date=YYYY-MM-DD required' });
            }
            const tl = await readRuntimeTimeline(
                join(serverDataDir(), 'live-acceptance', `${date}.jsonl`),
            );
            const from = req.query.from ?? '00:00';
            const to = req.query.to ?? '23:59';
            const m = process.memoryUsage();
            const mb = (n: number) => Math.round((n / 1024 / 1024) * 10) / 10;
            return {
                date,
                ...tl,
                minutes: tl.minutes.filter(
                    (x) => x.minute >= from && x.minute <= to,
                ),
                memory_now: {
                    rss_mb: mb(m.rss),
                    heap_used_mb: mb(m.heapUsed),
                    heap_total_mb: mb(m.heapTotal),
                    external_mb: mb(m.external),
                    array_buffers_mb: mb(m.arrayBuffers),
                },
            };
        },
    );

    app.get('/api/v1/system/market-usage', async () => {
        const provider = ctx.market.name();
        if (provider !== 'shioaji') return { provider, available: false };
        try {
            const res = await fetch(`${ctx.config.shioajiBridgeUrl}/usage`, {
                signal: AbortSignal.timeout(10_000),
            });
            const usage = res.ok
                ? ((await res.json()) as Record<string, unknown>)
                : { available: false, error: `bridge HTTP ${res.status}` };
            const payload = {
                provider,
                ...usage,
                quote_guard: ctx.market.quoteGuardStatus(),
            };
            assertNoSecretLeak(payload);
            return payload;
        } catch (err) {
            return {
                provider,
                available: false,
                error: err instanceof Error ? err.name : 'error',
            };
        }
    });

    // Bridge login state regardless of the active provider; probe=1 exercises the
    // same scanner/snapshot calls the pre-open capture uses.
    app.get('/api/v1/system/shioaji-bridge', async (req) => {
        const probe = (req.query as Record<string, string | undefined>).probe === '1';
        const redact = (s: unknown) => {
            if (typeof s !== 'string') return s ?? null;
            let out = s.slice(0, 300);
            for (const v of [process.env.SHIOAJI_API_KEY, process.env.SHIOAJI_SECRET_KEY]) {
                if (v && v.length >= 6) out = out.split(v).join('***');
            }
            return out;
        };
        let health: Record<string, unknown>;
        try {
            const res = await fetch(`${ctx.config.shioajiBridgeUrl}/health`, {
                signal: AbortSignal.timeout(8_000),
            });
            const body = res.ok ? ((await res.json()) as Record<string, unknown>) : null;
            health = body
                ? {
                      reachable: true,
                      logged_in: body.logged_in === true,
                      has_keys: body.has_keys === true,
                      production: body.production === true,
                      login_error: redact(body.login_error),
                      subs: body.subs ?? null,
                  }
                : { reachable: false, error: `bridge HTTP ${res.status}` };
        } catch (err) {
            health = { reachable: false, error: err instanceof Error ? err.name : 'error' };
        }
        const payload: Record<string, unknown> = {
            active_provider: ctx.market.name(),
            checked_at: new Date().toISOString(),
            ...health,
        };
        if (health.reachable) {
            const u = await fetchShioajiUsage();
            const mb = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round((Number(v) / 1048576) * 10) / 10 : null);
            payload.usage = u?.available
                ? {
                      connections: u.connections ?? null,
                      used_mb: mb(u.bytes),
                      limit_mb: mb(u.limit_bytes),
                      remaining_mb: mb(u.remaining_bytes),
                      used_pct:
                          Number(u.limit_bytes) > 0
                              ? Math.round((Number(u.bytes) / Number(u.limit_bytes)) * 1000) / 10
                              : null,
                  }
                : { available: false, error: u?.error ?? 'unreachable' };
        }
        if (probe && health.reachable) {
            const top = async (type: ScannerType, ascending: boolean) => {
                const t = Date.now();
                const rows = await fetchShioajiScanner(type, 3, ascending);
                return {
                    type,
                    ascending,
                    rows: rows.length,
                    ms: Date.now() - t,
                    top: rows.map((r) => ({
                        code: r.code,
                        name: r.name.trim(),
                        date: r.date,
                        close: r.close,
                        change_price: r.change_price,
                        total_volume: r.total_volume,
                        total_amount: r.total_amount,
                    })),
                };
            };
            const scanners = [
                await top('ChangePercentRank', false),
                await top('ChangePercentRank', true),
                await top('VolumeRank', false),
                await top('AmountRank', false),
            ];
            const t1 = Date.now();
            const snap = await fetchShioajiSnapshots(['2330']);
            payload.probe = {
                scanners,
                snapshot_rows: snap.length,
                snapshot_ms: Date.now() - t1,
                snapshot_2330: snap[0]
                    ? {
                          close: snap[0].close,
                          buy_price: snap[0].buy_price,
                          buy_volume: snap[0].buy_volume,
                          total_volume: snap[0].total_volume,
                      }
                    : null,
            };
        }
        assertNoSecretLeak(payload);
        return payload;
    });

    // What the configured Fugle key can do, by real calls. ws=1 opens a separate
    // connection to test the subscription cap; refused during the trading session.
    app.get('/api/v1/system/fugle-plan', async (req, reply) => {
        const key = ctx.runtimeConfig.get().fugleApiKey;
        if (!key) return { has_key: false };
        const q = req.query as Record<string, string | undefined>;
        const quotes = await probeFugleRest(key, '/snapshot/quotes/TSE?type=COMMONSTOCK');
        const movers = await probeFugleRest(
            key,
            '/snapshot/movers/TSE?direction=up&change=percent&type=COMMONSTOCK',
        );
        const actives = await probeFugleRest(key, '/snapshot/actives/TSE?trade=value&type=COMMONSTOCK');
        const intraday = await probeFugleRest(key, '/intraday/quote/2330');
        const payload: Record<string, unknown> = {
            has_key: true,
            checked_at: new Date().toISOString(),
            rest: { quotes, movers, actives, intraday },
        };
        if (q.ws === '1') {
            const now = new Date();
            const sm = sessionMinuteTaipei(now);
            if (isTradingDay(taipeiYmd(now)) && sm >= -60 && sm < 300) {
                return reply.code(409).send({ error: 'market_hours', message: '盤中不做訂閱上限測試，14:00 後再試' });
            }
            const n = Math.min(Math.max(Number(q.n) || 310, 1), 1000);
            const pool = [
                ...(await fugleSnapshotSymbols(key, 'TSE')),
                ...(await fugleSnapshotSymbols(key, 'OTC')),
            ];
            payload.ws = pool.length >= n
                ? await probeFugleWsCap(key, pool.slice(0, n))
                : { error: 'not_enough_symbols', available: pool.length };
        }
        if (q.preopen === '1') {
            const live = await fuglePreopenRank(key, { now: new Date() });
            const mapped = await fuglePreopenRank(key, { ignoreFreshness: true, candidates: 10 });
            const codes = mapped.items.slice(0, 5).map((it) => it.code);
            const nowP = new Date();
            const smP = sessionMinuteTaipei(nowP);
            // Shioaji forbids polling snapshots intraday; compare only outside the session.
            const inSession = isTradingDay(taipeiYmd(nowP)) && smP >= -60 && smP < 300;
            const [fugleQueue, shioajiQueue] = await Promise.all([
                fetchFugleQueue(key, codes, nowP, { ignoreDate: true }),
                inSession ? Promise.resolve([]) : fetchShioajiSnapshots(codes),
            ]);
            payload.preopen = {
                prev_close: await refreshFuglePrevClose(key),
                live_check: live.diag,
                mapping_check: { diag: mapped.diag, top5: mapped.items.slice(0, 5) },
                queue_compare: codes.map((code) => ({
                    code,
                    fugle: fugleQueue.find((r) => r.code === code) ?? null,
                    shioaji: shioajiQueue.find((r) => r.code === code) ?? null,
                })),
            };
        }
        assertNoSecretLeak(payload);
        if (JSON.stringify(payload).includes(key)) throw new Error('fugle probe refused: key in payload');
        return payload;
    });

    app.get('/api/v1/info', async (): Promise<ServerInfo> => ({
        name: 'nova-pro-server',
        version: SERVER_VERSION,
        description:
            'Nova Pro local server — trading via Fubon/Taishin SDK, market data via Fugle',
        protocols: ['http', 'sse'],
        simulation: ctx.market.name() === 'mock',
        capabilities: {
            futures_trading: ctx.trading.capabilities().futures,
        },
    }));

    app.get('/api/v1/auth/accounts', async () => ctx.trading.accounts());
}
