// server/src/lib/broker-intelligence/broker-provider.ts

import type {
    BranchDayBundle,
    BranchFreshness,
    BrokerProviderCapability,
} from './types.ts';

export interface BrokerBranchProvider {
    readonly id: string;
    capability(): BrokerProviderCapability;
    getBranchTrading(
        symbol: string,
        date?: string,
    ): Promise<BranchDayBundle>;
    getBranchHistory(
        symbol: string,
        startDate: string,
        endDate: string,
    ): Promise<BranchDayBundle[]>;
    getTopBranches(
        symbol: string,
        date: string | undefined,
        side: 'buy' | 'sell',
        limit?: number,
    ): Promise<BranchDayBundle>;
}

/** Capability audit result for currently wired market providers. */
export const PROVIDER_CAPABILITY_AUDIT: Record<
    string,
    BrokerProviderCapability
> = {
    fugle: {
        provider_id: 'fugle',
        branch_trading: false,
        branch_history: false,
        intraday: false,
        amount_fields: false,
        notes: 'Fugle marketdata SDK: quotes/kbars only; no broker branch API in this codebase',
    },
    shioaji: {
        provider_id: 'shioaji',
        branch_trading: false,
        branch_history: false,
        intraday: false,
        amount_fields: false,
        notes: 'Shioaji bridge: ticks/quotes/kbars; no 券商分點 endpoint wired',
    },
    twse: {
        provider_id: 'twse',
        branch_trading: false,
        branch_history: false,
        intraday: false,
        amount_fields: false,
        notes: 'TWSE open data used for 三大法人/融資; no public free branch trading feed integrated',
    },
    tpex: {
        provider_id: 'tpex',
        branch_trading: false,
        branch_history: false,
        intraday: false,
        amount_fields: false,
        notes: 'TPEx open data same limitation as TWSE for branch trading',
    },
};

export class UnavailableBrokerBranchProvider implements BrokerBranchProvider {
    readonly id = 'unavailable';

    capability(): BrokerProviderCapability {
        return {
            provider_id: this.id,
            branch_trading: false,
            branch_history: false,
            intraday: false,
            amount_fields: false,
            notes:
                'No branch provider connected. Fugle/Shioaji/TWSE/TPEx in this repo do not expose 券商分點.',
        };
    }

    async getBranchTrading(
        symbol: string,
        _date?: string,
    ): Promise<BranchDayBundle> {
        return emptyBundle(symbol, 'UNKNOWN');
    }

    async getBranchHistory(
        symbol: string,
        _start: string,
        _end: string,
    ): Promise<BranchDayBundle[]> {
        return [emptyBundle(symbol, 'UNKNOWN')];
    }

    async getTopBranches(
        symbol: string,
        _date: string | undefined,
        _side: 'buy' | 'sell',
        _limit?: number,
    ): Promise<BranchDayBundle> {
        return emptyBundle(symbol, 'UNKNOWN');
    }
}

function emptyBundle(
    symbol: string,
    freshness: BranchFreshness,
): BranchDayBundle {
    return {
        symbol,
        trade_date: '',
        freshness,
        source: 'unavailable',
        rows: [],
        available: false,
        error:
            '目前尚未接入券商分點資料來源（broker branch trading provider unavailable）',
    };
}

/**
 * Optional in-memory stub for unit tests only — never used in production wiring.
 */
export class MemoryBrokerBranchProvider implements BrokerBranchProvider {
    readonly id = 'memory_test';
    constructor(private days: BranchDayBundle[]) {}

    capability(): BrokerProviderCapability {
        return {
            provider_id: this.id,
            branch_trading: true,
            branch_history: true,
            intraday: false,
            amount_fields: false,
            notes: 'test-only',
        };
    }

    async getBranchTrading(
        symbol: string,
        date?: string,
    ): Promise<BranchDayBundle> {
        const hit = date
            ? this.days.find((d) => d.symbol === symbol && d.trade_date === date)
            : this.days.find((d) => d.symbol === symbol);
        return (
            hit ?? {
                symbol,
                trade_date: date ?? '',
                freshness: 'EOD',
                source: this.id,
                rows: [],
                available: false,
                error: 'not found',
            }
        );
    }

    async getBranchHistory(
        symbol: string,
        startDate: string,
        endDate: string,
    ): Promise<BranchDayBundle[]> {
        return this.days.filter(
            (d) =>
                d.symbol === symbol &&
                d.trade_date >= startDate &&
                d.trade_date <= endDate &&
                d.available,
        );
    }

    async getTopBranches(
        symbol: string,
        date: string | undefined,
        side: 'buy' | 'sell',
        limit = 10,
    ): Promise<BranchDayBundle> {
        const day = await this.getBranchTrading(symbol, date);
        const sorted = [...day.rows].sort((a, b) =>
            side === 'buy'
                ? b.net_volume - a.net_volume
                : a.net_volume - b.net_volume,
        );
        return { ...day, rows: sorted.slice(0, limit) };
    }
}
