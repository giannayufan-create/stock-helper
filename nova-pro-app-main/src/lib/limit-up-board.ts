// src/lib/limit-up-board.ts — today's 漲停板 client (read-only)

import { apiGet } from './api';

export interface LimitUpBoardItem {
    symbol: string;
    name: string;
    last_price: number | null;
    change_pct: number;
    change_price: number | null;
    volume: number | null;
    amount: number | null;
    market: 'tse' | 'otc' | null;
    open: number | null;
    high: number | null;
    low: number | null;
}

export interface LimitUpBoardDto {
    as_of: string;
    mode: 'live' | 'eod';
    source: 'scanner' | 'tw_openapi' | 'finmind';
    min_pct: number;
    count: number;
    items: LimitUpBoardItem[];
    warnings: string[];
}

export function fetchLimitUpBoard(opts?: {
    mode?: 'live' | 'eod' | 'auto';
    date?: string;
    min_pct?: number;
    count?: number;
    timeoutMs?: number;
}) {
    const qs = new URLSearchParams();
    if (opts?.mode) qs.set('mode', opts.mode);
    if (opts?.date) qs.set('date', opts.date);
    if (opts?.min_pct != null) qs.set('min_pct', String(opts.min_pct));
    if (opts?.count != null) qs.set('count', String(opts.count));
    const suffix = qs.toString() ? `?${qs}` : '';
    return apiGet<LimitUpBoardDto>(
        `/api/v1/data/limit-up-board${suffix}`,
        opts?.timeoutMs ?? 15_000,
    );
}

const BOARD_CACHE_KEY = 'limit-up-board-v1';

export function readCachedLimitUpBoard(): LimitUpBoardDto | null {
    try {
        const raw = localStorage.getItem(BOARD_CACHE_KEY);
        if (!raw) return null;
        const dto = JSON.parse(raw) as LimitUpBoardDto;
        if (!Array.isArray(dto.items) || dto.items.length === 0) return null;
        return dto;
    } catch {
        return null;
    }
}

export function writeCachedLimitUpBoard(dto: LimitUpBoardDto): void {
    try {
        localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify(dto));
    } catch {
        // quota / private mode
    }
}
