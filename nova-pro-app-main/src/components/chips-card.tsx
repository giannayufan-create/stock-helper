// src/components/chips-card.tsx — 個股籌碼卡: 三大法人＋融資券＋額度／處置

import { useCallback } from 'react';
import { usePoll } from '../hooks/use-poll';
import { apiPost } from '../lib/api';
import { fetchPublicChip } from '../lib/backend';
import { useRegulatoryFlag } from '../lib/regulatory';
import type { ContractInfo } from '../lib/types/contract';
import { fmtInt } from '../lib/utils/format';
import * as dock from './bottom-dock.css';
import * as panel from './panel.css';

interface CreditEnquire {
    stock_id: string;
    system: string;
    update_time: string;
    margin_unit: number;
    short_unit: number;
    margin_loan_ratio: number;
    short_margin_ratio: number;
}

interface ShortSource {
    code: string;
    short_stock_source: number;
    datetime: string;
}

interface ChipsData {
    credit?: CreditEnquire;
    shortSource?: ShortSource;
    public?: Awaited<ReturnType<typeof fetchPublicChip>>;
}

function fmtLots(shares?: number): string {
    if (shares == null || !Number.isFinite(shares)) return '—';
    const lots = shares / 1000;
    const sign = lots > 0 ? '+' : '';
    if (Math.abs(lots) >= 1000) return `${sign}${(lots / 1000).toFixed(1)}千張`;
    return `${sign}${lots.toFixed(0)}張`;
}

async function fetchChips(contract: ContractInfo): Promise<ChipsData> {
    const key = {
        security_type: contract.security_type,
        exchange: contract.exchange,
        code: contract.code,
    };
    const [credit, short, pub] = await Promise.allSettled([
        apiPost<CreditEnquire[]>('/api/v1/data/credit_enquire', {
            contracts: [key],
        }),
        apiPost<ShortSource[]>('/api/v1/data/short_stock_sources', {
            contracts: [key],
        }),
        fetchPublicChip(contract.code),
    ]);
    return {
        credit:
            credit.status === 'fulfilled' ? credit.value[0] : undefined,
        shortSource:
            short.status === 'fulfilled' ? short.value[0] : undefined,
        public: pub.status === 'fulfilled' ? pub.value : undefined,
    };
}

export function ChipsCard({ contract }: { contract: ContractInfo }) {
    const { data } = usePoll<ChipsData>(
        useCallback(() => fetchChips(contract), [contract]),
        60000,
    );
    const regFlag = useRegulatoryFlag(contract.code);

    if (contract.security_type !== 'STK') {
        return (
            <div className={dock.emptyState}>籌碼資訊僅支援股票商品</div>
        );
    }
    if (!data) {
        return <div className={dock.emptyState}>載入籌碼資訊…</div>;
    }

    const sig = data.public?.signal;
    const row = data.public?.row;

    const items: { label: string; value: string; warn?: boolean }[] = [
        {
            label: '處置/注意',
            value:
                regFlag === 'punish'
                    ? '⚠ 處置股（分盤撮合）'
                    : regFlag === 'attention'
                      ? '△ 注意股'
                      : '正常',
            warn: regFlag !== null,
        },
        {
            label: '當沖資格',
            value:
                contract.day_trade === 'Yes'
                    ? '可當沖'
                    : contract.day_trade === 'OnlyBuy'
                      ? '僅可先買'
                      : '不可當沖',
            warn: contract.day_trade !== 'Yes',
        },
    ];

    if (sig?.available) {
        items.push(
            {
                label: `籌碼判定${sig.as_of ? `（${sig.as_of}）` : ''}`,
                value: `${sig.label}／${sig.bias}`,
                warn: sig.bias === '偏空',
            },
            {
                label: '外資買賣超',
                value: fmtLots(row?.foreign_net),
                warn: (row?.foreign_net ?? 0) < 0,
            },
            {
                label: '投信買賣超',
                value: fmtLots(row?.trust_net),
                warn: (row?.trust_net ?? 0) < 0,
            },
            {
                label: '三大法人合計',
                value: fmtLots(row?.inst_net),
                warn: (row?.inst_net ?? 0) < 0,
            },
            {
                label: '融資餘額變動',
                value: `${(row?.margin_delta ?? 0) > 0 ? '+' : ''}${fmtInt(row?.margin_delta ?? 0)}張`,
                warn: (row?.margin_delta ?? 0) > 400,
            },
            {
                label: '融券餘額變動',
                value: `${(row?.short_delta ?? 0) > 0 ? '+' : ''}${fmtInt(row?.short_delta ?? 0)}張`,
            },
        );
    } else {
        items.push({
            label: '公開籌碼',
            value: sig?.summary ?? '尚無三大法人／融資券資料',
        });
    }

    if (data.credit) {
        items.push(
            {
                label: '融資成數 / 餘額單位',
                value: `${data.credit.margin_loan_ratio}% / ${fmtInt(data.credit.margin_unit)}`,
            },
            {
                label: '融券成數 / 餘額單位',
                value: `${data.credit.short_margin_ratio}% / ${fmtInt(data.credit.short_unit)}`,
            },
        );
    }
    items.push(
        {
            label: '融資餘額(契約)',
            value: fmtInt(contract.margin_trading_balance),
        },
        {
            label: '融券餘額(契約)',
            value: fmtInt(contract.short_selling_balance),
        },
    );
    if (data.shortSource) {
        items.push({
            label: '可借券源',
            value: fmtInt(data.shortSource.short_stock_source),
        });
    }

    return (
        <div className={panel.panelBody}>
            {sig?.available && (
                <div
                    style={{
                        fontSize: '0.78rem',
                        opacity: 0.85,
                        marginBottom: 8,
                        lineHeight: 1.35,
                    }}
                >
                    {sig.summary}
                </div>
            )}
            <div className={dock.accountGrid}>
                {items.map((it) => (
                    <div key={it.label} className={dock.statCard}>
                        <span className={dock.statCardLabel}>{it.label}</span>
                        <span
                            className={`${dock.statCardValue} ${
                                it.warn ? panel.dirText.up : ''
                            }`}
                            style={{ fontSize: '0.85rem' }}
                        >
                            {it.value}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}
