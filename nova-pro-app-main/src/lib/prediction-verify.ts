import { apiPost } from './api';
import {
    applySettleResults,
    isSettled,
    taipeiSignalDate,
    type PredictionRecord,
    type PredictionStatus,
} from './prediction-book';

interface SettleApiResult {
    id: string;
    status: PredictionStatus;
    exitPrice?: number;
    pnlPct?: number;
    settledAt?: string;
    note?: string;
}

/** 對未結算布局呼叫後端日K驗證 */
export async function verifyOpenPredictions(
    rows: PredictionRecord[],
): Promise<{ rows: PredictionRecord[]; changed: number }> {
    const open = rows.filter((r) => !isSettled(r.status));
    if (!open.length) return { rows, changed: 0 };

    const items = open.slice(0, 80).map((r) => ({
        id: r.id,
        code: r.code,
        mode: r.mode,
        close: r.close,
        stopLossPct: r.stopLossPct,
        takeProfitPct: r.takeProfitPct,
        signalDate: r.signalDate ?? taipeiSignalDate(r.createdAt),
    }));

    const res = await apiPost<{ count: number; results: SettleApiResult[] }>(
        '/api/v1/data/settle-predictions',
        { items },
    );
    return applySettleResults(rows, res.results ?? []);
}
