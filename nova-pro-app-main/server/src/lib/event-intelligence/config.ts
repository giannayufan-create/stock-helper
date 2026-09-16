// server/src/lib/event-intelligence/config.ts

export interface EventIntelligenceConfig {
    enabled: boolean;
    evaluate_interval_sec: number;
    max_stored_events: number;
    fresh_ms: number;
    recent_ms: number;
    stale_ms: number;
    cluster_window_ms: number;
    confirmation_weights: {
        sector_rotation: number;
        capital_rotation: number;
        sector_breadth: number;
        sector_rs: number;
        c_confirmation: number;
        bp_confirmation: number;
    };
    confirmation: {
        confirmed_min_score: number;
        partial_min_score: number;
        watch_min_score: number;
        reject_max_score: number;
        min_breadth_for_confirmed: number;
        min_share_delta_for_confirmed: number;
    };
    news_queries: string[];
    gdelt_enabled: boolean;
}

export const DEFAULT_EI_CONFIG: EventIntelligenceConfig = {
    enabled: true,
    evaluate_interval_sec: 120,
    max_stored_events: 200,
    fresh_ms: 6 * 3600_000,
    recent_ms: 48 * 3600_000,
    stale_ms: 7 * 86400_000,
    cluster_window_ms: 36 * 3600_000,
    confirmation_weights: {
        sector_rotation: 0.3,
        capital_rotation: 0.2,
        sector_breadth: 0.15,
        sector_rs: 0.15,
        c_confirmation: 0.1,
        bp_confirmation: 0.1,
    },
    confirmation: {
        confirmed_min_score: 70,
        partial_min_score: 50,
        watch_min_score: 35,
        reject_max_score: 25,
        min_breadth_for_confirmed: 0.55,
        min_share_delta_for_confirmed: 0.015,
    },
    news_queries: [
        '紅海 OR 霍爾木茲 OR 航運中斷 OR 貨櫃運價 when:3d',
        '戰爭 OR 衝突 OR 地緣政治 OR 襲擊 when:3d',
        '制裁 OR 出口管制 OR 晶片管制 when:3d',
        '疫情 OR 傳染病 OR CDC OR 流感 OR 呼吸道 when:3d',
        '地震 OR 天災 OR 颱風 when:2d',
        '原油 OR 油價 OR WTI OR 石油 when:2d',
        '半導體 OR 先進製程 OR 禁運 when:3d',
    ],
    gdelt_enabled: true,
};
