// server/src/lib/market-context/gap-layers/preopen-auction.ts
// Auction context only — never feeds strategy. No fabricated ticks.

import { buildMeta } from '../freshness.ts';
import { PreOpenBuffer } from './preopen-buffer.ts';
import type {
    LayerEnvelope,
    PreOpenAuctionData,
    PreOpenState,
} from './types.ts';

function taipeiParts(now = new Date()): { hm: number; weekday: number } {
    const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Taipei',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        weekday: 'short',
    });
    const parts = fmt.formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const map: Record<string, number> = {
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
        Sun: 0,
    };
    return { hm: hour * 60 + minute, weekday: map[wd] ?? -1 };
}

function detectWindow(now = new Date()): PreOpenAuctionData['window'] {
    const { hm, weekday } = taipeiParts(now);
    if (weekday === 0 || weekday === 6) return 'NONE';
    if (hm >= 8 * 60 + 30 && hm < 9 * 60) return 'PREOPEN';
    if (hm >= 13 * 60 + 25 && hm <= 13 * 60 + 30) return 'CLOSE_AUCTION';
    return 'NONE';
}

export function evaluatePreOpenAuction(
    fetchedAt: string,
    nowMs = Date.now(),
): LayerEnvelope<PreOpenAuctionData> {
    const window = detectWindow(new Date(nowMs));
    const since5 = nowMs - 5 * 60_000;
    const since1 = nowMs - 60_000;
    const ticks = PreOpenBuffer.ticksSince(since5);
    const books = PreOpenBuffer.booksSince(since5);
    const sample_count = ticks.length + books.length;

    const empty: PreOpenAuctionData = {
        window,
        state: window === 'NONE' ? 'OUT_OF_WINDOW' : 'UNAVAILABLE',
        simulated_match_price: null,
        simulated_match_volume: null,
        best_bid_levels: [],
        best_ask_levels: [],
        preopen_gap_pct: null,
        preopen_volume: null,
        price_revision_5m: null,
        price_revision_1m: null,
        bid_ask_imbalance: null,
        sample_count,
    };

    if (window === 'NONE') {
        return {
            layer: 'PreOpenAuctionContext',
            completeness: 'PARTIAL',
            available: false,
            proxy: false,
            note: 'Outside 08:30–09:00 / 13:25–13:30; no fabricated auction data.',
            meta: buildMeta({
                source: 'provider_simtrade_buffer',
                source_type: 'auction_context',
                fetched_at: fetchedAt,
                available: false,
                realtime_level: 'UNKNOWN',
                confidence: 'NONE',
            }),
            data: empty,
        };
    }

    if (sample_count === 0) {
        return {
            layer: 'PreOpenAuctionContext',
            completeness: 'PARTIAL',
            available: false,
            proxy: false,
            note: 'Provider trial/simtrade not available in buffer — PARTIAL, no fake data.',
            meta: buildMeta({
                source: 'provider_simtrade_buffer',
                source_type: 'auction_context',
                fetched_at: fetchedAt,
                available: false,
                realtime_level: 'REALTIME',
                confidence: 'NONE',
                coverage_pct: 0,
            }),
            data: { ...empty, state: 'UNAVAILABLE' },
        };
    }

    const last = ticks[ticks.length - 1] ?? null;
    const first5 = ticks[0] ?? null;
    const ticks1 = ticks.filter((t) => t.t >= since1);
    const first1 = ticks1[0] ?? null;
    const book = books[books.length - 1] ?? null;

    const bidVol = (book?.bid_volumes ?? []).reduce((a, b) => a + b, 0);
    const askVol = (book?.ask_volumes ?? []).reduce((a, b) => a + b, 0);
    const imbalance =
        bidVol + askVol > 0 ? (bidVol - askVol) / (bidVol + askVol) : null;

    const rev5 =
        last && first5 && first5.price > 0
            ? ((last.price - first5.price) / first5.price) * 100
            : null;
    const rev1 =
        last && first1 && first1.price > 0
            ? ((last.price - first1.price) / first1.price) * 100
            : null;

    let state: PreOpenState = 'PREOPEN_NEUTRAL';
    if (window === 'CLOSE_AUCTION') state = 'CLOSE_AUCTION';
    else if (rev5 != null && Math.abs(rev5) >= 0.8 && rev1 != null && Math.sign(rev5) !== Math.sign(rev1)) {
        state = 'PREOPEN_UNSTABLE';
    } else if ((rev5 ?? 0) > 0.25 || (imbalance ?? 0) > 0.2) {
        state = 'PREOPEN_POSITIVE';
    } else if ((rev5 ?? 0) < -0.25 || (imbalance ?? 0) < -0.2) {
        state = 'PREOPEN_NEGATIVE';
    }

    const data: PreOpenAuctionData = {
        window,
        state,
        simulated_match_price: last?.price ?? null,
        simulated_match_volume: last?.volume ?? null,
        best_bid_levels: book?.bid_prices?.slice(0, 5) ?? [],
        best_ask_levels: book?.ask_prices?.slice(0, 5) ?? [],
        preopen_gap_pct: rev5,
        preopen_volume: last?.total_volume ?? null,
        price_revision_5m: rev5,
        price_revision_1m: rev1,
        bid_ask_imbalance: imbalance,
        sample_count,
    };

    return {
        layer: 'PreOpenAuctionContext',
        completeness: sample_count >= 3 ? 'FULL' : 'PARTIAL',
        available: true,
        proxy: false,
        note: null,
        meta: buildMeta({
            source: 'provider_simtrade_buffer',
            source_type: 'auction_context',
            observed_at: last ? new Date(last.t).toISOString() : null,
            fetched_at: fetchedAt,
            available: true,
            realtime_level: 'REALTIME',
            confidence: sample_count >= 5 ? 'HIGH' : 'MEDIUM',
            coverage_pct: Math.min(100, sample_count * 10),
        }),
        data,
    };
}
