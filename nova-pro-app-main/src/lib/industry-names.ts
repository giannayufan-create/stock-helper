// TWSE / TPEx 產業別代碼 → 中文名。僅畫面顯示。

const TWSE_INDUSTRY: Record<string, string> = {
    '01': '水泥工業',
    '02': '食品工業',
    '03': '塑膠工業',
    '04': '紡織纖維',
    '05': '電機機械',
    '06': '電器電纜',
    '08': '玻璃陶瓷',
    '09': '造紙工業',
    '10': '鋼鐵工業',
    '11': '橡膠工業',
    '12': '汽車工業',
    '13': '電子工業',
    '14': '建材營造',
    '15': '航運業',
    '16': '觀光事業',
    '17': '金融保險',
    '18': '貿易百貨',
    '19': '綜合',
    '20': '其他',
    '21': '化學工業',
    '22': '生技醫療業',
    '23': '油電燃氣業',
    '24': '半導體業',
    '25': '電腦及週邊設備業',
    '26': '光電業',
    '27': '通信網路業',
    '28': '電子零組件業',
    '29': '電子通路業',
    '30': '資訊服務業',
    '31': '其他電子業',
    '32': '文化創意業',
    '33': '農業科技業',
    '34': '電子商務',
    '35': '綠能環保',
    '36': '數位雲端',
    '37': '運動休閒',
    '38': '居家生活',
    '80': '管理股票',
    '91': '臺灣存託憑證',
};

export function displayIndustryName(raw: string | null | undefined): string {
    const s = String(raw ?? '').trim();
    if (!s) return '未分類';
    const direct = TWSE_INDUSTRY[s];
    if (direct) return direct;
    const m = s.match(/^(\d{2})(?:\s|$|[^0-9])/);
    const code = m?.[1];
    if (code) {
        const named = TWSE_INDUSTRY[code];
        if (named) return named;
    }
    if (/^\d{1,2}$/.test(s)) {
        const padded = s.padStart(2, '0');
        const named = TWSE_INDUSTRY[padded];
        if (named) return named;
    }
    return s;
}
