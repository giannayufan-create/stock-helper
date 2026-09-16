// Assemble Daily Live Acceptance Report + markdown — observe only.

import type {
    DailyContextSummary,
    DailyFirestoreSummary,
    DailyLiveAcceptanceReport,
    DailyMarketSummary,
    DailyNotificationSummary,
    DailySystemSummary,
    IntegrityFinding,
    QualityDimension,
    QualityVerdict,
    SignalSampleRow,
    SignalTypeCounts,
} from './daily-types.ts';
import { DAILY_LA_VERSION } from './daily-types.ts';
import {
    countSignalTypes,
    rowsToCsv,
    selectAnomalies,
    selectSignalSamples,
} from './daily-sampler.ts';
import type { LiveGateResult } from './types.ts';

function worst(
    a: QualityVerdict,
    b: QualityVerdict,
): QualityVerdict {
    const rank: Record<QualityVerdict, number> = {
        PASS: 0,
        PARTIAL: 1,
        WARNING: 2,
        FAIL: 3,
    };
    return rank[a] >= rank[b] ? a : b;
}

export function buildQualityDimensions(input: {
    system: DailySystemSummary;
    market: DailyMarketSummary;
    firestore: DailyFirestoreSummary;
    notifications: DailyNotificationSummary;
    integrity: IntegrityFinding[];
    liveGates: LiveGateResult[];
    context: DailyContextSummary;
}): QualityDimension[] {
    const byId = (id: string) => input.liveGates.find((g) => g.id === id);
    const mapStatus = (s: string | undefined): QualityVerdict => {
        if (s === 'PASS') return 'PASS';
        if (s === 'FAIL') return 'FAIL';
        if (s === 'WARNING' || s === 'PARTIAL' || s === 'NOT_RUN')
            return s === 'PARTIAL' ? 'PARTIAL' : 'WARNING';
        return 'WARNING';
    };

    const pitCritical = input.integrity.some(
        (f) => f.id === 'FUTURE_LEAK' && f.severity === 'CRITICAL',
    );
    const foreignRt = input.integrity.some((f) => f.id === 'FOREIGN_AS_REALTIME');
    const sectorDenom = input.integrity.some(
        (f) => f.id === 'SECTOR_ACTIVE80_DENOM',
    );

    const dims: QualityDimension[] = [
        {
            id: 'Data_Readiness',
            label: 'Data Readiness',
            status: mapStatus(byId('LIVE1')?.status),
            detail: byId('LIVE1')?.detail ?? 'instrumentation',
        },
        {
            id: 'Market_Coverage',
            label: 'Market Coverage',
            status: mapStatus(byId('LIVE2')?.status),
            detail: `universe=${input.market.broad_universe_size} coverage=${input.market.market_coverage_pct}%`,
        },
        {
            id: 'Corporate_Action',
            label: 'Corporate Action',
            status: mapStatus(byId('LIVE3')?.status),
            detail: `count=${input.market.corporate_action_count ?? 0}`,
        },
        {
            id: 'PIT_Integrity',
            label: 'PIT Integrity',
            status: pitCritical
                ? 'FAIL'
                : mapStatus(byId('LIVE5')?.status),
            detail: pitCritical
                ? 'CRITICAL future leak detected'
                : (byId('LIVE5')?.detail ?? 'ok'),
        },
        {
            id: 'Sector_Rotation_Integrity',
            label: 'Sector Rotation Integrity',
            status: sectorDenom
                ? 'FAIL'
                : mapStatus(byId('LIVE6')?.status),
            detail: sectorDenom
                ? 'active-80 used as whole-market denominator'
                : `states=${JSON.stringify(input.market.sector_rotation_states)}`,
        },
        {
            id: 'Event_Confirmation',
            label: 'Event Confirmation',
            status: mapStatus(byId('LIVE7')?.status),
            detail: `EVENT_CONFIRMED=${input.context.EVENT_CONFIRMED}`,
        },
        {
            id: 'Notification',
            label: 'Notification',
            status:
                input.notifications.duplicate_count > 0
                    ? 'FAIL'
                    : input.notifications.notification_count === 0
                      ? 'WARNING'
                      : 'PASS',
            detail: `emitted=${input.notifications.notification_count} dup=${input.notifications.duplicate_count} cooldown=${input.notifications.cooldown_suppressed_count}`,
        },
        {
            id: 'Firestore',
            label: 'Firestore',
            status: mapStatus(byId('LIVE10')?.status),
            detail: `mode=${input.firestore.effective_mode} signals=${input.firestore.strategy_signal_count} outcomes=${input.firestore.outcome_count} fail=${input.firestore.write_failure_count}`,
        },
        {
            id: 'Runtime_Capacity',
            label: 'Runtime Capacity',
            status: mapStatus(byId('LIVE9')?.status),
            detail: `rss_peak=${input.system.rss_mb_peak} cpu_peak=${input.system.cpu_pct_peak} lag_p95=${input.system.event_loop_lag_p95_ms}`,
        },
        {
            id: 'Restart_Recovery',
            label: 'Restart Recovery',
            status: mapStatus(byId('LIVE11')?.status),
            detail: byId('LIVE11')?.detail ?? 'not run',
        },
        {
            id: 'Freshness',
            label: 'Freshness',
            status: foreignRt
                ? 'FAIL'
                : mapStatus(byId('LIVE12')?.status),
            detail: foreignRt
                ? 'PREVIOUS_DAY foreign labeled REALTIME'
                : (byId('LIVE12')?.detail ?? 'ok'),
        },
    ];
    return dims;
}

export function overallFromQuality(
    dims: QualityDimension[],
): 'PASS' | 'WARNING' | 'FAIL' {
    let v: QualityVerdict = 'PASS';
    for (const d of dims) v = worst(v, d.status);
    if (v === 'FAIL') return 'FAIL';
    if (v === 'WARNING' || v === 'PARTIAL') return 'WARNING';
    return 'PASS';
}

export function renderDailyMarkdown(report: DailyLiveAcceptanceReport): string {
    const lines: string[] = [];
    lines.push(`# Daily Live Acceptance Report — ${report.trading_day}`);
    lines.push('');
    lines.push(`- Version: \`${report.version}\``);
    lines.push(`- Generated: ${report.generated_at}`);
    lines.push(`- Overall: **${report.overall}**`);
    lines.push(`- Mutates strategy: \`${report.mutates_strategy}\``);
    lines.push(`- Commit: \`${report.commit_hash ?? 'n/a'}\``);
    lines.push('');
    lines.push('> Data / Runtime / Architecture quality only — not a stock strategy score.');
    lines.push('');
    lines.push('## Quality Dimensions');
    lines.push('');
    lines.push('| Dimension | Status | Detail |');
    lines.push('|---|---|---|');
    for (const q of report.quality) {
        lines.push(`| ${q.label} | ${q.status} | ${q.detail.replace(/\|/g, '/')} |`);
    }
    lines.push('');
    lines.push('## System');
    lines.push('```json');
    lines.push(JSON.stringify(report.system, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('## Market Data');
    lines.push('```json');
    lines.push(JSON.stringify(report.market, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('## Signals (counts)');
    lines.push('```json');
    lines.push(JSON.stringify(report.signals, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('## Notifications');
    lines.push('```json');
    lines.push(JSON.stringify(report.notifications, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('## Firestore');
    lines.push('```json');
    lines.push(JSON.stringify(report.firestore, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('## Context');
    lines.push('```json');
    lines.push(JSON.stringify(report.context, null, 2));
    lines.push('```');
    lines.push('');
    lines.push(`## Signal Samples (${report.signal_samples.length})`);
    lines.push('');
    for (const s of report.signal_samples.slice(0, 20)) {
        lines.push(
            `- ${s.timestamp} ${s.symbol} ${s.signal_type} BP=${s.BP ?? '—'} C=${s.C_score ?? '—'} align=${s.context_alignment ?? '—'} tags=${s.sample_tags.join(',')}`,
        );
    }
    if (report.signal_samples.length > 20) {
        lines.push(`- … +${report.signal_samples.length - 20} more (see CSV)`);
    }
    lines.push('');
    lines.push(`## Bad / Suspicious (${report.anomalies.length})`);
    lines.push('');
    for (const a of report.anomalies) {
        lines.push(
            `- **${a.kind}** ${a.row.symbol} ${a.row.signal_type}: ${a.reason}`,
        );
    }
    lines.push('');
    lines.push('## Integrity');
    lines.push('');
    if (!report.integrity.length) {
        lines.push('- none');
    } else {
        for (const f of report.integrity) {
            lines.push(`- [${f.severity}] ${f.id}: ${f.detail}`);
        }
    }
    lines.push('');
    lines.push('## Notes');
    lines.push('');
    lines.push('- Raw ticks / bidask are **not** included.');
    lines.push('- Report is summary + representative samples + anomalies only.');
    lines.push('');
    return lines.join('\n');
}

export function assembleDailyReport(input: {
    tradingDay: string;
    system: DailySystemSummary;
    market: DailyMarketSummary;
    notifications: DailyNotificationSummary;
    firestore: DailyFirestoreSummary;
    context: DailyContextSummary;
    allRows: SignalSampleRow[];
    integrity: IntegrityFinding[];
    liveGates: LiveGateResult[];
    paths: { md: string; json: string; csv: string };
    commitHash: string | null;
}): { report: DailyLiveAcceptanceReport; csv: string; md: string } {
    const signalCounts: SignalTypeCounts = countSignalTypes(input.allRows);
    const samples = selectSignalSamples(input.allRows);
    const anomalies = selectAnomalies(input.allRows);
    const quality = buildQualityDimensions({
        system: input.system,
        market: input.market,
        firestore: input.firestore,
        notifications: input.notifications,
        integrity: input.integrity,
        liveGates: input.liveGates,
        context: input.context,
    });
    const report: DailyLiveAcceptanceReport = {
        version: DAILY_LA_VERSION,
        generated_at: new Date().toISOString(),
        trading_day: input.tradingDay,
        mutates_strategy: false,
        creates_upstream_subscription: false,
        overall: overallFromQuality(quality),
        system: input.system,
        market: input.market,
        signals: signalCounts,
        notifications: input.notifications,
        firestore: input.firestore,
        context: input.context,
        signal_samples: samples,
        anomalies,
        integrity: input.integrity,
        quality,
        paths: input.paths,
        live_gates: input.liveGates.map((g) => ({
            id: g.id,
            status: g.status,
            detail: g.detail,
        })),
        commit_hash: input.commitHash,
    };
    return {
        report,
        csv: rowsToCsv(samples),
        md: renderDailyMarkdown(report),
    };
}
