import type { IntradayRankItemDto } from '../../lib/backend';
import { radarColor } from './tokens';

export function regimeMeta(regime: string | null | undefined, score?: number) {
    const r = (regime ?? '').toLowerCase();
    if (r.includes('strong_bull') || r.includes('strong-bull') || (score != null && score >= 80)) {
        return { icon: '🔥', label: '強多', tone: radarColor.strong };
    }
    if (r.includes('bull') || (score != null && score >= 60)) {
        return { icon: '↗', label: '偏多', tone: radarColor.strong };
    }
    if (r.includes('strong_bear') || r.includes('strong-bear') || (score != null && score < 25)) {
        return { icon: '❄', label: '強空', tone: radarColor.health };
    }
    if (r.includes('bear') || (score != null && score < 40)) {
        return { icon: '↘', label: '偏空', tone: radarColor.health };
    }
    return { icon: '—', label: '中性', tone: radarColor.cooling };
}

export function stateTone(state: string): string {
    switch (state) {
        case 'STRONG':
            return radarColor.strong;
        case 'HEATING':
            return radarColor.heating;
        case 'EMERGING':
            return radarColor.emerging;
        case 'COOLING':
            return radarColor.cooling;
        case 'INVALID':
            return radarColor.invalid;
        default:
            return radarColor.cooling;
    }
}

/** Display labels for intraday states (keep enum values in English). */
export function stateLabel(state: string | null | undefined): string {
    switch ((state ?? '').toUpperCase()) {
        case 'STRONG':
            return '強勢';
        case 'HEATING':
            return '升溫';
        case 'EMERGING':
            return '萌芽';
        case 'COOLING':
            return '冷卻';
        case 'INVALID':
            return '失效';
        case 'DORMANT':
            return '休眠';
        default:
            return state || '—';
    }
}

export function eventLabel(ev: string | null | undefined): string {
    switch ((ev ?? '').toUpperCase()) {
        case 'SURGE':
            return '急漲';
        case 'BREAKOUT':
            return '突破';
        case 'REBREAK':
            return '再突破';
        case 'PULLBACK_READY':
            return '回踩就緒';
        case 'RANK_JUMP':
            return '排名急升';
        case 'COOLING':
            return '轉弱';
        case 'INVALID':
            return '失效';
        case 'STRONG_ENTER':
            return '進入強勢';
        default:
            return ev || '—';
    }
}

export function chaseLabel(chase: string | null | undefined): string {
    switch ((chase ?? '').toLowerCase()) {
        case 'low':
            return '低';
        case 'medium':
            return '中';
        case 'high':
            return '高';
        case 'extreme':
            return '極高';
        default:
            return chase ? chase : '—';
    }
}

export function liveStatusLabel(status: string): string {
    switch (status) {
        case 'LIVE':
            return '即時';
        case 'REPLAY':
            return '回放';
        case 'WAKING':
            return '載入中';
        case 'DATA STALE':
            return '資料過期';
        case 'DISCONNECTED':
            return '已斷線';
        default:
            return status;
    }
}

export function openConfirmLabel(v: string | null | undefined): string {
    switch ((v ?? '').toLowerCase()) {
        case 'pass':
            return '開盤通過';
        case 'early_pass':
            return '提早通過';
        case 'watch':
            return '觀察中';
        case 'provisional':
            return '試算中';
        case 'fail':
        case 'reject':
            return '未通過';
        default:
            return v || '—';
    }
}

export function primaryEvent(item: IntradayRankItemDto): string | null {
    const prefer = [
        'REBREAK',
        'SURGE',
        'BREAKOUT',
        'RANK_JUMP',
        'PULLBACK_READY',
        'STRONG_ENTER',
    ];
    for (const p of prefer) {
        if (item.events?.includes(p)) return p;
    }
    return item.events?.[0] ?? null;
}

export function fmtNum(v: number | null | undefined, digits = 1): string {
    if (v == null || Number.isNaN(v)) return '—';
    return v.toFixed(digits);
}

export function looksLikeBoardMover(opts: {
    changePct?: number | null;
    heat?: number | null;
    state?: string | null;
    bpState?: string | null;
}): boolean {
    const pct = opts.changePct;
    const heat = opts.heat ?? 0;
    const st = (opts.state ?? '').toUpperCase();
    const bp = (opts.bpState ?? '').toUpperCase();
    if (st === 'INVALID' || st === 'DORMANT') {
        return false;
    }
    if (pct == null || pct < 1) return false;
    if (pct >= 2) return true;
    if (heat >= 45) return true;
    if (bp === 'COOLING' || st === 'COOLING') return false;
    const strong =
        st === 'STRONG' ||
        st === 'HEATING' ||
        bp === 'BUY_SURGE' ||
        bp === 'ASK_EATING' ||
        bp === 'VOLUME_BREAKOUT' ||
        bp === 'OVERHEATED' ||
        bp === 'LARGE_BID';
    return strong && pct >= 1;
}

export function fmtPctSigned(v: number | null | undefined): string {
    if (v == null || Number.isNaN(v)) return '—';
    const sign = v > 0 ? '+' : '';
    return `${sign}${v.toFixed(2)}%`;
}

export function fmtRankMove(item: IntradayRankItemDto): string {
    const prev = item.rank_prev ?? item.rank_5m_ago ?? null;
    const cur = item.rank;
    if (prev == null) return `#${cur}`;
    const delta = prev - cur;
    const arrow = delta > 0 ? `↑${delta}` : delta < 0 ? `↓${Math.abs(delta)}` : '—';
    return `${prev} → ${cur}  ${arrow}`;
}

export function volumeLabel(item: IntradayRankItemDto): string {
    const accel = item.metrics?.volume_acceleration;
    if (accel == null) return '—';
    // volume_acceleration is often a score; if looks like ratio use x
    if (accel > 0 && accel < 20) return `${accel.toFixed(1)}x`;
    return fmtNum(accel, 0);
}

export function vwapLabel(item: IntradayRankItemDto): string {
    return fmtPctSigned(item.metrics?.vwap_pos_pct ?? null);
}

export function buildRulesSummary(item: IntradayRankItemDto): string {
    const bits: string[] = [];
    if (item.reasons?.length) {
        bits.push(...item.reasons.slice(0, 3));
    } else {
        if ((item.metrics?.volume_acceleration ?? 0) > 0) {
            bits.push('近分鐘量能偏強');
        }
        if ((item.metrics?.vwap_pos_pct ?? 0) > 0) {
            bits.push('股價維持 VWAP 上方');
        }
        if ((item.rank_velocity ?? 0) > 5) {
            bits.push(`排名快速上升（${fmtRankMove(item)}）`);
        }
    }
    if (!bits.length) return '目前結構尚待更多盤中確認。';
    return bits.join('，') + '。';
}

export function sortStrong(items: IntradayRankItemDto[]): IntradayRankItemDto[] {
    return [...items].sort((a, b) => b.intraday_score - a.intraday_score);
}

export function sortHeating(items: IntradayRankItemDto[]): IntradayRankItemDto[] {
    return [...items].sort(
        (a, b) =>
            (b.heat_score ?? 0) - (a.heat_score ?? 0) ||
            (b.rank_velocity ?? 0) - (a.rank_velocity ?? 0),
    );
}

export function sortPullback(items: IntradayRankItemDto[]): IntradayRankItemDto[] {
    return [...items]
        .filter((i) => {
            const pb = i.metrics?.pullback_state;
            const ev = i.events ?? [];
            return (
                ev.includes('PULLBACK_READY') ||
                pb === 'PULLBACK' ||
                pb === 'HOLDING' ||
                pb === 'RECLAIMING' ||
                pb === 'FAILED'
            );
        })
        .sort((a, b) => {
            const qa =
                (a.metrics?.pullback_quality_score ?? 0) +
                a.intraday_score -
                chasePenalty(a.risk?.chase_risk);
            const qb =
                (b.metrics?.pullback_quality_score ?? 0) +
                b.intraday_score -
                chasePenalty(b.risk?.chase_risk);
            return qb - qa;
        });
}

function chasePenalty(chase?: string): number {
    switch ((chase ?? '').toLowerCase()) {
        case 'extreme':
            return 40;
        case 'high':
            return 25;
        case 'medium':
            return 10;
        default:
            return 0;
    }
}

export function taipeiClock(d = new Date()): { date: string; time: string } {
    const parts = new Intl.DateTimeFormat('zh-TW', {
        timeZone: 'Asia/Taipei',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return {
        date: `${get('month')}/${get('day')}`,
        time: `${get('hour')}:${get('minute')}`,
    };
}
