// server/src/routes/data.ts — contracts, snapshots, kbars, ticks, scanner,
// chips (credit/short/punish) + TWSE/TPEx 法人融資券

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import type { ContractKey } from '../providers/market-data.ts';
import type { ScannerType, SecurityType } from '../types/dto.ts';
import { scoreChips, screenerChipsDelta } from '../ai/chips-signal.ts';
import {
    overnightEdgeDto,
    overnightEdgeForCode,
    overnightEdgeForCodes,
} from '../ai/overnight-edge.ts';
import {
    buildMoneyFlowRank,
    moneyFlowRowDto,
    type MoneyFlowMode,
} from '../lib/tw-money-flow.ts';
import {
    chipRowToDto,
    ensureTwChipsLoaded,
    getChipRow,
    getChipRows,
} from '../lib/tw-chips.ts';
import { fetchTwDailyBarsBatch } from '../lib/tw-daily-bars.ts';
import {
    settleBatch,
    type SettleInput,
} from '../lib/prediction-settle.ts';

interface ContractsQuery {
    security_type?: string;
}

export function registerDataRoutes(
    app: FastifyInstance,
    ctx: AppContext,
): void {
    app.get<{ Querystring: { q?: string } }>(
        '/api/v1/data/search',
        async (req) => {
            const q = (req.query.q ?? '').trim();
            if (!q) return { hits: [] };
            const hits = await ctx.market.searchSymbols(q);
            return { hits };
        },
    );

    app.get<{ Params: { code: string }; Querystring: ContractsQuery }>(
        '/api/v1/data/contracts/:code',
        async (req, reply) => {
            const type = (req.query.security_type || 'STK') as SecurityType;
            const contract = await ctx.market.resolveContract(
                req.params.code,
                type,
            );
            if (!contract) {
                return reply
                    .code(404)
                    .send({ detail: `contract not found: ${req.params.code}` });
            }
            return contract;
        },
    );

    app.post<{ Body: { security_type?: string; page?: number } }>(
        '/api/v1/data/contracts',
        async (req, reply) => {
            if (req.body?.security_type !== 'OPT') {
                return reply.code(400).send({
                    detail: 'only security_type=OPT listing is supported',
                });
            }
            return { contracts: await ctx.market.listOptionContracts() };
        },
    );

    app.post<{ Body: { contracts?: ContractKey[] } }>(
        '/api/v1/data/snapshots',
        async (req) => ctx.market.snapshots(req.body?.contracts ?? []),
    );

    app.post<{
        Body: { contract: ContractKey; start: string; end: string };
    }>('/api/v1/data/kbars', async (req) =>
        ctx.market.kbars(req.body.contract, req.body.start, req.body.end),
    );

    app.post<{
        Body: {
            contract: ContractKey;
            date: string;
            query_type?: string;
            last_cnt?: number;
        };
    }>('/api/v1/data/ticks', async (req) =>
        ctx.market.ticks(
            req.body.contract,
            req.body.date,
            req.body.query_type === 'LastCount' ? req.body.last_cnt : undefined,
        ),
    );

    app.post<{
        Body: {
            scanner_type: ScannerType;
            count?: number;
            ascending?: boolean;
        };
    }>('/api/v1/data/scanner', async (req) =>
        ctx.market.scanner(
            req.body.scanner_type,
            req.body.count ?? 30,
            req.body.ascending ?? false,
        ),
    );

    app.post<{ Body: { contracts?: ContractKey[] } }>(
        '/api/v1/data/credit_enquire',
        async (req) => ctx.market.creditEnquire(req.body?.contracts ?? []),
    );

    app.post<{ Body: { contracts?: ContractKey[] } }>(
        '/api/v1/data/short_stock_sources',
        async (req) => ctx.market.shortStockSources(req.body?.contracts ?? []),
    );

    app.get('/api/v1/data/regulatory_punish', async () =>
        ctx.market.regulatoryPunish(),
    );

    /** 三大法人＋融資券公開籌碼（TWSE/TPEx，通常 T+1） */
    app.get<{ Params: { code: string } }>(
        '/api/v1/data/chips/:code',
        async (req) => {
            const code = req.params.code.trim();
            const row = await getChipRow(code);
            const signal = scoreChips(row);
            return {
                code,
                row: row ? chipRowToDto(row) : null,
                signal: {
                    available: signal.available,
                    bias: signal.bias,
                    label: signal.label,
                    summary: signal.summary,
                    score_adj: signal.scoreAdj,
                    strength_delta: screenerChipsDelta(signal),
                    as_of: signal.asOf,
                    notes: signal.notes,
                },
            };
        },
    );

    app.get<{ Querystring: { codes?: string } }>(
        '/api/v1/data/chips',
        async (req) => {
            const raw = (req.query.codes ?? '').trim();
            if (!raw) {
                const bundle = await ensureTwChipsLoaded();
                return {
                    as_of: bundle.asOf,
                    count: bundle.byCode.size,
                    items: Object.fromEntries(
                        [...bundle.byCode.entries()].map(([code, row]) => {
                            const signal = scoreChips(row);
                            return [
                                code,
                                {
                                    ...chipRowToDto(row),
                                    bias: signal.bias,
                                    label: signal.label,
                                    score_adj: signal.scoreAdj,
                                    strength_delta: screenerChipsDelta(signal),
                                },
                            ];
                        }),
                    ),
                };
            }
            const codes = raw
                .split(/[,|\s]+/)
                .map((c) => c.trim())
                .filter(Boolean)
                .slice(0, 80);
            const { asOf, rows } = await getChipRows(codes);
            const items: Record<string, unknown> = {};
            for (const row of rows) {
                const signal = scoreChips(row);
                items[row.code] = {
                    ...chipRowToDto(row),
                    bias: signal.bias,
                    label: signal.label,
                    score_adj: signal.scoreAdj,
                    strength_delta: screenerChipsDelta(signal),
                    summary: signal.summary,
                };
            }
            return { as_of: asOf, count: Object.keys(items).length, items };
        },
    );

    /** 隔夜收盤→次日開盤 歷史勝率（近半年日K規則） */
    app.get<{ Params: { code: string } }>(
        '/api/v1/data/overnight-edge/:code',
        async (req) => {
            const code = req.params.code.trim();
            const report = await overnightEdgeForCode(code);
            return overnightEdgeDto(report);
        },
    );

    app.get<{ Querystring: { codes?: string } }>(
        '/api/v1/data/overnight-edge',
        async (req, reply) => {
            const raw = (req.query.codes ?? '').trim();
            if (!raw) {
                return reply
                    .code(400)
                    .send({ error: 'codes query required, e.g. ?codes=2330,2317' });
            }
            const codes = raw
                .split(/[,|\s]+/)
                .map((c) => c.trim())
                .filter(Boolean)
                .slice(0, 40);
            const map = await overnightEdgeForCodes(codes);
            const items: Record<string, unknown> = {};
            for (const [code, report] of Object.entries(map)) {
                items[code] = overnightEdgeDto(report);
            }
            return { count: Object.keys(items).length, items };
        },
    );

    /** 盤後資金流：法人買超排行 + 融資（散戶追／籌碼乾） */
    app.get<{
        Querystring: { mode?: string; limit?: string };
    }>('/api/v1/data/money-flow', async (req) => {
        const rawMode = (req.query.mode ?? 'inst_buy').trim();
        const mode = (
            ['inst_buy', 'clean_buy', 'chase_buy', 'inst_sell'] as MoneyFlowMode[]
        ).includes(rawMode as MoneyFlowMode)
            ? (rawMode as MoneyFlowMode)
            : 'inst_buy';
        const limit = Number(req.query.limit ?? 40);
        const report = await buildMoneyFlowRank({
            mode,
            limit: Number.isFinite(limit) ? limit : 40,
        });
        return {
            as_of: report.asOf,
            mode: report.mode,
            count: report.count,
            universe: report.universe,
            note: report.note,
            rows: report.rows.map(moneyFlowRowDto),
        };
    });

    /** 布局本結算：用日K驗證當沖／隔夜訊號 */
    app.post<{
        Body: {
            items?: Array<{
                id?: string;
                code?: string;
                mode?: string;
                close?: number;
                stopLossPct?: number;
                takeProfitPct?: number;
                signalDate?: string;
            }>;
        };
    }>('/api/v1/data/settle-predictions', async (req, reply) => {
        const raw = Array.isArray(req.body?.items) ? req.body.items : [];
        if (!raw.length) {
            return reply.code(400).send({ error: 'items required' });
        }
        const inputs: SettleInput[] = raw
            .filter(
                (r) =>
                    typeof r?.id === 'string' &&
                    typeof r?.code === 'string' &&
                    typeof r?.close === 'number' &&
                    r.close > 0 &&
                    typeof r?.signalDate === 'string' &&
                    r.signalDate.length >= 10,
            )
            .slice(0, 80)
            .map((r) => ({
                id: r.id!,
                code: r.code!.trim(),
                mode:
                    r.mode === 'overnight' || r.mode === 'swing'
                        ? 'overnight'
                        : 'intraday',
                close: r.close!,
                stopLossPct:
                    typeof r.stopLossPct === 'number' && r.stopLossPct > 0
                        ? r.stopLossPct
                        : 1,
                takeProfitPct:
                    typeof r.takeProfitPct === 'number' && r.takeProfitPct > 0
                        ? r.takeProfitPct
                        : 2,
                signalDate: r.signalDate!.slice(0, 10),
            }));
        if (!inputs.length) {
            return reply.code(400).send({ error: 'no valid items' });
        }
        const codes = [...new Set(inputs.map((i) => i.code))];
        const barMap = await fetchTwDailyBarsBatch(codes, '3mo', 6);
        const results = settleBatch(inputs, barMap);
        return { count: results.length, results };
    });
}
