// server/src/routes/notifications.ts — Web Notification Center APIs

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

function parseBool(v: unknown): boolean | undefined {
    if (v == null || v === '') return undefined;
    if (v === 'true' || v === true) return true;
    if (v === 'false' || v === false) return false;
    return undefined;
}

export function registerNotificationRoutes(
    app: FastifyInstance,
    ctx: AppContext,
) {
    const wn = () => ctx.webNotifications;

    app.get('/api/v1/notifications', async (req, reply) => {
        const svc = wn();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const q = req.query as Record<string, string | undefined>;
        return {
            items: svc.list({
                unread: parseBool(q.unread),
                event_type: q.event_type,
                symbol: q.symbol,
                limit: q.limit != null ? Number(q.limit) : 30,
                since: q.since,
            }),
            unread_count: svc.unreadCount(),
            preferences: svc.getPreferences(),
        };
    });

    app.get('/api/v1/notifications/unread-count', async (_req, reply) => {
        const svc = wn();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        return { unread_count: svc.unreadCount() };
    });

    app.get('/api/v1/notifications/preferences', async (_req, reply) => {
        const svc = wn();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        return svc.getPreferences();
    });

    app.put('/api/v1/notifications/preferences', async (req, reply) => {
        const svc = wn();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const body = (req.body ?? {}) as Record<string, unknown>;
        return svc.setPreferences(body);
    });

    app.post<{ Params: { id: string } }>(
        '/api/v1/notifications/:id/read',
        async (req, reply) => {
            const svc = wn();
            if (!svc) return reply.code(503).send({ error: 'disabled' });
            const ok = svc.markRead(req.params.id);
            if (!ok) return reply.code(404).send({ error: 'not_found' });
            return { ok: true, unread_count: svc.unreadCount() };
        },
    );

    app.post('/api/v1/notifications/mark-all-read', async (_req, reply) => {
        const svc = wn();
        if (!svc) return reply.code(503).send({ error: 'disabled' });
        const marked = svc.markAllRead();
        return { ok: true, marked, unread_count: 0 };
    });
}
