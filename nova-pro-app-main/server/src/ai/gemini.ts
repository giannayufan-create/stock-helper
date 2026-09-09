// server/src/ai/gemini.ts — Gemini coach via REST (key stays on server)

export async function geminiCoach(opts: {
    apiKey: string;
    code: string;
    name?: string;
    stance: string;
    score: number;
    reasons: string[];
    entry?: number;
    stop?: number;
    take?: number;
    rr?: number;
    up_prob?: number;
    newsSummary?: string;
    heatSummary?: string;
    chipsSummary?: string;
    overnightSummary?: string;
    usSummary?: string;
    regimeSummary?: string;
    instIntentSummary?: string;
    verdictSummary?: string;
    failExitSummary?: string;
}): Promise<string> {
    const prompt =
        '你是台股當沖／隔夜教練，講話要像跟朋友講盤：白話、短句、不要術語堆疊。' +
        '分析順序：①實戰結論②當沖失敗處置③法人意圖（拉抬跟／出貨空／吃貨別追空）④大盤多空（台＋美）⑤三大法人與融資券⑥隔夜→次開⑦過濾新聞⑧買氣⑨技術風險。' +
        '用 3-5 句繁中。不要保證會賺，不要寫「建議買入／賣出」。' +
        '可以白話提上漲機率與隔夜勝率，但要說這只是規則歷史統計、不是保證。籌碼多為前一交易日公開資料（非盤中分點）。盤外請用隔夜布局語氣。法人意圖與大盤氣氛各用一句帶到。\n' +
        `代碼=${opts.code} 名稱=${opts.name ?? ''} ` +
        `stance=${opts.stance} score=${opts.score} up_prob=${opts.up_prob ?? ''}% ` +
        `實戰結論=${opts.verdictSummary ?? '無'} ` +
        `當沖失敗處置=${opts.failExitSummary ?? '無'} ` +
        `法人意圖=${opts.instIntentSummary ?? '無'} ` +
        `大盤氣氛=${opts.regimeSummary ?? '無'} ` +
        `reasons=${opts.reasons.join('、')} ` +
        `籌碼=${opts.chipsSummary ?? '無'} ` +
        `隔夜勝率=${opts.overnightSummary ?? '無'} ` +
        `美股=${opts.usSummary ?? '無'} ` +
        `新聞摘要=${opts.newsSummary ?? '無'} ` +
        `買氣=${opts.heatSummary ?? '無'} ` +
        `entry=${opts.entry ?? ''} stop=${opts.stop ?? ''} take=${opts.take ?? ''} rr=${opts.rr ?? ''}`;

    const url =
        'https://generativelanguage.googleapis.com/v1beta/models/' +
        `gemini-3.6-flash:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 220 },
        }),
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 160)}`);
    }
    const payload = (await res.json()) as {
        candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
        }>;
    };
    const text =
        payload.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    return text || '（Gemini 無回覆）';
}
