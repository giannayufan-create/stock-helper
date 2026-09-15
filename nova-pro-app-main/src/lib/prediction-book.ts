export type StrategyMode = 'intraday' | 'overnight';

export type PredictionSource = 'manual' | 'auto_scan';

export type PredictionStatus =
    | 'open'
    | 'hit_tp'
    | 'hit_sl'
    | 'win'
    | 'loss'
    | 'flat';

export interface PredictionRecord {
    id: string;
    createdAt: string;
    mode: StrategyMode;
    code: string;
    name: string;
    close: number;
    /** 建議進場價（參考） */
    entryPrice?: number;
    entryNote?: string;
    target?: number;
    /** 預估最佳賣點說明／漲點 */
    sellNote?: string;
    gainPts?: number;
    gainPct?: number;
    rr: number;
    stopLossPct: number;
    takeProfitPct: number;
    hardPass: boolean;
    softHitCount: number;
    pickedConditions: string[];
    notes: string[];
    /** 訊號日（台北 YYYY-MM-DD），結算用 */
    signalDate?: string;
    source?: PredictionSource;
    strength?: number;
    status?: PredictionStatus;
    settledAt?: string;
    exitPrice?: number;
    pnlPct?: number;
    settleNote?: string;
}

const KEY = 'nova-pro-prediction-book-v1';
export const AUTO_SCAN_TOP_N = 10;

export function modeLabel(mode: StrategyMode | string): string {
    if (mode === 'overnight' || mode === 'swing') return '隔夜布局';
    return '當日當沖';
}

export function statusLabel(status: PredictionStatus | string | undefined): string {
    switch (status) {
        case 'hit_tp':
            return '達標';
        case 'hit_sl':
            return '停損';
        case 'win':
            return '小賺';
        case 'loss':
            return '小賠';
        case 'flat':
            return '持平';
        case 'open':
        default:
            return '待驗';
    }
}

export function isSettled(status: PredictionStatus | undefined): boolean {
    return !!status && status !== 'open';
}

export function normalizeMode(mode: unknown): StrategyMode {
    if (mode === 'overnight' || mode === 'swing') return 'overnight';
    return 'intraday';
}

export function taipeiSignalDate(isoOrDate?: string): string {
    const d = isoOrDate ? new Date(isoOrDate) : new Date();
    if (Number.isNaN(d.getTime())) {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Taipei',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(new Date());
    }
    // If already YYYY-MM-DD, keep it
    if (/^\d{4}-\d{2}-\d{2}/.test(isoOrDate ?? '')) {
        return (isoOrDate as string).slice(0, 10);
    }
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

function autoKey(row: PredictionRecord): string {
    const day = row.signalDate ?? taipeiSignalDate(row.createdAt);
    return `${row.code}|${row.mode}|${day}|auto_scan`;
}

export function loadPredictions(): PredictionRecord[] {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(
                (row): row is PredictionRecord =>
                    typeof row?.id === 'string' &&
                    typeof row?.code === 'string' &&
                    typeof row?.name === 'string',
            )
            .map((row) => ({
                ...row,
                mode: normalizeMode(row.mode),
                status: row.status ?? 'open',
                signalDate:
                    row.signalDate ?? taipeiSignalDate(row.createdAt),
                source: row.source ?? 'manual',
            }));
    } catch {
        return [];
    }
}

export function savePredictions(rows: PredictionRecord[]): void {
    localStorage.setItem(KEY, JSON.stringify(rows));
    void import('./cloud-sync')
        .then((m) => m.pushCloudPredictions(rows))
        .catch(() => undefined);
}

export function appendPrediction(
    current: PredictionRecord[],
    record: PredictionRecord,
): PredictionRecord[] {
    const next = [record, ...current].slice(0, 300);
    savePredictions(next);
    return next;
}

/** 篩選後自動記入前 N 名；同日同碼同模式只保留一筆 auto_scan */
export function mergeAutoScanPredictions(
    current: PredictionRecord[],
    incoming: PredictionRecord[],
): PredictionRecord[] {
    if (!incoming.length) return current;
    const drop = new Set(incoming.map(autoKey));
    const kept = current.filter((row) => {
        if ((row.source ?? 'manual') !== 'auto_scan') return true;
        return !drop.has(autoKey(row));
    });
    const next = [...incoming, ...kept].slice(0, 300);
    savePredictions(next);
    return next;
}

export function applySettleResults(
    current: PredictionRecord[],
    results: Array<{
        id: string;
        status: PredictionStatus;
        exitPrice?: number;
        pnlPct?: number;
        settledAt?: string;
        note?: string;
    }>,
): { rows: PredictionRecord[]; changed: number } {
    const map = new Map(results.map((r) => [r.id, r]));
    let changed = 0;
    const rows = current.map((row) => {
        const hit = map.get(row.id);
        if (!hit) return row;
        if (hit.status === 'open') {
            if (row.settleNote !== hit.note) {
                changed += 1;
                return { ...row, status: 'open' as const, settleNote: hit.note };
            }
            return row;
        }
        if (isSettled(row.status) && row.settledAt) return row;
        changed += 1;
        return {
            ...row,
            status: hit.status,
            exitPrice: hit.exitPrice,
            pnlPct: hit.pnlPct,
            settledAt: hit.settledAt,
            settleNote: hit.note,
        };
    });
    if (changed > 0) savePredictions(rows);
    return { rows, changed };
}

export function predictionStats(rows: PredictionRecord[]) {
    const settled = rows.filter((r) => isSettled(r.status));
    const open = rows.length - settled.length;
    const wins = settled.filter(
        (r) => r.status === 'hit_tp' || r.status === 'win',
    ).length;
    const losses = settled.filter(
        (r) => r.status === 'hit_sl' || r.status === 'loss',
    ).length;
    const hitRate =
        settled.length === 0 ? null : Math.round((wins / settled.length) * 1000) / 10;
    const avgPnl =
        settled.length === 0
            ? null
            : Math.round(
                  (settled.reduce((s, r) => s + (r.pnlPct ?? 0), 0) /
                      settled.length) *
                      100,
              ) / 100;
    return {
        total: rows.length,
        open,
        settled: settled.length,
        wins,
        losses,
        hitRate,
        avgPnl,
    };
}
