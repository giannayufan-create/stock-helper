// server/src/lib/market-intelligence/news/news-sentiment.ts

import type { SentimentLabel } from '../types.ts';

const BULL =
    /大漲|漲停|創高|看好|買超|增持|突破|強勢|成長|超預期|訂單|擴產|利多|飆|翻揚|亮燈|升息放緩|降息/;
const BEAR =
    /大跌|跌停|重挫|看空|賣超|減持|下修|虧損|裁罰|調查|利空|爆雷|疑慮|衰退|警示|處置|升息|通膨惡化/;

export function heuristicSentiment(title: string): SentimentLabel {
    const bull = BULL.test(title);
    const bear = BEAR.test(title);
    if (bull && !bear) return 'POSITIVE';
    if (bear && !bull) return 'NEGATIVE';
    return 'NEUTRAL';
}
