// Client for Decision Summary Engine v1 — Decision Support only.

import { apiGet } from './api';

export type DecisionStatus =
    | 'NOT_READY'
    | 'WATCH'
    | 'CONFIRMED_STRENGTH'
    | 'EXTENDED';

export type DecisionContextAlignment =
    | 'ALIGNED'
    | 'MIXED'
    | 'CONTRARY'
    | 'INSUFFICIENT_DATA';

export type DecisionConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface DecisionLayersDto {
    stock: boolean;
    sector: boolean;
    market: boolean;
    event: boolean;
}

export interface DecisionSummaryDto {
    symbol: string;
    name: string;
    status: DecisionStatus;
    context_alignment: DecisionContextAlignment;
    confidence: DecisionConfidence;
    headline: string;
    confirmed_reasons: string[];
    missing_confirmations: string[];
    risk_flags: string[];
    next_confirmations: string[];
    data_coverage_pct: number;
    updated_at: string;
    layers: DecisionLayersDto;
    confirm_streak: number;
    version: string;
}

export interface DecisionSummaryBatchDto {
    as_of: string;
    version: string;
    count: number;
    items: DecisionSummaryDto[];
    evaluate_interval_sec: number;
    mutates_strategy: false;
    note: string;
}

export async function fetchDecisionSummary(opts?: {
    limit?: number;
}): Promise<DecisionSummaryBatchDto | null> {
    try {
        const qs =
            opts?.limit != null
                ? `?limit=${encodeURIComponent(String(opts.limit))}`
                : '';
        return await apiGet<DecisionSummaryBatchDto>(
            `/api/v1/data/decision-summary${qs}`,
        );
    } catch {
        return null;
    }
}

export async function fetchDecisionSummarySymbol(
    symbol: string,
): Promise<DecisionSummaryDto | null> {
    try {
        return await apiGet<DecisionSummaryDto>(
            `/api/v1/data/decision-summary/${encodeURIComponent(symbol)}`,
        );
    } catch {
        return null;
    }
}

export const DECISION_STATUS_LABEL: Record<DecisionStatus, string> = {
    NOT_READY: 'NOT READY',
    WATCH: 'WATCH',
    CONFIRMED_STRENGTH: 'CONFIRMED STRENGTH',
    EXTENDED: 'EXTENDED',
};

export const DECISION_STATUS_EMOJI: Record<DecisionStatus, string> = {
    NOT_READY: '⚪',
    WATCH: '🟠',
    CONFIRMED_STRENGTH: '🔴',
    EXTENDED: '🟣',
};
