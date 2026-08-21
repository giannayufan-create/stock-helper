/** Score range is -100～+100. Stance thresholds: ≥18 看漲, ≤-18 看跌, else 盤整. */

export type AiStance = '看漲' | '看跌' | '盤整';

export function scoreStrengthLabel(score: number): string {
    const abs = Math.abs(score);
    if (abs < 18) return '沒方向';
    if (abs < 35) return '偏弱';
    if (abs < 55) return '中等';
    if (abs < 75) return '偏強';
    return '很強';
}

/** One-line meaning shown next to the score — no need to memorize ranges. */
export function describeAiScore(score: number, stance: AiStance): string {
    const strength = scoreStrengthLabel(score);
    if (stance === '盤整' || strength === '沒方向') {
        return '盤整 · 沒方向，先觀望';
    }
    if (stance === '看漲') {
        return `看漲 · ${strength}偏多`;
    }
    return `看跌 · ${strength}偏空`;
}

export function buildAiAlerts(input: {
    score: number;
    stance: AiStance;
    entry?: number;
    stop?: number;
    take?: number;
    rr?: number;
}): string[] {
    const alerts: string[] = [];
    const abs = Math.abs(input.score);

    if (input.stance === '盤整' || abs < 18) {
        alerts.push('方向不明：先不要進場');
    } else if (abs < 35) {
        alerts.push('訊號偏弱：若要做，倉位宜小');
    }

    if (input.rr != null) {
        if (input.rr < 1.5) {
            alerts.push(`RR ${input.rr.toFixed(2)} 太低：風險大於報酬，建議略過`);
        } else if (input.rr < 2) {
            alerts.push(`RR ${input.rr.toFixed(2)} 未滿 2：報酬不夠厚，慎做`);
        }
    }

    if (
        input.entry != null &&
        input.stop != null &&
        input.entry > 0 &&
        Number.isFinite(input.entry) &&
        Number.isFinite(input.stop)
    ) {
        const riskPct =
            (Math.abs(input.entry - input.stop) / input.entry) * 100;
        if (riskPct > 1.5) {
            alerts.push(
                `停損距離約 ${riskPct.toFixed(1)}%：比當沖常用 1% 寬，確認你扛得住`,
            );
        } else if (riskPct > 0 && riskPct < 0.4) {
            alerts.push(
                `停損距離約 ${riskPct.toFixed(1)}%：太近，容易被洗出場`,
            );
        }
    }

    if (
        input.entry != null &&
        input.take != null &&
        input.stop != null &&
        input.entry > 0
    ) {
        const risk = Math.abs(input.entry - input.stop);
        const reward = Math.abs(input.take - input.entry);
        if (risk > 0 && reward / risk < 2 && (input.rr == null || input.rr >= 2)) {
            alerts.push('停利相對停損不夠遠：調遠停利或縮停損');
        }
    }

    if (input.stance === '看漲' && abs >= 55) {
        alerts.push('偏多偏強：進場後記得先掛停損');
    }
    if (input.stance === '看跌' && abs >= 55) {
        alerts.push('偏空偏強：若做空／反向，同樣先掛停損');
    }

    return alerts;
}

/** Always-on coach paragraph (local). Gemini text can replace/prepend this. */
export function buildLocalCoach(input: {
    score: number;
    stance: AiStance;
    reasons?: string[];
    entry?: number;
    stop?: number;
    take?: number;
    rr?: number;
}): string {
    const meaning = describeAiScore(input.score, input.stance);
    const alerts = buildAiAlerts(input);
    const reasonBit =
        input.reasons && input.reasons.length > 0
            ? `依據：${input.reasons.slice(0, 2).join('、')}。`
            : '';
    const plan =
        input.entry != null && input.stop != null && input.take != null
            ? `若要做：參考進 ${input.entry}、停損 ${input.stop}、停利 ${input.take}${
                  input.rr != null ? `（RR ${input.rr}）` : ''
              }。`
            : '方向不明時先空手觀望。';
    const warn = alerts[0] ? `${alerts[0]}。` : '';
    return `教練：${meaning}。${reasonBit}${plan}${warn}`.replace(/。。+/g, '。');
}
