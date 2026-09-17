// server/src/lib/ai-interpretation/llm-explain.ts
// LLM explains deterministic scores only — NEVER assigns 1–10 scores.

import { scoreBandLabel } from './score-bands.ts';
import type {
    RadarAIInterpretation,
    StockAIInterpretation,
} from './types.ts';

export async function explainStockWithGemini(opts: {
    apiKey: string;
    interpretation: StockAIInterpretation;
}): Promise<string> {
    const i = opts.interpretation;
    const prompt =
        '你是台股盤中「輔助解讀」助手。這不是交易建議。' +
        '分數已由系統固定規則算好，你絕對不可改分數、不可重新打分、不可說買進/賣出/必買/勝率/報酬預測。' +
        '請用繁中、條理清楚、像對朋友說明，覆蓋：1整體結構 2為何是此分數 3已確認 4尚缺 5產業 6市場 7夜盤/盤前 8事件 9風險 10資料品質。' +
        '禁止：AI第一名、最值得買、強烈買進。\n' +
        `symbol=${i.symbol} score=${i.score}/10 band=${i.score_band} status=${i.status} confidence=${i.confidence}\n` +
        `headline=${i.headline}\n` +
        `positive=${i.positive_factors.join('；')}\n` +
        `limiting=${i.limiting_factors.join('；')}\n` +
        `missing=${i.missing_confirmations.join('；')}\n` +
        `risks=${i.risk_flags.join('；')}\n` +
        `data=${i.data_quality_summary}\n` +
        `components=${JSON.stringify(i.components)}`;

    return callGemini(opts.apiKey, prompt, 500);
}

export async function explainRadarWithGemini(opts: {
    apiKey: string;
    interpretation: RadarAIInterpretation;
}): Promise<string> {
    const i = opts.interpretation;
    const prompt =
        '你是台股雷達「整批篩選結果」輔助解讀助手。這不是選股推薦。' +
        '雷達分數已由系統依 aggregate 固定計算，你不可改分數、不可平均個股分數、不可推薦買進。' +
        '請用繁中說明：篩選條件、分數、信心、一句判讀、結構分布、共同優勢、尚缺確認、產業、市場、夜盤/盤前、背離、Chase Risk、資料品質。' +
        '若有背離必須明說。禁止：AI首選、最值得買、整體非常強（若買盤未確認）。\n' +
        `score=${i.score}/10 confidence=${i.confidence} matched=${i.matched_count}\n` +
        `filter=${i.filter_summary}\n` +
        `headline=${i.headline}\n` +
        `structure=${i.group_structure}\n` +
        `strengths=${i.common_strengths.join('；')}\n` +
        `missing=${i.missing_confirmations.join('；')}\n` +
        `divergences=${i.divergence_flags.join('；')}\n` +
        `sector=${i.sector_summary}\n` +
        `market=${i.market_summary}\n` +
        `risks=${i.risk_flags.join('；')}\n` +
        `data=${i.data_quality_summary}`;

    return callGemini(opts.apiKey, prompt, 550);
}

async function callGemini(
    apiKey: string,
    prompt: string,
    maxTokens: number,
): Promise<string> {
    const models = [
        'gemini-2.0-flash',
        'gemini-2.5-flash',
        'gemini-flash-latest',
    ];
    let lastErr = 'Gemini unavailable';
    for (const model of models) {
        const url =
            'https://generativelanguage.googleapis.com/v1beta/models/' +
            `${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.35,
                        maxOutputTokens: maxTokens,
                    },
                }),
                signal: AbortSignal.timeout(20000),
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                lastErr = `Gemini ${model} HTTP ${res.status}: ${body.slice(0, 120)}`;
                continue;
            }
            const payload = (await res.json()) as {
                candidates?: Array<{
                    content?: { parts?: Array<{ text?: string }> };
                }>;
            };
            const text =
                payload.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ??
                '';
            if (text) return text;
            lastErr = `Gemini ${model} empty response`;
        } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
        }
    }
    throw new Error(lastErr);
}

const CONF_ZH: Record<string, string> = {
    HIGH: '高',
    MEDIUM: '中',
    LOW: '低',
};

/** Deterministic fallback narrative when LLM unavailable. */
export function fallbackStockNarrative(i: StockAIInterpretation): string {
    const band = scoreBandLabel(i.score_band);
    const lines = [
        i.cash_session_closed
            ? '現貨已收盤。以下用收盤行情與市場背景整理，不是盤中即時分數。'
            : null,
        i.headline,
        `解讀分數 ${i.score}/10（${band}），信心${CONF_ZH[i.confidence] ?? i.confidence}。`,
        i.positive_factors.length
            ? `有利：${i.positive_factors.join('、')}`
            : '有利條件目前不多。',
        i.missing_confirmations.length
            ? `還缺：${i.missing_confirmations.join('、')}`
            : null,
        i.limiting_factors.length
            ? `限制：${i.limiting_factors.join('、')}`
            : null,
        i.risk_flags.length ? `注意：${i.risk_flags.join('、')}` : null,
        i.data_quality_summary,
        '這是規則整理，不是買賣建議。',
    ];
    return lines.filter(Boolean).join('\n');
}

export function fallbackRadarNarrative(i: RadarAIInterpretation): string {
    return [
        i.filter_summary,
        `這批符合 ${i.matched_count} 檔，解讀分數 ${i.score}/10，信心${CONF_ZH[i.confidence] ?? i.confidence}。`,
        i.headline,
        i.group_structure ? `結構：${i.group_structure}` : null,
        i.common_strengths.length
            ? `共同優勢：${i.common_strengths.join('、')}`
            : null,
        i.missing_confirmations.length
            ? `還缺：${i.missing_confirmations.join('、')}`
            : null,
        i.divergence_flags.length
            ? `背離：${i.divergence_flags.join('、')}`
            : null,
        i.sector_summary ? `產業：${i.sector_summary}` : null,
        i.market_summary ? `市場：${i.market_summary}` : null,
        i.risk_flags.length ? `注意：${i.risk_flags.join('、')}` : null,
        i.data_quality_summary,
        '這是規則整理，不是選股推薦。',
    ]
        .filter(Boolean)
        .join('\n');
}
