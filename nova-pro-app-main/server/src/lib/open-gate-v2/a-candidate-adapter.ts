// server/src/lib/open-gate-v2/a-candidate-adapter.ts
// Maps existing A / full-screener fields → ACandidate. Does NOT change A scoring.

import type { ACandidate } from './types.ts';

/** Loose input from full-screener item + frontend strength. */
export interface ACandidateRaw {
    code?: string;
    symbol?: string;
    name?: string;
    a_score?: number;
    strength?: number;
    market?: 'tse' | 'otc' | string;
    exchange?: string;
    close?: number;
    prev_close?: number;
    average_price?: number;
    total_volume?: number;
    total_amount?: number;
    volume_ratio?: number;
    yesterday_volume?: number;
    avg_volume_20d?: number;
    avg_amount_20d?: number;
    sector?: string;
    industry?: string;
    warning_status?: boolean;
    disposition_status?: boolean;
    factors?: {
        vol_ratio_20?: number | null;
        industry?: string | null;
        punished?: boolean;
        attention?: boolean;
    };
    source?: 'eod_a' | 'scanner_candidate';
    lite?: boolean;
}

function asNum(v: unknown): number | null {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

function mapExchange(raw: ACandidateRaw): ACandidate['exchange'] {
    const m = String(raw.market ?? raw.exchange ?? '').toLowerCase();
    if (m === 'tse' || m === 'twse' || m === '上市') return 'tse';
    if (m === 'otc' || m === 'tpex' || m === '上櫃') return 'otc';
    return 'unknown';
}

/**
 * Adapt one A-pool row into the B input contract.
 * Missing avg_volume_20d is estimated from yesterday_volume / vol_ratio when possible.
 */
export function adaptACandidate(raw: ACandidateRaw): ACandidate | null {
    const symbol = String(raw.symbol ?? raw.code ?? '').trim();
    if (!symbol) return null;

    const aScore =
        asNum(raw.a_score) ?? asNum(raw.strength) ?? 0;

    const prevClose =
        asNum(raw.prev_close) ??
        (() => {
            const close = asNum(raw.close);
            // without true prev_close, leave null — DataHealth / evaluator handle missing
            return close != null && close > 0 ? null : null;
        })();

    let avgVol = asNum(raw.avg_volume_20d);
    const yVol = asNum(raw.yesterday_volume);
    const vRatio =
        asNum(raw.volume_ratio) ?? asNum(raw.factors?.vol_ratio_20 ?? null);
    if (avgVol == null && yVol != null && yVol > 0) {
        avgVol = yVol;
    }
    // If we only have today's volume + ratio, invert: avg ≈ today / ratio
    const todayVol = asNum(raw.total_volume);
    if (
        avgVol == null &&
        todayVol != null &&
        vRatio != null &&
        vRatio > 0
    ) {
        avgVol = todayVol / vRatio;
    }

    let avgAmt = asNum(raw.avg_amount_20d);
    const todayAmt = asNum(raw.total_amount);
    if (avgAmt == null && todayAmt != null && vRatio != null && vRatio > 0) {
        avgAmt = todayAmt / vRatio;
    }

    const disposition =
        Boolean(raw.disposition_status) ||
        Boolean(raw.factors?.punished);
    const warning =
        Boolean(raw.warning_status) ||
        Boolean(raw.factors?.attention);

    return {
        symbol,
        name: String(raw.name ?? symbol),
        exchange: mapExchange(raw),
        a_score: Math.max(0, Math.min(100, Math.round(aScore))),
        a_score_source: 'legacy_frontend',
        prev_close: prevClose,
        avg_volume_20d: avgVol,
        avg_amount_20d: avgAmt,
        sector:
            raw.sector ??
            raw.industry ??
            raw.factors?.industry ??
            null,
        warning_status: warning,
        disposition_status: disposition,
        source: raw.source ?? 'eod_a',
        lite: Boolean(raw.lite),
    };
}

export function adaptACandidates(raws: ACandidateRaw[]): ACandidate[] {
    const out: ACandidate[] = [];
    const seen = new Set<string>();
    for (const r of raws) {
        const c = adaptACandidate(r);
        if (!c || seen.has(c.symbol)) continue;
        seen.add(c.symbol);
        out.push(c);
    }
    return out;
}
