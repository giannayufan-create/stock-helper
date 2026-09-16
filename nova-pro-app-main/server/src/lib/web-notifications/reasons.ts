// server/src/lib/web-notifications/reasons.ts
// Deterministic reasons only — no AI.

import type { BuyPressureItem } from '../buy-pressure/types.ts';
import type { NotificationEventType } from './types.ts';

function fmtPct(n: number | null | undefined): string | null {
    if (n == null || !Number.isFinite(n)) return null;
    const sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}%`;
}

export function buildNotificationReasons(
    eventType: NotificationEventType,
    item: BuyPressureItem,
): string[] {
    const reasons: string[] = [];
    if (item.volume_acceleration != null) {
        reasons.push(
            `3分鐘量能 ${item.volume_acceleration > 0 ? '+' : ''}${Math.round(item.volume_acceleration)}%`,
        );
    }
    if (item.rank_prev != null && item.rank != null) {
        reasons.push(`Rank ${item.rank_prev} → ${item.rank}`);
    } else if (item.rank_velocity != null && item.rank_velocity > 0) {
        reasons.push(`Rank Velocity +${Math.round(item.rank_velocity)}`);
    }
    if (item.rvol != null) {
        reasons.push(`RVOL ${item.rvol.toFixed(1)}x`);
    }
    if (item.trade_aggression != null && item.trade_aggression >= 50) {
        reasons.push('主動買盤持續增強');
    }
    if (item.distance_from_vwap_pct != null) {
        const d = fmtPct(item.distance_from_vwap_pct);
        if (d) {
            reasons.push(
                `${item.vwap_bucket ?? 'VWAP'} ${d}`.replace('Above VWAP', 'Above VWAP'),
            );
        }
    }
    if (item.ask_eating_note && eventType === 'ASK_EATING') {
        reasons.push(item.ask_eating_note);
    }
    if (eventType === 'OVERHEATED_STRONG') {
        reasons.push(
            item.overheated_note ?? '買盤強，短線延伸較大',
        );
        if (item.chase_risk) reasons.push(`Chase Risk ${item.chase_risk}`);
    }
    if (eventType === 'EARLY_ENTER') {
        reasons.push('尚未要求 C STRONG，捕捉剛轉強');
    }
    return reasons.slice(0, 4);
}
