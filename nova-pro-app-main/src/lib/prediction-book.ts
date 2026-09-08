export type StrategyMode = 'intraday' | 'overnight';

export interface PredictionRecord {
    id: string;
    createdAt: string;
    mode: StrategyMode;
    code: string;
    name: string;
    close: number;
    target?: number;
    rr: number;
    stopLossPct: number;
    takeProfitPct: number;
    hardPass: boolean;
    softHitCount: number;
    pickedConditions: string[];
    notes: string[];
}

const KEY = 'nova-pro-prediction-book-v1';

export function modeLabel(mode: StrategyMode | string): string {
    if (mode === 'overnight' || mode === 'swing') return '隔夜布局';
    return '當日當沖';
}

export function normalizeMode(mode: unknown): StrategyMode {
    if (mode === 'overnight' || mode === 'swing') return 'overnight';
    return 'intraday';
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
