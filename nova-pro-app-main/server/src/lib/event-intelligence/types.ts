// server/src/lib/event-intelligence/types.ts
// Event Intelligence Phase 2 — context only; NEVER mutates A/B/C / BP / Heat / Rank.

export const EI_VERSION = 'ei_v1';

export type EventType =
    | 'GEOPOLITICAL'
    | 'WAR_CONFLICT'
    | 'SANCTION'
    | 'EPIDEMIC'
    | 'EARTHQUAKE'
    | 'NATURAL_DISASTER'
    | 'SHIPPING_DISRUPTION'
    | 'SUPPLY_CHAIN'
    | 'COMMODITY'
    | 'ENERGY'
    | 'SEMICONDUCTOR'
    | 'EXPORT_CONTROL'
    | 'REGULATION'
    | 'COMPANY_MATERIAL_INFO'
    | 'EARNINGS'
    | 'CAPEX'
    | 'ORDER_WIN'
    | 'PRODUCT_EVENT'
    | 'OTHER';

export type SourceConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type EventFreshness = 'FRESH' | 'RECENT' | 'STALE' | 'ARCHIVED';
export type EventPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ImpactDirection = 'POSITIVE' | 'NEGATIVE' | 'MIXED' | 'UNKNOWN';

export type ConfirmationStatus =
    | 'EVENT_UNCONFIRMED'
    | 'EVENT_WATCH'
    | 'EVENT_PARTIAL_CONFIRMED'
    | 'EVENT_MARKET_CONFIRMED'
    | 'EVENT_REJECTED'
    | 'EVENT_STALE';

export type CompanyConfirmStatus =
    | 'COMPANY_UNCONFIRMED'
    | 'COMPANY_WATCH'
    | 'COMPANY_CONFIRMED';

export type TransmissionChannel =
    | 'FREIGHT_RATE'
    | 'OIL_PRICE'
    | 'GAS_PRICE'
    | 'STEEL_PRICE'
    | 'CEMENT_DEMAND'
    | 'AIR_ROUTE'
    | 'SUPPLY_SHORTAGE'
    | 'EXPORT_RESTRICTION'
    | 'CAPEX_DEMAND'
    | 'MEDICAL_DEMAND'
    | 'TESTING_DEMAND'
    | 'VACCINE_DEMAND'
    | 'PPE_DEMAND'
    | 'INSURANCE_COST'
    | 'FX'
    | 'RISK_OFF'
    | 'RECONSTRUCTION'
    | 'DEFENSE_DEMAND'
    | 'FUEL_COST';

export interface MarketEvent {
    event_id: string;
    cluster_id: string;
    event_type: EventType;
    event_subtype: string | null;
    title: string;
    summary: string | null;
    source: string;
    source_type: 'OFFICIAL' | 'ESTABLISHED_NEWS' | 'GLOBAL_FEED' | 'AGGREGATOR' | 'UNKNOWN';
    source_url: string | null;
    published_at: string | null;
    observed_at: string | null;
    fetched_at: string;
    country: string | null;
    region: string | null;
    entities: string[];
    commodities: string[];
    industries: string[];
    companies: string[];
    severity: number;
    confidence: SourceConfidence;
    freshness: EventFreshness;
    age_ms: number | null;
    status: 'ACTIVE' | 'WATCH' | 'ARCHIVED';
    raw_tags: string[];
    schema_version: string;
    sources_count: number;
    source_list: string[];
    latest_update_at: string;
    taiwan_relevance: number;
    event_relevance: number;
    priority: EventPriority;
    notification_candidate: boolean;
}

export interface ImpactEdge {
    from: string;
    to: string;
    direction: ImpactDirection;
    confidence: SourceConfidence;
    rationale: string;
    source_basis: string;
}

export interface SectorImpactHypothesis {
    sector_or_theme: string;
    channels: TransmissionChannel[];
    direction: ImpactDirection;
    relevance: number;
    confidence: SourceConfidence;
    rationale: string;
}

export interface EventImpactGraph {
    event_id: string;
    cluster_id: string;
    edges: ImpactEdge[];
    sector_hypotheses: SectorImpactHypothesis[];
    overall_direction: ImpactDirection;
    note: string;
}

export interface ExposureItem {
    event_type: EventType;
    channel: TransmissionChannel;
    direction: ImpactDirection;
    confidence: SourceConfidence;
    evidence_type: string;
    evidence_source: string;
    last_verified_at: string | null;
}

export interface CompanyExposureProfile {
    symbol: string;
    company_name: string;
    industry: string | null;
    sub_industry: string | null;
    products: string[];
    business_keywords: string[];
    event_channels: TransmissionChannel[];
    exposures: ExposureItem[];
    revenue_exposure_available: false;
    overall_confidence: SourceConfidence;
}

export interface MarketConfirmationResult {
    event_id: string;
    status: ConfirmationStatus;
    market_confirmation_score: number;
    event_relevance: number;
    feature_availability: Record<string, boolean>;
    weights_used: Record<string, number>;
    sector_focus: string | null;
    sector_rank: number | null;
    sector_rank_prev: number | null;
    turnover_share: number | null;
    turnover_share_prev: number | null;
    breadth: number | null;
    c_strong_count: number;
    bp_strong_count: number;
    reasons: string[];
    evaluated_at: string;
}

export interface CompanyConfirmationResult {
    symbol: string;
    event_id: string;
    status: CompanyConfirmStatus;
    exposure_confidence: SourceConfidence;
    reasons: string[];
}

export interface EventSummaryBlock {
    active_count: number;
    confirmed_count: number;
    watch_count: number;
    top_events: MarketEvent[];
    creates_upstream_subscription: false;
    mutates_strategy: false;
}
