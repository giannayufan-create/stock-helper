// server/src/ai/news-filter.ts — fetch + filter web headlines before AI analysis

export interface NewsHit {
    title: string;
    source: string;
    published?: string;
    sentiment: '偏多' | '偏空' | '中性';
    score: number; // -2..+2
}

export interface NewsDigest {
    items: NewsHit[];
    bias: '偏多' | '偏空' | '中性';
    scoreAdj: number; // -12..+12 applied to AI score
    summary: string;
}

const BULL =
    /大漲|漲停|創高|看好|買超|增持|突破|強勢|成長|超預期|訂單|擴產|利多|飆|翻揚|亮燈/;
const BEAR =
    /大跌|跌停|重挫|看空|賣超|減持|下修|虧損|裁罰|調查|利空|爆雷|疑慮|衰退|警示|處置/;
const NOISE =
    /廣告|優惠|開戶|贈|點數|信用卡|簽到|遊戲|娛樂|星座|運勢|直播帶貨/;

function sentimentOf(title: string): { label: NewsHit['sentiment']; score: number } {
    const bull = BULL.test(title) ? 1 : 0;
    const bear = BEAR.test(title) ? 1 : 0;
    if (bull && !bear) return { label: '偏多', score: 2 };
    if (bear && !bull) return { label: '偏空', score: -2 };
    if (bull && bear) return { label: '中性', score: 0 };
    return { label: '中性', score: 0 };
}

function decodeXml(s: string): string {
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/<[^>]+>/g, '')
        .trim();
}

function parseRss(xml: string, limit: number): Array<{ title: string; source: string; published?: string }> {
    const items: Array<{ title: string; source: string; published?: string }> = [];
    const blocks = xml.split(/<item[\s>]/i).slice(1);
    for (const block of blocks) {
        const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const sourceMatch =
            block.match(/<source[^>]*>([\s\S]*?)<\/source>/i) ||
            block.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
        const dateMatch = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
        const title = decodeXml(titleMatch?.[1] ?? '');
        if (!title) continue;
        items.push({
            title,
            source: decodeXml(sourceMatch?.[1] ?? '網路新聞'),
            published: decodeXml(dateMatch?.[1] ?? ''),
        });
        if (items.length >= limit) break;
    }
    return items;
}

function relevant(title: string, code: string, name?: string): boolean {
    if (NOISE.test(title)) return false;
    if (title.includes(code)) return true;
    if (name && name.length >= 2 && title.includes(name.replace(/\*$/, ''))) {
        return true;
    }
    // keep some market-context headlines when code missing but name present
    return Boolean(name && /台股|上市|上櫃|電子|半導體/.test(title));
}

async function fetchGoogleNewsRss(query: string): Promise<string> {
    const url =
        'https://news.google.com/rss/search?' +
        new URLSearchParams({
            q: query,
            hl: 'zh-TW',
            gl: 'TW',
            ceid: 'TW:zh-Hant',
        }).toString();
    const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; stock-helper/1.0)',
            Accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
    });
    if (!res.ok) throw new Error(`news HTTP ${res.status}`);
    return res.text();
}

/** Screen web headlines for a TW stock, then score sentiment. */
export async function fetchFilteredNews(
    code: string,
    name?: string,
): Promise<NewsDigest> {
    const qParts = [`"${code}"`];
    if (name) qParts.push(`"${name.replace(/\*$/, '')}"`);
    qParts.push('when:3d');
    try {
        const xml = await fetchGoogleNewsRss(qParts.join(' OR '));
        const raw = parseRss(xml, 20);
        const filtered = raw
            .filter((r) => relevant(r.title, code, name))
            .slice(0, 6)
            .map((r) => {
                const s = sentimentOf(r.title);
                return {
                    title: r.title.slice(0, 80),
                    source: r.source.slice(0, 24),
                    published: r.published,
                    sentiment: s.label,
                    score: s.score,
                } satisfies NewsHit;
            });

        if (filtered.length === 0) {
            return {
                items: [],
                bias: '中性',
                scoreAdj: 0,
                summary: '近三日相關新聞不多，或已被過濾（廣告／無關）。',
            };
        }

        const sum = filtered.reduce((a, b) => a + b.score, 0);
        const avg = sum / filtered.length;
        let bias: NewsDigest['bias'] = '中性';
        if (avg >= 0.6) bias = '偏多';
        else if (avg <= -0.6) bias = '偏空';
        const scoreAdj = Math.max(-12, Math.min(12, Math.round(avg * 6)));
        return {
            items: filtered,
            bias,
            scoreAdj,
            summary: `過濾後 ${filtered.length} 則，新聞氣氛${bias}${
                scoreAdj ? `（分數調整 ${scoreAdj > 0 ? '+' : ''}${scoreAdj}）` : ''
            }`,
        };
    } catch (err) {
        return {
            items: [],
            bias: '中性',
            scoreAdj: 0,
            summary: `新聞暫不可用：${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
