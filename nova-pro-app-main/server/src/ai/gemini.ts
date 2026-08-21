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
}): Promise<string> {
    const prompt =
        '你是台股當沖紀律教練，不是投顧。根據下列量化結果給 2-4 句繁中提醒，' +
        '強調風險與條件，禁止保證獲利，禁止「建議買入/賣出」用語。\n' +
        `代碼=${opts.code} 名稱=${opts.name ?? ''} ` +
        `stance=${opts.stance} score=${opts.score} ` +
        `reasons=${opts.reasons.join('、')} ` +
        `entry=${opts.entry ?? ''} stop=${opts.stop ?? ''} take=${opts.take ?? ''} rr=${opts.rr ?? ''}`;

    const url =
        'https://generativelanguage.googleapis.com/v1beta/models/' +
        `gemini-2.0-flash:generateContent?key=${encodeURIComponent(opts.apiKey)}`;

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
