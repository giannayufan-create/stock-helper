// src/lib/context-research.ts — Context Lab client (research only)

import { apiGet } from './api';

export interface CohortStatDto {
    cohort_id: string;
    label: string;
    n: number;
    sample_guard: 'INSUFFICIENT_DATA' | 'EXPLORATORY' | 'ANALYSIS_ELIGIBLE';
    positive_5m_rate: number | null;
    positive_15m_rate: number | null;
    median_forward_return_15m: number | null;
    median_mfe_15m: number | null;
    median_mae_15m: number | null;
    invalid_hit_rate: number | null;
    coverage_note: string | null;
}

export interface ContextOverviewDto {
    version: string;
    mutates_strategy: false;
    signal_count: number;
    shadow_cohorts: CohortStatDto[];
    combinations: CohortStatDto[];
    daily: {
        date: string;
        signals: number;
        context_coverage_pct: number | null;
        market_aligned: number;
        sector_rotating_in: number;
        event_confirmed: number;
        note: string;
    };
}

export interface ContextSignalDetailDto {
    signal_id: string;
    symbol: string;
    signal_type: string;
    signal_time: string;
    context_snapshot: Record<string, unknown> | null;
    context_tags: string[];
    context_alignment: string | null;
    context_strength_score: number | null;
    note: string;
}

function q(params: Record<string, string | undefined>) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v) sp.set(k, v);
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
}

export function fetchContextOverview(params: Record<string, string | undefined> = {}) {
    return apiGet<ContextOverviewDto>(
        `/api/v1/research/context/overview${q(params)}`,
    );
}

export function fetchContextMarket(params: Record<string, string | undefined> = {}) {
    return apiGet<{ items: CohortStatDto[] }>(
        `/api/v1/research/context/market${q(params)}`,
    );
}

export function fetchContextSectors(params: Record<string, string | undefined> = {}) {
    return apiGet<{ items: CohortStatDto[] }>(
        `/api/v1/research/context/sectors${q(params)}`,
    );
}

export function fetchContextEvents(params: Record<string, string | undefined> = {}) {
    return apiGet<{
        confirmation: CohortStatDto[];
        by_type: CohortStatDto[];
    }>(`/api/v1/research/context/events${q(params)}`);
}

export function fetchContextCombinations(
    params: Record<string, string | undefined> = {},
) {
    return apiGet<{ items: CohortStatDto[]; shadow: CohortStatDto[] }>(
        `/api/v1/research/context/combinations${q(params)}`,
    );
}

export function fetchContextSignalDetail(signalId: string) {
    return apiGet<ContextSignalDetailDto>(
        `/api/v1/research/context/signals/${encodeURIComponent(signalId)}`,
    );
}
