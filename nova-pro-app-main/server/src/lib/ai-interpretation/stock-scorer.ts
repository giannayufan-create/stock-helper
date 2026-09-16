// server/src/lib/ai-interpretation/stock-scorer.ts
// Deterministic Stock AI Interpretation Score — LLM must NEVER assign this.

import {
    type AiInterpretationConfig,
    DEFAULT_AI_INTERPRETATION_CONFIG,
    configHash,
} from './config.ts';
import { finalizeScore, scoreBand } from './score-bands.ts';
import {
    AI_INTERPRETATION_VERSION,
    type ComponentScores,
    type InterpretationConfidence,
    type InterpretationStatus,
    type StockAIInterpretation,
    type StockInterpretationInput,
} from './types.ts';

function clamp10(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(10, n));
}

function hasBpAction(states: string[]): boolean {
    return states.some(
        (s) =>
            s === 'BUY_SURGE' ||
            s === 'ASK_EATING' ||
            s === 'VOLUME_BREAKOUT',
    );
}

function chaseExtended(
    chase: string | null | undefined,
    cfg: AiInterpretationConfig,
): boolean {
    if (!chase) return false;
    const u = chase.toUpperCase();
    return cfg.chase_extended.some((x) => x.toUpperCase() === u);
}

function scoreCore(
    input: StockInterpretationInput,
    cfg: AiInterpretationConfig,
): number {
    let s = 2;
    if (input.c_score != null) {
        if (input.c_score >= 90) s += 4.5;
        else if (input.c_score >= cfg.c_strong_min) s += 3.5;
        else if (input.c_score >= cfg.c_watch_min) s += 2;
        else if (input.c_score >= 50) s += 1;
    }
    if (
        input.vwap_pos_pct != null &&
        input.vwap_pos_pct > cfg.vwap_above_min_pct
    ) {
        s += 1.5;
    } else if (input.vwap_pos_pct != null && input.vwap_pos_pct < -1) {
        s -= 1;
    }
    const st = (input.c_state ?? '').toUpperCase();
    if (st === 'STRONG' || st === 'HEATING') s += 0.8;
    return clamp10(s);
}

function scoreBuyVolume(
    input: StockInterpretationInput,
    cfg: AiInterpretationConfig,
): number {
    let s = 2;
    let available = 0;
    if (input.bp_score != null) {
        available += 1;
        if (input.bp_score >= cfg.bp_confirmed_min) s += 4;
        else if (input.bp_score >= 50) s += 2;
        else if (input.bp_score < 40) s += 0.3;
    }
    if (hasBpAction(input.bp_states)) {
        available += 1;
        s += 1.5;
    }
    if (input.rvol != null) {
        available += 1;
        if (input.rvol >= cfg.rvol_strong_min) s += 2;
        else if (input.rvol >= 1.0) s += 0.8;
    }
    if (
        input.volume_acceleration != null &&
        input.volume_acceleration > cfg.volume_accel_positive_min
    ) {
        available += 1;
        s += 1.2;
    }
    if (
        input.trade_aggression != null &&
        input.trade_aggression > 0
    ) {
        s += 0.5;
    }
    // Missing volume confirmation caps this component
    if (available === 0) return clamp10(1.5);
    if (input.bp_score != null && input.bp_score < 40 && input.rvol == null) {
        return clamp10(Math.min(s, 3.5));
    }
    return clamp10(s);
}

function scoreSector(
    input: StockInterpretationInput,
    cfg: AiInterpretationConfig,
): { score: number; insufficient: boolean } {
    if (
        input.sector_coverage_pct != null &&
        input.sector_coverage_pct < 30
    ) {
        return { score: 5, insufficient: true }; // neutral, don't punish
    }
    if (!input.sector_state && input.sector_breadth == null) {
        return { score: 5, insufficient: true };
    }
    let s = 5;
    const st = (input.sector_state ?? '').toUpperCase();
    if (st.includes('ROTATING_IN') || st === 'HOT') s += 2.5;
    else if (st.includes('ROTATING_OUT') || st === 'COLD') s -= 2.5;
    if (
        input.sector_breadth != null &&
        input.sector_breadth >= cfg.sector_breadth_strong_min
    ) {
        s += 1.5;
    } else if (input.sector_breadth != null && input.sector_breadth < 0.35) {
        s -= 1.2;
    }
    if (
        input.sector_rs != null &&
        input.sector_rs >= cfg.sector_rs_positive_min
    ) {
        s += 0.8;
    }
    if (input.leader_concentration) s -= 0.4;
    return { score: clamp10(s), insufficient: false };
}

function scoreMarket(input: StockInterpretationInput): number {
    const r = (input.taiwan_regime ?? '').toUpperCase();
    if (!r) return 5;
    if (r.includes('RISK_ON')) return clamp10(8);
    if (r.includes('NEUTRAL')) return clamp10(5.5);
    if (r.includes('RISK_OFF')) return clamp10(2.5);
    return 5;
}

function scoreStructure(
    input: StockInterpretationInput,
    cfg: AiInterpretationConfig,
): number {
    let s = 3;
    if (input.rank != null && input.rank <= cfg.rank_strong_max) {
        s += 2.5;
        if (input.rank <= 10) s += 0.8;
    }
    if (
        input.rank_change != null &&
        input.rank_change <= -cfg.rank_improve_min
    ) {
        s += 2.5; // rising in rank (#30→#6)
    } else if (input.rank_change != null && input.rank_change === 0) {
        s += 0.8; // stable high rank — distinct from rising
    }
    if (input.rank_velocity != null && input.rank_velocity > 0) s += 1.2;
    // Rank alone cannot max this component
    return clamp10(Math.min(s, 9));
}

function scoreDataConfidence(
    input: StockInterpretationInput,
    cfg: AiInterpretationConfig,
): number {
    let s = 7;
    if (input.data_stale || input.data_blocked) s = 2;
    const health = (input.data_health ?? '').toLowerCase();
    if (health === 'stale' || health === 'disconnected') s = Math.min(s, 2);
    if (health === 'degraded') s = Math.min(s, 4);
    const cov = input.feature_coverage_pct;
    if (cov != null) {
        if (cov >= cfg.coverage_confidence_high_min) s = Math.max(s, 8);
        else if (cov >= cfg.coverage_confidence_medium_min) s = Math.min(s, 6);
        else if (cov < cfg.coverage_severe_below) s = Math.min(s, 2.5);
    }
    return clamp10(s);
}

function resolveConfidence(
    input: StockInterpretationInput,
    cfg: AiInterpretationConfig,
    sectorInsufficient: boolean,
): InterpretationConfidence {
    if (
        input.data_stale ||
        input.data_blocked ||
        (input.data_health ?? '').toLowerCase() === 'stale' ||
        (input.data_health ?? '').toLowerCase() === 'disconnected'
    ) {
        return 'LOW';
    }
    const cov = input.feature_coverage_pct ?? 60;
    if (cov < cfg.coverage_confidence_medium_min || sectorInsufficient) {
        return cov < cfg.coverage_severe_below ? 'LOW' : 'MEDIUM';
    }
    if (cov >= cfg.coverage_confidence_high_min) return 'HIGH';
    return 'MEDIUM';
}

function resolveStatus(
    input: StockInterpretationInput,
    cfg: AiInterpretationConfig,
    score: number,
): InterpretationStatus {
    if (input.decision_status) return input.decision_status;
    if (
        input.data_stale ||
        input.data_blocked ||
        (input.feature_coverage_pct != null &&
            input.feature_coverage_pct < cfg.coverage_severe_below)
    ) {
        return 'NOT_READY';
    }
    if (chaseExtended(input.chase_risk, cfg) && score >= 6.5) {
        return 'EXTENDED';
    }
    const bpOk =
        input.bp_score != null && input.bp_score >= cfg.bp_confirmed_min;
    const cOk = input.c_score != null && input.c_score >= cfg.c_strong_min;
    const vwapOk =
        input.vwap_pos_pct != null &&
        input.vwap_pos_pct > cfg.vwap_above_min_pct;
    const volOk =
        (input.rvol != null && input.rvol >= cfg.rvol_strong_min) ||
        (input.volume_acceleration != null &&
            input.volume_acceleration > cfg.volume_accel_positive_min);
    if (cOk && bpOk && vwapOk && volOk) return 'CONFIRMED_STRENGTH';
    if (cOk || (input.c_score != null && input.c_score >= cfg.c_watch_min)) {
        return 'WATCH';
    }
    return 'NOT_READY';
}

function buildFactors(
    input: StockInterpretationInput,
    cfg: AiInterpretationConfig,
): {
    positive: string[];
    limiting: string[];
    missing: string[];
    risks: string[];
} {
    const positive: string[] = [];
    const limiting: string[] = [];
    const missing: string[] = [];
    const risks: string[] = [];

    // fix TS - use arrays properly
    const pos: string[] = [];
    if (input.c_score != null && input.c_score >= cfg.c_strong_min) {
        pos.push(`C ${Math.round(input.c_score)}`);
    }
    if (input.bp_score != null && input.bp_score >= cfg.bp_confirmed_min) {
        pos.push(`BP ${Math.round(input.bp_score)}`);
    }
    if (input.rvol != null && input.rvol >= cfg.rvol_strong_min) {
        pos.push(`RVOL ${input.rvol.toFixed(1)}x`);
    }
    if (
        input.vwap_pos_pct != null &&
        input.vwap_pos_pct > cfg.vwap_above_min_pct
    ) {
        pos.push(`Above VWAP ${input.vwap_pos_pct.toFixed(2)}%`);
    }
    if (
        (input.sector_state ?? '').toUpperCase().includes('ROTATING_IN') ||
        (input.sector_state ?? '').toUpperCase() === 'HOT'
    ) {
        pos.push(`Sector ${input.sector_state}`);
    }
    if ((input.taiwan_regime ?? '').toUpperCase().includes('RISK_ON')) {
        pos.push(`Market ${input.taiwan_regime}`);
    }
    if (
        input.rank_change != null &&
        input.rank_change <= -cfg.rank_improve_min
    ) {
        pos.push(
            `Rank ${input.rank_prev ?? '?'} → ${input.rank ?? '?'}`,
        );
    }

    if (input.bp_score == null || input.bp_score < cfg.bp_confirmed_min) {
        missing.push('即時買盤尚未確認');
        limiting.push(
            input.bp_score != null
                ? `BP ${Math.round(input.bp_score)}`
                : 'BP unavailable',
        );
    }
    if (input.rvol == null) {
        missing.push('RVOL unavailable');
        limiting.push('量能確認不足');
    }
    if (
        (input.sector_state ?? '').toUpperCase().includes('ROTATING_OUT')
    ) {
        limiting.push(`Sector ${input.sector_state}`);
    }
    if ((input.taiwan_regime ?? '').toUpperCase().includes('RISK_OFF')) {
        limiting.push(`Market ${input.taiwan_regime}`);
    }
    if ((input.taiwan_regime ?? '').toUpperCase().includes('NEUTRAL')) {
        limiting.push('Market Neutral');
    }

    const chase = (input.chase_risk ?? '').toUpperCase();
    if (chase === 'MEDIUM') risks.push('Chase Risk MEDIUM');
    if (chase === 'HIGH' || chase === 'EXTREME') {
        risks.push(`Chase Risk ${chase} — 強勢仍在，但價格已明顯延伸`);
    }
    if (input.data_stale || (input.data_health ?? '').toLowerCase() === 'stale') {
        risks.push('資料品質問題：Data stale');
    }
    if (
        (input.taiwan_regime ?? '').toUpperCase().includes('RISK_OFF') &&
        input.c_score != null &&
        input.c_score >= cfg.c_strong_min
    ) {
        risks.push('個股強度與市場背景背離');
    }
    if (
        (input.sector_state ?? '').toUpperCase().includes('ROTATING_OUT') &&
        input.c_score != null &&
        input.c_score >= cfg.c_strong_min
    ) {
        risks.push('個股強度與產業 Context 背離');
    }

    void positive;
    return { positive: pos, limiting, missing, risks };
}

function buildHeadline(
    score: number,
    status: InterpretationStatus,
    input: StockInterpretationInput,
    factors: ReturnType<typeof buildFactors>,
): string {
    if (input.data_stale) {
        return '資料不足，分數可信度偏低。';
    }
    if (
        factors.missing.some((m) => m.includes('買盤') || m.includes('RVOL')) &&
        input.c_score != null &&
        input.c_score >= 80
    ) {
        return '相對強度高，但即時買盤與量能尚未確認。';
    }
    if (
        factors.risks.some((r) => r.includes('背離'))
    ) {
        return '個股強度與 Context 存在背離，同步程度受限。';
    }
    if (status === 'EXTENDED') {
        return '多項條件同步，但價格已明顯延伸，需留意追高風險。';
    }
    if (score >= 8) {
        return '個股強度、即時買盤與量能同步，產業背景亦有確認。';
    }
    if (score >= 6.5) {
        return '同步程度提升，部分確認條件仍待補強。';
    }
    if (score >= 5) {
        return '部分條件成立，整體同步度中等。';
    }
    return '訊號零散或資料不足，暫不宜過度解讀同步程度。';
}

export function scoreStockInterpretation(
    input: StockInterpretationInput,
    cfg: AiInterpretationConfig = DEFAULT_AI_INTERPRETATION_CONFIG,
    opts?: { snapshot_id?: string; snapshot_at?: string },
): StockAIInterpretation {
    const core = scoreCore(input, cfg);
    const buy = scoreBuyVolume(input, cfg);
    const sector = scoreSector(input, cfg);
    const market = scoreMarket(input);
    const structure = scoreStructure(input, cfg);
    const dataConf = scoreDataConfidence(input, cfg);

    const components: ComponentScores = {
        core_strength: Math.round(core * 10) / 10,
        buy_volume: Math.round(buy * 10) / 10,
        sector_context: Math.round(sector.score * 10) / 10,
        market_context: Math.round(market * 10) / 10,
        structure_rank: Math.round(structure * 10) / 10,
        data_confidence: Math.round(dataConf * 10) / 10,
    };
    // keep one decimal via finalize on weighted
    const w = cfg.weights;
    let raw =
        core * w.core_strength +
        buy * w.buy_volume +
        sector.score * w.sector_context +
        market * w.market_context +
        structure * w.structure_rank +
        dataConf * w.data_confidence;

    // Overnight / PreOpen: small context nudge only — cannot alone create high score
    const ovn = (input.overnight_bias ?? '').toUpperCase();
    const pre = (input.preopen_confirmation ?? '').toUpperCase();
    if (ovn.includes('POSITIVE') && pre.includes('CONFIRM')) {
        raw += 0.3;
    }

    const severeMissing =
        (input.feature_coverage_pct != null &&
            input.feature_coverage_pct < cfg.coverage_severe_below) ||
        (input.c_score == null && input.bp_score == null);

    if (input.data_stale || (input.data_health ?? '').toLowerCase() === 'stale') {
        raw = Math.min(raw, cfg.stale_score_cap);
    }
    if (severeMissing) {
        raw = Math.min(raw, cfg.severe_missing_score_cap);
    }

    // C-high alone cannot reach 8–10: if buy/volume weak, cap
    if (
        buy < 4 &&
        (input.bp_score == null || input.bp_score < 40) &&
        input.rvol == null
    ) {
        raw = Math.min(raw, 6.5);
    }

    // Contrary context: prevent high sync score
    const contrary =
        (input.taiwan_regime ?? '').toUpperCase().includes('RISK_OFF') ||
        (input.sector_state ?? '').toUpperCase().includes('ROTATING_OUT');
    if (contrary && (input.bp_score == null || input.bp_score < cfg.bp_confirmed_min)) {
        raw = Math.min(raw, 5.5);
    }

    const score = finalizeScore(raw);
    const confidence = resolveConfidence(input, cfg, sector.insufficient);
    const status = resolveStatus(input, cfg, score);
    const factors = buildFactors(input, cfg);
    const snapshot_at = opts?.snapshot_at ?? new Date().toISOString();
    const snapshot_id =
        opts?.snapshot_id ??
        `stock_${input.symbol}_${snapshot_at.replace(/[:.]/g, '')}`;

    let data_quality_summary = '資料品質可接受';
    if (confidence === 'LOW' || input.data_stale) {
        data_quality_summary = '資料不足，分數可信度偏低。';
    } else if (confidence === 'MEDIUM') {
        data_quality_summary = '部分欄位覆蓋不足，解讀需保留彈性。';
    }

    return {
        symbol: input.symbol,
        name: input.name ?? input.symbol,
        score,
        score_band: scoreBand(score),
        status,
        confidence,
        headline: buildHeadline(score, status, input, factors),
        positive_factors: factors.positive,
        limiting_factors: factors.limiting,
        missing_confirmations: factors.missing,
        risk_flags: factors.risks,
        data_quality_summary,
        components,
        interpretation_score_version: AI_INTERPRETATION_VERSION,
        config_hash: configHash(cfg),
        snapshot_id,
        snapshot_at,
        generated_at: new Date().toISOString(),
        cash_session_closed: Boolean(input.cash_session_closed),
        last_updated_at: input.last_updated_at ?? null,
        mutates_strategy: false,
        research_persistence: 'NOT_ENABLED',
    };
}
