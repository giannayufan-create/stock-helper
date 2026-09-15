// Structured symbol AI for radar Detail — never mutates A/B/C scores.

export type RadarAiVerdict =
    | '偏強'
    | '可關注'
    | '等待確認'
    | '偏熱勿追'
    | '轉弱'
    | '資料不足';

export interface SymbolAnalyzeInput {
    symbol: string;
    name?: string;
    a_score?: number | null;
    b_open_score?: number | null;
    b_status?: string | null;
    c_score?: number | null;
    heat?: number | null;
    rank?: number | null;
    rank_velocity?: number | null;
    rvol?: number | null;
    vwap_pos_pct?: number | null;
    momentum?: number | null;
    relative_strength?: number | null;
    breakout_type?: string | null;
    pullback_state?: string | null;
    chase_risk?: string | null;
    invalid_reference?: number | null;
    market_regime?: string | null;
    recent_events?: string[];
    reasons?: string[];
    risks?: string[];
    data_health?: string | null;
    score_coverage_pct?: number | null;
    feature_hash?: string;
}

export interface SymbolAnalyzeResult {
    verdict: RadarAiVerdict;
    confidence: number;
    summary: string;
    reasons: string[];
    risks: string[];
    watch_for: string[];
    analyzed_at: string;
    cached?: boolean;
    feature_hash?: string;
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

/**
 * Deterministic radar AI from structured snapshot.
 * Forbidden language: 買進/賣出/做多/做空.
 */
export function analyzeSymbolSnapshot(
    input: SymbolAnalyzeInput,
): SymbolAnalyzeResult {
    const health = (input.data_health ?? 'healthy').toLowerCase();
    const coverage = input.score_coverage_pct;

    if (
        health === 'stale' ||
        health === 'disconnected' ||
        (coverage != null && coverage < 50)
    ) {
        return {
            verdict: '資料不足',
            confidence: 20,
            summary: '目前行情資料不完整，暫不提供 AI 即時判讀。',
            reasons: [],
            risks: ['資料健康度不足或特徵覆蓋率過低'],
            watch_for: ['等待資料恢復後再分析'],
            analyzed_at: new Date().toISOString(),
            feature_hash: input.feature_hash,
        };
    }

    const c = input.c_score ?? 0;
    const heat = input.heat ?? 0;
    const chase = (input.chase_risk ?? '').toLowerCase();
    const stateHints = (input.recent_events ?? []).join(' ');
    const pullback = (input.pullback_state ?? '').toUpperCase();
    const reasons: string[] = [];
    const risks: string[] = [];
    const watch_for: string[] = [];

    if ((input.reasons ?? []).length) {
        reasons.push(...input.reasons!.slice(0, 3));
    } else {
        if ((input.rvol ?? 0) >= 1.5) reasons.push('量能相對放大');
        if ((input.relative_strength ?? 0) >= 70) reasons.push('相對市場偏強');
        if (stateHints.includes('REBREAK') || stateHints.includes('BREAKOUT')) {
            reasons.push('整理後突破／再突破成立');
        }
        if ((input.vwap_pos_pct ?? 0) > 0) reasons.push('價格維持在 VWAP 上方');
    }

    if ((input.risks ?? []).length) {
        risks.push(...input.risks!.slice(0, 3));
    }
    if (heat >= 90) risks.push('Heat 偏高，短線波動可能放大');
    if ((input.vwap_pos_pct ?? 0) >= 2) risks.push('距 VWAP 偏遠，追價風險上升');
    if (chase === 'high' || chase === 'extreme') {
        risks.push(`Chase Risk ${chase.toUpperCase()}`);
    }

    watch_for.push('是否守住 VWAP');
    watch_for.push('成交量是否快速衰退');
    if (heat >= 85) watch_for.push('Heat 是否回落後仍維持結構');

    let verdict: RadarAiVerdict = '等待確認';
    let confidence = 55;

    if (c >= 82 && heat >= 85 && (chase === 'high' || chase === 'extreme')) {
        verdict = '偏熱勿追';
        confidence = 78;
    } else if (
        pullback === 'FAILED' ||
        stateHints.includes('COOLING') ||
        (c < 55 && heat < 50)
    ) {
        verdict = '轉弱';
        confidence = 70;
    } else if (c >= 80 && heat >= 70 && chase !== 'extreme') {
        verdict = '偏強';
        confidence = 82;
    } else if (c >= 70 || pullback === 'RECLAIMING' || pullback === 'HOLDING') {
        verdict = '可關注';
        confidence = 72;
    } else if (c >= 60) {
        verdict = '等待確認';
        confidence = 60;
    } else {
        verdict = '等待確認';
        confidence = 50;
    }

    if ((input.b_status === 'pass' || input.b_status === 'early_pass') && c >= 70) {
        confidence = clamp(confidence + 4, 0, 92);
        if (!reasons.some((r) => r.includes('Open'))) {
            reasons.unshift('開盤證明通過，盤中延續觀察價值較高');
        }
    }

    const summaryParts: string[] = [];
    if (verdict === '偏熱勿追') {
        summaryParts.push('結構仍有強度，但短線 Heat／追價風險偏高。');
    } else if (verdict === '偏強') {
        summaryParts.push('結構偏強，量價與排名動能仍支持關注。');
    } else if (verdict === '可關注') {
        summaryParts.push('結構可關注，但短線仍需確認量能與 VWAP 防守。');
    } else if (verdict === '轉弱') {
        summaryParts.push('動能轉弱跡象增加，宜降低優先度。');
    } else {
        summaryParts.push('訊號尚未充分確認，建議等待更清楚的量價配合。');
    }
    if (risks[0]) summaryParts.push(risks[0] + '。');

    return {
        verdict,
        confidence: Math.round(confidence),
        summary: summaryParts.join(' '),
        reasons: reasons.slice(0, 4),
        risks: risks.slice(0, 4),
        watch_for: watch_for.slice(0, 4),
        analyzed_at: new Date().toISOString(),
        feature_hash: input.feature_hash,
    };
}
