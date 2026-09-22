// server/src/routes/health.ts — /health, /info, /auth/accounts

import type { FastifyInstance } from 'fastify';
import { SERVER_VERSION, type AppContext } from '../context.ts';
import type { Health, ServerInfo } from '../types/dto.ts';
import {
    getFirebaseStatus,
    getAdminInitError,
} from '../lib/research-persistence/admin.ts';
import { hasPrimaryFirebaseCredentials } from '../lib/research-persistence/config.ts';

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
