// server/src/lib/market-context/config.ts

export interface MarketContextConfig {
    enabled: boolean;
    evaluate_interval_sec: number;
    /** Expected listed+OTC common equities for coverage denominator. */
    expected_universe_size: number;
    broad_day_quote_max_age_ms: number;
    min_sector_members_for_state: number;
    high_concentration_top1: number;
    high_concentration_max_breadth: number;
    taiwan_regime: {
        risk_on_score: number;
        risk_off_score: number;
        broad_min_advance_pct: number;
        narrow_max_advance_pct: number;
    };
    rotation: {
        rotating_in_min_share_delta: number;
        rotating_in_min_breadth: number;
        rotating_in_min_rs: number;
        hot_min_share: number;
        hot_min_breadth: number;
        cold_max_share: number;
        rotating_out_max_share_delta: number;
    };
    electronics_keywords: string[];
    financial_keywords: string[];
}

export const DEFAULT_MC_CONFIG: MarketContextConfig = {
    enabled: true,
    evaluate_interval_sec: 60,
    expected_universe_size: 1800,
    broad_day_quote_max_age_ms: 10 * 60_000,
    min_sector_members_for_state: 3,
    high_concentration_top1: 0.55,
    high_concentration_max_breadth: 0.35,
    taiwan_regime: {
        risk_on_score: 58,
        risk_off_score: 42,
        broad_min_advance_pct: 55,
        narrow_max_advance_pct: 45,
    },
    rotation: {
        rotating_in_min_share_delta: 0.015,
        rotating_in_min_breadth: 0.55,
        rotating_in_min_rs: 0.2,
        hot_min_share: 0.08,
        hot_min_breadth: 0.55,
        cold_max_share: 0.02,
        rotating_out_max_share_delta: -0.01,
    },
    electronics_keywords: [
        '半導體',
        '電子',
        '光電',
        '電腦',
        '通信',
        '資訊',
        '電機',
    ],
    financial_keywords: ['金融', '銀行', '保險', '金控', '證券'],
};
