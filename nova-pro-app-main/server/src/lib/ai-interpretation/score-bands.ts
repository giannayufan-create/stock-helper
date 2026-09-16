// server/src/lib/ai-interpretation/score-bands.ts

import type {
    InterpretationScoreBand,
} from './types.ts';

export function scoreBand(score: number): InterpretationScoreBand {
    if (score < 3) return '1.0-2.9';
    if (score < 5) return '3.0-4.9';
    if (score < 6.5) return '5.0-6.4';
    if (score < 8) return '6.5-7.9';
    if (score < 9) return '8.0-8.9';
    return '9.0-10.0';
}

export function scoreBandLabel(band: InterpretationScoreBand): string {
    switch (band) {
        case '1.0-2.9':
            return '資料不足 / 結構偏弱';
        case '3.0-4.9':
            return '訊號零散';
        case '5.0-6.4':
            return '部分條件成立';
        case '6.5-7.9':
            return '同步程度提升';
        case '8.0-8.9':
            return '多項條件同步';
        case '9.0-10.0':
            return '高度同步';
    }
}

/** Round to 1 decimal, clamp 1.0–10.0 (minimum floor 1.0 for display). */
export function finalizeScore(raw: number): number {
    if (!Number.isFinite(raw)) return 1.0;
    const clamped = Math.max(1.0, Math.min(10.0, raw));
    return Math.round(clamped * 10) / 10;
}
