// Representative signal sampling + anomaly picks — observe only.

import type {
    AnomalyKind,
    AnomalySample,
    SignalSampleRow,
    SignalTypeCounts,
} from './daily-types.ts';
import { emptySignalTypeCounts } from './daily-types.ts';

const MAX_SAMPLES = 50;
const MAX_ANOMALIES = 30;

export function countSignalTypes(
    rows: Array<{ signal_type: string }>,
): SignalTypeCounts {
    const c = emptySignalTypeCounts();
    for (const r of rows) {
        const k = r.signal_type as keyof SignalTypeCounts;
        if (k in c) c[k] += 1;
    }
    return c;
}

/** Quota-aware sample: prefer EARLY≥10, BUY_SURGE≥10, BREAKOUT≥5, plus tagged buckets. */
export function selectSignalSamples(rows: SignalSampleRow[]): SignalSampleRow[] {
    if (!rows.length) return [];
    const picked = new Set<string>();
    const out: SignalSampleRow[] = [];
    const key = (r: SignalSampleRow) =>
        `${r.timestamp}|${r.symbol}|${r.signal_type}`;

    const take = (
        pred: (r: SignalSampleRow) => boolean,
        n: number,
        tag: string,
    ) => {
        let got = 0;
        for (const r of rows) {
            if (out.length >= MAX_SAMPLES || got >= n) return;
            if (!pred(r)) continue;
            const k = key(r);
            if (picked.has(k)) continue;
            picked.add(k);
            out.push({
                ...r,
                sample_tags: Array.from(
                    new Set([...(r.sample_tags ?? []), tag]),
                ),
            });
            got += 1;
        }
    };

    take((r) => r.signal_type === 'EARLY_ENTER', 10, 'quota_early');
    take((r) => r.signal_type === 'BUY_SURGE', 10, 'quota_buy_surge');
    take((r) => r.signal_type === 'BREAKOUT', 5, 'quota_breakout');
    take((r) => (r.BP ?? 0) >= 80, 5, 'high_bp');
    take(
        (r) =>
            r.signal_type === 'RANK_JUMP' ||
            (r.rank_change != null && Math.abs(r.rank_change) >= 5),
        5,
        'rank_jump',
    );
    take(
        (r) => r.context_alignment === 'ALIGNED',
        5,
        'context_aligned',
    );
    take(
        (r) => r.context_alignment === 'CONTRARY',
        5,
        'context_contrary',
    );

    const rest = [...rows].sort((a, b) => (b.BP ?? 0) - (a.BP ?? 0));
    for (const r of rest) {
        if (out.length >= MAX_SAMPLES) break;
        const k = key(r);
        if (picked.has(k)) continue;
        picked.add(k);
        out.push({ ...r, sample_tags: [...(r.sample_tags ?? []), 'fill'] });
    }
    return out.slice(0, MAX_SAMPLES);
}

export function selectAnomalies(rows: SignalSampleRow[]): AnomalySample[] {
    const out: AnomalySample[] = [];
    const push = (
        kind: AnomalyKind,
        reason: string,
        row: SignalSampleRow,
    ) => {
        if (out.length >= MAX_ANOMALIES) return;
        out.push({ kind, reason, row });
    };

    for (const r of rows) {
        if (out.length >= MAX_ANOMALIES) break;

        // A: reverse after 15m (signal implied long → negative 15m)
        if (
            r.outcome_15m != null &&
            r.outcome_15m <= -1.0 &&
            (r.BP ?? 0) >= 50
        ) {
            push(
                'A_REVERSE_15M',
                `15m outcome ${r.outcome_15m.toFixed(2)}% with BP ${r.BP}`,
                r,
            );
            continue;
        }

        // B: high BP + sector rotating out
        if (
            (r.BP ?? 0) >= 70 &&
            (r.sector_state === 'ROTATING_OUT' || r.sector_state === 'COLD')
        ) {
            push(
                'B_BP_HIGH_SECTOR_OUT',
                `BP ${r.BP} vs sector ${r.sector_state}`,
                r,
            );
            continue;
        }

        // C: EARLY then quick invalid
        if (
            r.signal_type === 'EARLY_ENTER' &&
            r.invalid === true
        ) {
            push('C_EARLY_FAST_INVALID', 'EARLY_ENTER marked invalid', r);
            continue;
        }

        // D: HOT sector but low breadth (encoded on row tags or capital)
        if (
            r.sector_state === 'HOT' &&
            r.sample_tags.includes('low_breadth')
        ) {
            push('D_HOT_LOW_BREADTH', 'Sector HOT with low breadth', r);
            continue;
        }

        // E: corporate action
        if (r.corporate_action && r.corporate_action !== 'NONE') {
            push(
                'E_CORPORATE_ACTION',
                `CA ${r.corporate_action}`,
                r,
            );
            continue;
        }

        // F: stale / low confidence
        if (
            r.sample_tags.includes('stale') ||
            r.sample_tags.includes('low_confidence')
        ) {
            push('F_STALE_LOW_CONF', 'stale or low confidence', r);
            continue;
        }

        // G: notification anomaly tag
        if (r.sample_tags.includes('notify_anomaly')) {
            push('G_NOTIFY_ANOMALY', 'notification duplicate/cooldown anomaly', r);
        }
    }

    return out.slice(0, MAX_ANOMALIES);
}

export function rowsToCsv(rows: SignalSampleRow[]): string {
    const headers = [
        'timestamp',
        'symbol',
        'name',
        'signal_type',
        'price',
        'change_pct',
        'BP',
        'C_score',
        'rank',
        'rank_change',
        'VWAP',
        'RVOL',
        'taiwan_regime',
        'sector',
        'sector_state',
        'sector_rank',
        'capital_rotation',
        'event_state',
        'corporate_action',
        'context_alignment',
        'outcome_5m',
        'outcome_15m',
        'outcome_30m',
        'outcome_60m',
        'MFE',
        'MAE',
        'invalid',
        'sample_tags',
    ];
    const esc = (v: unknown) => {
        if (v == null) return '';
        const s = String(v);
        if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
    };
    const lines = [headers.join(',')];
    for (const r of rows) {
        lines.push(
            [
                r.timestamp,
                r.symbol,
                r.name,
                r.signal_type,
                r.price,
                r.change_pct,
                r.BP,
                r.C_score,
                r.rank,
                r.rank_change,
                r.VWAP,
                r.RVOL,
                r.taiwan_regime,
                r.sector,
                r.sector_state,
                r.sector_rank,
                r.capital_rotation,
                r.event_state,
                r.corporate_action,
                r.context_alignment,
                r.outcome_5m,
                r.outcome_15m,
                r.outcome_30m,
                r.outcome_60m,
                r.MFE,
                r.MAE,
                r.invalid,
                (r.sample_tags ?? []).join('|'),
            ]
                .map(esc)
                .join(','),
        );
    }
    return lines.join('\n') + '\n';
}
