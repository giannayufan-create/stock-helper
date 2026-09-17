// server/src/lib/ai-interpretation/llm-explain.ts
// LLM explains deterministic scores only — NEVER assigns 1–10 scores.

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

/** Deterministic fallback narrative when LLM unavailable. */
export function fallbackStockNarrative(i: StockAIInterpretation): string {
    return [
        `【整體】${i.headline}`,
        `【分數】AI 綜合解讀分數 ${i.score}/10（${i.score_band}），Confidence ${i.confidence}。此分數由固定規則計算，非 LLM 打分。`,
        `【已確認】${i.positive_factors.join('、') || '無'}`,
        `【尚缺】${i.missing_confirmations.join('、') || '無'}`,
        `【限制】${i.limiting_factors.join('、') || '無'}`,
        `【風險】${i.risk_flags.join('、') || '無'}`,
        `【資料】${i.data_quality_summary}`,
        'AI 輔助解讀，不影響正式分數。',
    ].join('\n');
}

export function fallbackRadarNarrative(i: RadarAIInterpretation): string {
    return [
        `【篩選】${i.filter_summary}`,
        `【分數】AI 雷達綜合分數 ${i.score}/10，符合 ${i.matched_count} 檔，Confidence ${i.confidence}。`,
        `【判讀】${i.headline}`,
        `【結構】${i.group_structure}`,
        `【共同優勢】${i.common_strengths.join('、') || '無'}`,
        `【尚缺】${i.missing_confirmations.join('、') || '無'}`,
        `【背離】${i.divergence_flags.join('、') || '無'}`,
        `【產業】${i.sector_summary}`,
        `【市場】${i.market_summary}`,
        `【風險】${i.risk_flags.join('、') || '無'}`,
        `【資料】${i.data_quality_summary}`,
        'AI 輔助解讀，不影響正式分數與雷達排序。',
    ].join('\n');
}
