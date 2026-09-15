// src/lib/broker-intelligence.ts — read-only broker/branch context client

import { apiGet } from './api';

export interface BrokerSummaryDto {
    symbol: string;
    name: string | null;
    trade_date: string | null;
    freshness: string;
    branch_available: boolean;
    unavailable_reason: string | null;
    institutional: {
        available: boolean;
        freshness: string;
        as_of: string | null;
        foreign_net: number | null;
        trust_net: number | null;
        inst_net: number | null;
        summary: string | null;
        note: string;
    };
    top_buy_branches: Array<{
        broker_name: string;
        branch_name: string;
        buy_volume: number;
        sell_volume: number;
        net_volume: number;
    }>;
    top_sell_branches: Array<{
        broker_name: string;
        branch_name: string;
        net_volume: number;
    }>;
    concentration: {
        concentration_top3: number | null;
        eligible_for_ranking: boolean;
    } | null;
    main_force: {
        score: number | null;
        label: string;
        inferred: boolean;
        confidence: string;
        method: string;
    };
    alignment: string;
    alignment_note: string;
    radar_context: {
        c_score: number | null;
        stock_heat: number | null;
        state: string | null;
        events: string[];
    } | null;
    data_health: { status: string; freshness: string; error: string | null };
}

export interface BrokerRankingRes {
    available: boolean;
    items: Array<{
        symbol: string;
        name: string | null;
        main_force_score: number | null;
        confidence: string;
        concentration_top3: number | null;
        net_buy_5d: number | null;
        consecutive_buy_days: number | null;
        c_score: number | null;
        stock_heat: number | null;
        state: string | null;
        events: string[];
        alignment: string;
    }>;
    note: string;
}

export function fetchBrokerSummary(symbol: string) {
    return apiGet<BrokerSummaryDto>(
        `/api/v1/broker-intelligence/${encodeURIComponent(symbol)}/summary`,
    );
}

export function fetchBrokerRanking(
    kind: 'concentration' | 'persistent-buy' | 'alignment',
) {
    return apiGet<BrokerRankingRes>(
        `/api/v1/broker-intelligence/ranking/${kind}`,
    );
}

export function fetchBrokerHealth() {
    return apiGet<{
        status: string;
        broker_intelligence_available: boolean;
        capability_audit?: unknown;
    }>('/api/v1/broker-intelligence/health');
}

export function fmtLotsShares(shares: number | null | undefined): string {
    if (shares == null || !Number.isFinite(shares)) return '—';
    const lots = shares / 1000;
    const sign = lots > 0 ? '+' : '';
    if (Math.abs(lots) >= 1000) return `${sign}${(lots / 1000).toFixed(1)}千張`;
    return `${sign}${Math.round(lots)}張`;
}
