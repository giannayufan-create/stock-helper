export type StrategyMode = 'daytrade' | 'swing';

export interface PredictionRecord {
    id: string;
    createdAt: string;
    mode: StrategyMode;
    code: string;
    name: string;
    close: number;
    rr: number;
    stopLossPct: number;
    takeProfitPct: number;
    hardPass: boolean;
    softHitCount: number;
    pickedConditions: string[];
    notes: string[];
}

const KEY = 'nova-pro-prediction-book-v1';

export function loadPredictions(): PredictionRecord[] {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (row): row is PredictionRecord =>
                typeof row?.id === 'string' &&
                typeof row?.code === 'string' &&
                typeof row?.name === 'string',
        );
    } catch {
        return [];
    }
}

export function savePredictions(rows: PredictionRecord[]): void {
    localStorage.setItem(KEY, JSON.stringify(rows));
    // Fire-and-forget cloud sync (no-op until Auth/Firestore are enabled)
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

