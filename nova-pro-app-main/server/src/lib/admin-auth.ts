// server/src/lib/admin-auth.ts
// Shared-secret guard for operator-only mutations (header x-admin-token vs env ADMIN_TOKEN).
// Without ADMIN_TOKEN, only direct loopback requests (no proxy headers) are allowed.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const ADMIN_TOKEN_HEADER = 'x-admin-token';

export type AdminCheck =
    | { ok: true }
    | { ok: false; status: 401 | 403; detail: string };

function digest(s: string): Buffer {
    return createHash('sha256').update(s, 'utf8').digest();
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function checkAdmin(input: {
    headers: Record<string, string | string[] | undefined>;
    remoteAddress: string | undefined;
    adminToken: string | undefined;
}): AdminCheck {
    const expected = input.adminToken?.trim();
    if (expected) {
        const raw = input.headers[ADMIN_TOKEN_HEADER];
        const given = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
        if (given && timingSafeEqual(digest(given), digest(expected))) {
            return { ok: true };
        }
        return { ok: false, status: 401, detail: '管理密碼錯誤或未提供' };
    }
    const proxied =
        input.headers['x-forwarded-for'] != null ||
        input.headers['cf-connecting-ip'] != null ||
        input.headers['true-client-ip'] != null;
    if (!proxied && input.remoteAddress && LOOPBACK.has(input.remoteAddress)) {
        return { ok: true };
    }
    return {
        ok: false,
        status: 403,
        detail: '伺服器未設定 ADMIN_TOKEN，已停用遠端修改此設定',
    };
}

/** Fastify preHandler: rejects unless the request passes checkAdmin. */
export async function requireAdmin(
    req: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    const res = checkAdmin({
        headers: req.headers,
        remoteAddress: req.socket.remoteAddress,
        adminToken: process.env.ADMIN_TOKEN,
    });
    if (!res.ok) {
        await reply.code(res.status).send({ detail: res.detail });
    }
}
