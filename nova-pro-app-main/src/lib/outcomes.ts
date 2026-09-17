// src/lib/outcomes.ts — measured signal forward path (not trading P&L).

import { apiGet } from './api';

export interface OutcomeTypeStatDto {
    signal_type: string;
    count: number;
    avg_forward_return_5m: number | null;
    avg_forward_return_15m: number | null;
    avg_forward_return_30m: number | null;
    avg_forward_return_60m: number | null;
    median_forward_return_15m: number | null;
    avg_MFE_15m: number | null;
    avg_MAE_15m: number | null;
    invalid_hit_rate: number | null;
    hit_1pct_rate: number | null;
    hit_2pct_rate: number | null;
    hit_3pct_rate: number | null;
    positive_5m_rate: number | null;
    positive_15m_rate: number | null;
    positive_30m_rate: number | null;
    ambiguous_count: number;
}

export interface OutcomeSummaryDto {
    window: { from: string; to: string };
    tracker: {
        enabled: boolean;
        tracked: number;
        settled_total: number;
        written_total: number;
        last_sample_at: string | null;
        last_write_at: string | null;
        last_error: string | null;
    } | null;
    coverage: {
        signals: number;
        outcomes: number;
        measured: number;
        coverage_pct: number;
    };
    by_signal_type: OutcomeTypeStatDto[];
    by_c_score: Array<{
        bucket: string;
        count: number;
        positive_15m_rate: number | null;
        avg_return_15m: number | null;
        avg_MFE_15m: number | null;
        avg_MAE_15m: number | null;
    }>;
    by_heat?: Array<{
        bucket: string;
        count: number;
        positive_15m_rate: number | null;
        avg_return_15m: number | null;
        avg_MFE_15m: number | null;
        avg_MAE_15m: number | null;
    }>;
    note: string;
}

export function fetchOutcomeSummary(from?: string, to?: string) {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const suffix = qs.toString() ? `?${qs}` : '';
    return apiGet<OutcomeSummaryDto>(
        `/api/v1/research/outcomes/summary${suffix}`,
    );
}

export function pctLabel(v: number | null | undefined, digits = 0): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return `${v.toFixed(digits)}%`;
}

export function numLabel(v: number | null | undefined, digits = 2): string {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toFixed(digits);
}

export function weightedRate(
    rows: Array<{ count: number; value: number | null | undefined }>,
): number | null {
    let n = 0;
    let w = 0;
    for (const r of rows) {
        if (r.value == null || !Number.isFinite(r.value) || r.count <= 0) continue;
        n += r.value * r.count;
        w += r.count;
    }
    return w ? n / w : null;
}
