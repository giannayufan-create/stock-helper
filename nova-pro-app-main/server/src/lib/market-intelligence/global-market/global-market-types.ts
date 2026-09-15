// server/src/lib/market-intelligence/global-market/global-market-types.ts

export type { GlobalAssetQuote, MarketContextBlock, RiskEnvironment } from '../types.ts';

export interface GlobalAssetSpec {
    id: string;
    name: string;
    yahoo: string;
    group: 'us' | 'asia' | 'taiwan' | 'vol' | 'rates' | 'fx' | 'commodity';
}
