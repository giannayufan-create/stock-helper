import {
    isSettled,
    loadPredictions,
    type PredictionRecord,
    type StrategyMode,
} from './prediction-book';

export interface LearnBucket {
    key: string;
    label: string;
    n: number;
    wins: number;
    losses: number;
    hitRate: number;
    avgPnl: number;
    /** Soft strength points applied on next scans */
    delta: number;
    /** 最近視窗內連敗 / 低命中 → 暫時淘汰 */
    muted?: boolean;
    recentN?: number;
    recentWins?: number;
    recentLosses?: number;
    recentHitRate?: number;
    muteReason?: string;
}

export interface LearnModel {
    updatedAt: string;
    settled: number;
    ready: boolean;
    mode: Record<StrategyMode, LearnBucket & { active: boolean }>;
    tags: LearnBucket[];
    muted: LearnBucket[];
}

const MIN_MODE = 8;
const MIN_TAG = 5;
const MODE_CAP = 3;
const TAG_CAP = 2;
const TOTAL_CAP = 10;
const MUTE_EXTRA = 3.5;
const MUTE_CAP = 5;
const RECENT_WINDOW = 6;
const MUTE_MIN_RECENT = 4;
const MUTE_LOSS_STREAK = 3;
const MUTE_HIT_RATE = 35;

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

function isWin(status: string | undefined): boolean {
    return status === 'hit_tp' || status === 'win';
}

function isLoss(status: string | undefined): boolean {
    return status === 'hit_sl' || status === 'loss';
}

/**
 * Shrinkage soft delta from hit-rate + avg PnL.
 * Small samples stay near 0; never rewrite the base heuristic hard.
 */
function softDelta(
    hitRatePct: number,
    avgPnl: number,
    n: number,
    minN: number,
    cap: number,
): number {
    if (n < minN) return 0;
    const conf = Math.sqrt(n / (n + 12));
    const hrEdge = hitRatePct - 50;
    const pnlEdge = clamp(avgPnl, -2.5, 2.5);
    const raw = (hrEdge * 0.07 + pnlEdge * 0.55) * conf;
    return clamp(Math.round(raw * 10) / 10, -cap, cap);
}

function emptyMode(mode: StrategyMode): LearnBucket & { active: boolean } {
    return {
        key: mode,
        label: mode === 'overnight' ? '隔夜布局' : '當日當沖',
        n: 0,
        wins: 0,
        losses: 0,
        hitRate: 0,
        avgPnl: 0,
        delta: 0,
        active: false,
    };
}

function settleTime(row: PredictionRecord): number {
    const t = Date.parse(row.settledAt || row.createdAt);
    return Number.isFinite(t) ? t : 0;
}

type Outcome = 'win' | 'loss' | 'flat';

function outcomeOf(status: string | undefined): Outcome {
    if (isWin(status)) return 'win';
    if (isLoss(status)) return 'loss';
    return 'flat';
}

function lossStreak(recent: Outcome[]): number {
    let streak = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
        if (recent[i] !== 'loss') break;
        streak += 1;
    }
    return streak;
}

function evaluateMute(recent: Outcome[]): {
    muted: boolean;
    reason?: string;
    recentHitRate: number;
    recentWins: number;
    recentLosses: number;
} {
    const wins = recent.filter((o) => o === 'win').length;
    const losses = recent.filter((o) => o === 'loss').length;
    const decided = wins + losses;
    const recentHitRate =
        decided > 0 ? Math.round((wins / decided) * 1000) / 10 : 0;
    const streak = lossStreak(recent);

    if (streak >= MUTE_LOSS_STREAK) {
        return {
            muted: true,
            reason: `近 ${streak} 連敗`,
            recentHitRate,
            recentWins: wins,
            recentLosses: losses,
        };
    }
    if (
        recent.length >= MUTE_MIN_RECENT &&
        decided >= MUTE_MIN_RECENT &&
        recentHitRate < MUTE_HIT_RATE
    ) {
        return {
            muted: true,
            reason: `近 ${recent.length} 筆命中僅 ${recentHitRate}%`,
            recentHitRate,
            recentWins: wins,
            recentLosses: losses,
        };
    }
    if (recent.length >= MUTE_MIN_RECENT && losses >= MUTE_MIN_RECENT && wins === 0) {
        return {
            muted: true,
            reason: `近 ${recent.length} 筆全輸`,
            recentHitRate,
            recentWins: wins,
            recentLosses: losses,
        };
    }
    return {
        muted: false,
        recentHitRate,
        recentWins: wins,
        recentLosses: losses,
    };
}

function finalizeBucket(
    key: string,
    label: string,
    wins: number,
    losses: number,
    flats: number,
    pnlSum: number,
    minN: number,
    cap: number,
    recent: Outcome[] = [],
): LearnBucket {
    const n = wins + losses + flats;
    const decided = wins + losses;
    const hitRate =
        decided > 0 ? Math.round((wins / decided) * 1000) / 10 : 0;
    const avgPnl = n > 0 ? Math.round((pnlSum / n) * 100) / 100 : 0;
    let delta = softDelta(hitRate, avgPnl, n, minN, cap);

    const mute = evaluateMute(recent.slice(-RECENT_WINDOW));
    if (mute.muted) {
        // 暫時淘汰：取消加分，並額外加重降權
        const penalized = Math.min(delta, 0) - MUTE_EXTRA;
        delta = clamp(Math.round(penalized * 10) / 10, -MUTE_CAP, cap);
    }

    return {
        key,
        label,
        n,
        wins,
        losses,
        hitRate,
        avgPnl,
        delta,
        muted: mute.muted,
        recentN: recent.length,
        recentWins: mute.recentWins,
        recentLosses: mute.recentLosses,
        recentHitRate: mute.recentHitRate,
        muteReason: mute.reason,
    };
}

export function buildLearnModel(
    rows: PredictionRecord[] = loadPredictions(),
): LearnModel {
    const settled = rows
        .filter((r) => isSettled(r.status))
        .slice()
        .sort((a, b) => settleTime(a) - settleTime(b));

    type Acc = {
        wins: number;
        losses: number;
        flats: number;
        pnlSum: number;
        recent: Outcome[];
        label: string;
        mode: StrategyMode;
    };
    const modeAcc: Record<
        StrategyMode,
        {
            wins: number;
            losses: number;
            flats: number;
            pnlSum: number;
            recent: Outcome[];
        }
    > = {
        intraday: { wins: 0, losses: 0, flats: 0, pnlSum: 0, recent: [] },
        overnight: { wins: 0, losses: 0, flats: 0, pnlSum: 0, recent: [] },
    };
    const tagAcc = new Map<string, Acc>();

    for (const row of settled) {
        const mode = row.mode;
        const m = modeAcc[mode];
        const pnl = row.pnlPct ?? 0;
        const out = outcomeOf(row.status);
        m.pnlSum += pnl;
        m.recent.push(out);
        if (out === 'win') m.wins += 1;
        else if (out === 'loss') m.losses += 1;
        else m.flats += 1;

        for (const label of row.pickedConditions ?? []) {
            if (!label) continue;
            const key = `${mode}|${label}`;
            let t = tagAcc.get(key);
            if (!t) {
                t = {
                    wins: 0,
                    losses: 0,
                    flats: 0,
                    pnlSum: 0,
                    recent: [],
                    label,
                    mode,
                };
                tagAcc.set(key, t);
            }
            t.pnlSum += pnl;
            t.recent.push(out);
            if (out === 'win') t.wins += 1;
            else if (out === 'loss') t.losses += 1;
            else t.flats += 1;
        }
    }

    const mode: LearnModel['mode'] = {
        intraday: {
            ...finalizeBucket(
                'intraday',
                '當日當沖',
                modeAcc.intraday.wins,
                modeAcc.intraday.losses,
                modeAcc.intraday.flats,
                modeAcc.intraday.pnlSum,
                MIN_MODE,
                MODE_CAP,
                modeAcc.intraday.recent,
            ),
            active:
                modeAcc.intraday.wins +
                    modeAcc.intraday.losses +
                    modeAcc.intraday.flats >=
                MIN_MODE,
        },
        overnight: {
            ...finalizeBucket(
                'overnight',
                '隔夜布局',
                modeAcc.overnight.wins,
                modeAcc.overnight.losses,
                modeAcc.overnight.flats,
                modeAcc.overnight.pnlSum,
                MIN_MODE,
                MODE_CAP,
                modeAcc.overnight.recent,
            ),
            active:
                modeAcc.overnight.wins +
                    modeAcc.overnight.losses +
                    modeAcc.overnight.flats >=
                MIN_MODE,
        },
    };

    if (!mode.intraday) mode.intraday = emptyMode('intraday');
    if (!mode.overnight) mode.overnight = emptyMode('overnight');

    const allTags: LearnBucket[] = [...tagAcc.entries()]
        .map(([key, acc]) =>
            finalizeBucket(
                key,
                `${acc.mode === 'overnight' ? '隔夜' : '當沖'}·${acc.label}`,
                acc.wins,
                acc.losses,
                acc.flats,
                acc.pnlSum,
                MIN_TAG,
                TAG_CAP,
                acc.recent,
            ),
        )
        .filter((t) => t.n >= Math.min(MIN_TAG, MUTE_MIN_RECENT))
        .sort(
            (a, b) =>
                Number(!!b.muted) - Number(!!a.muted) ||
                Math.abs(b.delta) - Math.abs(a.delta) ||
                b.n - a.n,
        );

    const muted = allTags.filter((t) => t.muted);
    const tags = allTags.filter((t) => t.delta !== 0 || t.muted);

    const ready =
        settled.length >= MIN_TAG &&
        (mode.intraday.active ||
            mode.overnight.active ||
            tags.some((t) => t.delta !== 0 || t.muted));

    return {
        updatedAt: new Date().toISOString(),
        settled: settled.length,
        ready,
        mode,
        tags,
        muted,
    };
}

export function learnDeltaForTags(
    model: LearnModel,
    mode: StrategyMode,
    conditionLabels: string[],
): { delta: number; parts: string[] } {
    let delta = 0;
    const parts: string[] = [];
    const modeBucket = model.mode[mode];
    if (modeBucket?.active && modeBucket.delta !== 0) {
        delta += modeBucket.delta;
        parts.push(
            `模式${modeBucket.delta > 0 ? '+' : ''}${modeBucket.delta}${
                modeBucket.muted ? '·暫汰' : ''
            }`,
        );
    }

    const seen = new Set<string>();
    for (const label of conditionLabels) {
        const key = `${mode}|${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const bucket =
            model.tags.find((t) => t.key === key) ??
            model.muted.find((t) => t.key === key);
        if (!bucket || bucket.delta === 0) continue;
        delta += bucket.delta;
        parts.push(
            `${label}${bucket.delta > 0 ? '+' : ''}${bucket.delta}${
                bucket.muted ? '·暫汰' : ''
            }`,
        );
    }

    delta = clamp(Math.round(delta * 10) / 10, -TOTAL_CAP, TOTAL_CAP);
    return { delta, parts };
}

export function formatLearnStatus(
    model: LearnModel,
    mode: StrategyMode,
): string {
    if (!model.ready) {
        const need = Math.max(0, MIN_MODE - model.settled);
        return need > 0
            ? `學習尚未啟動（還差約 ${need} 筆已驗證）。`
            : '學習樣本尚不足以微調加權。';
    }
    const m = model.mode[mode];
    const mutedHere = model.muted.filter((t) => t.key.startsWith(`${mode}|`));
    const top = model.tags
        .filter((t) => t.key.startsWith(`${mode}|`) && !t.muted)
        .slice(0, 3)
        .map(
            (t) =>
                `${t.label.replace(/^當沖·|^隔夜·/, '')}${t.delta > 0 ? '+' : ''}${t.delta}`,
        )
        .join('、');
    const muteBit =
        mutedHere.length > 0
            ? `；暫汰 ${mutedHere
                  .slice(0, 2)
                  .map((t) => t.label.replace(/^當沖·|^隔夜·/, ''))
                  .join('、')}`
            : '';
    const modeBit =
        m.active && m.delta !== 0
            ? `模式加權 ${m.delta > 0 ? '+' : ''}${m.delta}（${m.n}筆）`
            : `模式樣本 ${m.n} 筆`;
    return top
        ? `學習微調：${modeBit}；標籤 ${top}${muteBit}`
        : `學習微調：${modeBit}${muteBit}`;
}

export const LEARN_THRESHOLDS = {
    minMode: MIN_MODE,
    minTag: MIN_TAG,
    modeCap: MODE_CAP,
    tagCap: TAG_CAP,
    totalCap: TOTAL_CAP,
    muteExtra: MUTE_EXTRA,
    muteCap: MUTE_CAP,
    recentWindow: RECENT_WINDOW,
    muteMinRecent: MUTE_MIN_RECENT,
    muteLossStreak: MUTE_LOSS_STREAK,
    muteHitRate: MUTE_HIT_RATE,
} as const;
