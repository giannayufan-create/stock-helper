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
        alerts.push('現在漲跌看不太出來，先不要進');
    } else if (abs < 35) {
        alerts.push('訊號還不夠強，真要做就少做一點');
    }

    if (input.rr != null) {
        if (input.rr < 1.5) {
            alerts.push(
                `賺賠比只有 ${input.rr.toFixed(2)}：可能虧比較多、賺比較少，這筆先跳過`,
            );
        } else if (input.rr < 2) {
            alerts.push(
                `賺賠比 ${input.rr.toFixed(2)} 還沒到 2：賺不夠本，下手要小心`,
            );
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
                `賠掉大概 ${riskPct.toFixed(1)}% 才停損，比當沖常用的 1% 寬，要想好能不能扛`,
            );
        } else if (riskPct > 0 && riskPct < 0.4) {
            alerts.push(
                `停損只離現價約 ${riskPct.toFixed(1)}%，太近了，隨便晃一下就會被掃出去`,
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
            alerts.push(
                '獲利目標離進場太近、停損卻比較遠：等於可能小賺、卻可能大賠。把獲利目標設遠一點，或把停損收近一點',
            );
        }
    }

    if (input.stance === '看漲' && abs >= 55) {
        alerts.push('偏多比較明顯：真要進，先掛好停損再做');
    }
    if (input.stance === '看跌' && abs >= 55) {
        alerts.push('偏空比較明顯：真要放空／反向，一樣先掛停損');
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
            ? `因為 ${input.reasons.slice(0, 2).join('、')}。`
            : '';
    const plan =
        input.entry != null && input.stop != null && input.take != null
            ? `若要做：大概在 ${input.entry} 附近進，賠到 ${input.stop} 先走，賺到 ${input.take} 可停${
                  input.rr != null ? `（賺賠大約 ${input.rr} 倍）` : ''
              }。`
            : '方向還看不清楚，先空手看就好。';
    const warn = alerts[0] ? `${alerts[0]}。` : '';
    return `教練：${meaning}。${reasonBit}${plan}${warn}`.replace(/。。+/g, '。');
}
