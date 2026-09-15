// server/src/routes/config.ts — runtime market-source settings.
// Fugle key can be pasted from UI; Shioaji keys are cloud-env only.

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { FugleMarketDataProvider } from '../providers/fugle/market.ts';
import { MockMarketDataProvider } from '../providers/mock/market.ts';
import { ShioajiMarketDataProvider } from '../providers/shioaji/market.ts';

export function registerConfigRoutes(
    app: FastifyInstance,
    ctx: AppContext,
): void {
    app.get('/api/v1/config/market', async () => ({
        provider: ctx.market.name(),
        has_key: Boolean(ctx.runtimeConfig.get().fugleApiKey),
        has_shioaji: Boolean(
            ctx.config.shioajiApiKey && ctx.config.shioajiSecretKey,
        ),
    }));

    app.post<{
        Body: { api_key?: string; provider?: 'mock' | 'fugle' | 'shioaji' };
    }>('/api/v1/config/market', async (req, reply) => {
        const apiKey = req.body?.api_key?.trim();
        const provider = req.body?.provider;

        if (provider === 'mock') {
            const mock = new MockMarketDataProvider();
            await mock.init();
            await ctx.market.swap(mock, 'mock');
            ctx.runtimeConfig.set({ marketProvider: 'mock' });
            return { provider: 'mock' as const };
        }

        if (provider === 'shioaji') {
            if (!ctx.config.shioajiApiKey || !ctx.config.shioajiSecretKey) {
                return reply.code(400).send({
                    detail:
                        '永豐行情請在雲端設定 SHIOAJI_API_KEY / SHIOAJI_SECRET_KEY（不支援前端貼上）',
                });
            }
            process.env.SHIOAJI_API_KEY = ctx.config.shioajiApiKey;
            process.env.SHIOAJI_SECRET_KEY = ctx.config.shioajiSecretKey;
            const shioaji = new ShioajiMarketDataProvider();
            try {
                await shioaji.init();
            } catch (err) {
                return reply.code(400).send({
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
            await ctx.market.swap(shioaji, 'shioaji');
            ctx.runtimeConfig.set({ marketProvider: 'shioaji' });
            return { provider: 'shioaji' as const };
        }

        const key = apiKey || ctx.runtimeConfig.get().fugleApiKey;
        if (!key) {
            return reply.code(400).send({ detail: '請提供 Fugle API Key' });
        }
        const fugle = new FugleMarketDataProvider(key);
        try {
            await fugle.init();
        } catch (err) {
            return reply.code(400).send({
                detail: err instanceof Error ? err.message : String(err),
            });
        }
        const wsError = await fugle.probeWebSocket();
        await ctx.market.swap(fugle, 'fugle');
        ctx.runtimeConfig.set({ marketProvider: 'fugle', fugleApiKey: key });
        return {
            provider: 'fugle' as const,
            ...(wsError
                ? {
                      warning: `WebSocket 即時推送不可用（${wsError}）— 已降級為 REST 輪詢模式，報價約每 10 秒更新`,
                  }
                : {}),
        };
    });
}
