// server/src/routes/health.ts — /health, /info, /auth/accounts

import type { FastifyInstance } from 'fastify';
import { SERVER_VERSION, type AppContext } from '../context.ts';
import type { Health, ServerInfo } from '../types/dto.ts';

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
        return {
            mode: rp?.effective_mode ?? cfg?.mode ?? 'jsonl',
            configured_mode: rp?.configured_mode ?? cfg?.configured_mode ?? 'jsonl',
            firebase_configured: Boolean(
                process.env.FIREBASE_PROJECT_ID &&
                    process.env.FIREBASE_CLIENT_EMAIL &&
                    process.env.FIREBASE_PRIVATE_KEY,
            ),
            FIRESTORE_CONFIGURED: Boolean(
                process.env.FIREBASE_PROJECT_ID &&
                    process.env.FIREBASE_CLIENT_EMAIL &&
                    process.env.FIREBASE_PRIVATE_KEY,
            ),
            firestore_connected: rp?.firestore_connected ?? false,
            FIRESTORE_CONNECTED: rp?.firestore_connected ?? false,
            FIRESTORE_ERROR: rp?.last_error ?? null,
            queue_depth: rp?.queue_depth ?? 0,
            write_success: rp?.write_success_count ?? 0,
            write_failure: rp?.write_failure_count ?? 0,
            last_write_at:
                rp?.last_signal_write_at ?? rp?.last_outcome_write_at ?? null,
            last_error: rp?.last_error ?? null,
            env_conflict: rp?.env_conflict ?? false,
            status: rp?.status ?? 'UNAVAILABLE',
            notification_persistence_backend: 'disk_json',
            secrets_exported: false,
        };
    });

    app.get('/api/v1/info', async (): Promise<ServerInfo> => ({
        name: 'nova-pro-server',
        version: SERVER_VERSION,
        description:
            'Nova Pro local server — trading via Fubon/Taishin SDK, market data via Fugle',
        protocols: ['http', 'sse'],
        simulation:
            ctx.config.tradeProvider === 'mock' ||
            ctx.market.name() === 'mock',
        capabilities: {
            futures_trading: ctx.trading.capabilities().futures,
        },
    }));

    app.get('/api/v1/auth/accounts', async () => ctx.trading.accounts());
}
