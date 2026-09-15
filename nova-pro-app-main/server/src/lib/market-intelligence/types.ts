// server/src/lib/market-intelligence/types.ts

export const MI_VERSION = 'mi_v1';

export type MiConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type MiAssetStatus = 'HEALTHY' | 'STALE' | 'UNAVAILABLE' | 'ERROR';
export type RiskEnvironment = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF' | 'UNKNOWN';
export type ContextStrength = '強' | '偏強' | '中性' | '偏弱' | '弱' | '未知';
export type NewsScope = 'SYMBOL' | 'SECTOR' | 'THEME' | 'GLOBAL';
export type SentimentLabel = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
export type SentimentSource = 'heuristic' | 'gemini';
export type LayerHealthStatus =
    | 'HEALTHY'
    | 'STALE'
    | 'DEGRADED'
    | 'UNAVAILABLE'
    | 'ERROR';

export interface GlobalAssetQuote {
    id: string;
    name: string;
    value: number | null;
    change: number | null;
    change_pct: number | null;
    timestamp: string | null;
    source: string;
    freshness: string;
    status: MiAssetStatus;
    yahoo_symbol?: string;
}

export interface MarketContextBlock {
    risk_environment: RiskEnvironment;
    market_regime: string | null;
    market_score: number | null;
    semiconductor_context: ContextStrength;
    tech_context: ContextStrength;
    asia_context: ContextStrength;
    fx_context: ContextStrength;
    summary: string;
}

export interface HeatMemberSnapshot {
    symbol: string;
    name: string;
    c_score: number | null;
    stock_heat_score: number | null;
    state: string | null;
    rank: number | null;
    rank_velocity: number | null;
    change_pct: number | null;
    events: string[];
    rvol: number | null;
    volume_acceleration: number | null;
    vwap_pos_pct: number | null;
}

export interface HeatGroupResult {
    id: string;
    name: string;
    heat_score: number | null;
    heat_now: number | null;
    heat_5m_ago: number | null;
    heat_15m_ago: number | null;
    heat_delta_5m: number | null;
    heat_delta_15m: number | null;
    covered_members: number;
    total_members: number;
    coverage_pct: number;
    confidence: MiConfidence;
    eligible_for_ranking: boolean;
    strong_count: number;
    heating_count: number;
    breakout_count: number;
    leaders: Array<{
        symbol: string;
        name: string;
        c_score: number | null;
        stock_heat_score: number | null;
        state: string | null;
    }>;
    components: {
        breadth: number | null;
        participation: number | null;
        leader_strength: number | null;
        volume_acceleration: number | null;
        rank_momentum: number | null;
        event_density: number | null;
    };
    updated_at: string;
    source?: string;
}

export interface SectorHeatRow extends HeatGroupResult {
    sector: string;
    mapping_source: string;
    rank?: number;
}

export interface ThemeHeatRow extends HeatGroupResult {
    theme_id: string;
    theme: string;
    aliases: string[];
    rank?: number;
}

export interface NewsArticle {
    id: string;
    title: string;
    source: string;
    published_at: string | null;
    url: string | null;
    snippet: string | null;
    sentiment: SentimentLabel;
    sentiment_source: SentimentSource;
    scopes: NewsScope[];
    related_symbols: string[];
    related_sectors: string[];
    related_themes: string[];
    fetched_at: string;
}

export interface CompanyEventItem {
    event_type: string;
    symbol: string;
    title: string;
    published_at: string | null;
    source: string;
    severity: 'info' | 'warning' | 'critical';
}

export interface ChipsContext {
    available: boolean;
    freshness: string;
    as_of: string | null;
    label: string | null;
    summary: string | null;
    foreign_net: number | null;
    trust_net: number | null;
    dealer_net: number | null;
    inst_net: number | null;
    margin_delta: number | null;
    note: string;
}

export interface RadarContextRef {
    b_status: string | null;
    b_score: number | null;
    c_score: number | null;
    stock_heat: number | null;
    rank: number | null;
    events: string[];
    state: string | null;
}

export interface LayerHealth {
    status: LayerHealthStatus;
    last_success_at: string | null;
    age_sec: number | null;
    source: string;
    error: string | null;
}

export interface MarketIntelligenceHealth {
    global_market: LayerHealth;
    sector: LayerHealth;
    theme: LayerHealth;
    news: LayerHealth;
    company_events: LayerHealth;
    ai_summary: LayerHealth;
    overall: LayerHealthStatus;
}

export interface AiBriefPayload {
    available: boolean;
    market_summary: string | null;
    risk_environment: RiskEnvironment | null;
    hot_sectors: Array<{ name: string; reason: string }>;
    hot_themes: Array<{ name: string; reason: string }>;
    key_events: string[];
    risks: string[];
    generated_at: string | null;
    error: string | null;
    source: 'gemini' | 'none';
}

export interface MarketIntelligenceSnapshot {
    generated_at: string;
    source_mode: 'live';
    market_context: MarketContextBlock;
    global_markets: GlobalAssetQuote[];
    sectors: SectorHeatRow[];
    themes: ThemeHeatRow[];
    headlines: NewsArticle[];
    company_events: CompanyEventItem[];
    ai_summary: AiBriefPayload;
    data_health: MarketIntelligenceHealth;
    version: string;
    theme_map_version: string;
    config_hash: string;
    material_info_available: boolean;
    material_info_coverage: 'PARTIAL' | 'NONE';
}

export interface SymbolIntelligence {
    symbol: string;
    name: string | null;
    sector: {
        name: string | null;
        heat: number | null;
        rank: number | null;
        trend: string | null;
        confidence: MiConfidence | null;
    } | null;
    themes: Array<{
        theme_id: string;
        name: string;
        heat: number | null;
        rank: number | null;
        confidence: MiConfidence | null;
    }>;
    market_context: MarketContextBlock;
    news: NewsArticle[];
    company_events: CompanyEventItem[];
    chips_context: ChipsContext;
    radar_context: RadarContextRef | null;
    data_health: MarketIntelligenceHealth;
    generated_at: string;
    version: string;
}
