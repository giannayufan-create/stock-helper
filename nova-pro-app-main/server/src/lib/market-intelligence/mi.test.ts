// server/src/lib/market-intelligence/mi.test.ts
// Run: npx tsx src/lib/market-intelligence/mi.test.ts

import assert from 'node:assert/strict';
import { computeGroupHeat } from './heat-engine.ts';
import { DEFAULT_MI_CONFIG } from './config.ts';
import { mergeArticle, newsHash } from './news/news-dedupe.ts';
import { heuristicSentiment } from './news/news-sentiment.ts';
import type { HeatMemberSnapshot, NewsArticle } from './types.ts';
import { ThemeHeatEngine } from './theme/theme-heat-engine.ts';
import { ThemeMapper } from './theme/theme-mapper.ts';
import type { IntradayRankItem } from '../intraday-rank/types.ts';

function member(partial: Partial<HeatMemberSnapshot>): HeatMemberSnapshot {
    return {
        symbol: '0000',
        name: 'x',
        c_score: 70,
        stock_heat_score: 60,
        state: 'HEATING',
        rank: 10,
        rank_velocity: 5,
        change_pct: 1,
        events: [],
        rvol: null,
        volume_acceleration: 0.5,
        vwap_pos_pct: 0.5,
        ...partial,
    };
}

function testDedupe(): void {
    const id = newsHash({
        title: '台積電漲停',
        source: 'A',
        url: 'https://x/1',
    });
    const id2 = newsHash({
        title: '台積電漲停!!!',
        source: 'A',
        url: 'https://x/1',
    });
    // same url → same hash preferred
    const a: NewsArticle = {
        id,
        title: '台積電漲停',
        source: 'A',
        published_at: null,
        url: 'https://x/1',
        snippet: null,
        sentiment: 'POSITIVE',
        sentiment_source: 'heuristic',
        scopes: ['SYMBOL'],
        related_symbols: ['2330'],
        related_sectors: [],
        related_themes: [],
        fetched_at: new Date().toISOString(),
    };
    const merged = mergeArticle(a, {
        scopes: ['SECTOR'],
        related_sectors: ['半導體'],
        related_themes: ['cowos'],
    });
    assert.equal(merged.scopes.includes('SYMBOL'), true);
    assert.equal(merged.scopes.includes('SECTOR'), true);
    assert.equal(merged.related_sectors.includes('半導體'), true);
    assert.equal(merged.related_themes.includes('cowos'), true);
    assert.equal(typeof id2, 'string');
    console.log('PASS Test F (dedupe merge)');
}

function testSmallThemeIneligible(): void {
    const mapper = new ThemeMapper();
    const engine = new ThemeHeatEngine(mapper, {
        ...DEFAULT_MI_CONFIG,
        coverage: { ...DEFAULT_MI_CONFIG.coverage, min_eligible_covered: 3 },
    });
    // craft fake ranked items for only 2 symbols of a theme
    const theme = mapper.all().find((t) => t.symbols.length >= 2);
    assert.ok(theme);
    const items: IntradayRankItem[] = theme!.symbols.slice(0, 2).map((sym, i) => ({
        symbol: sym,
        name: sym,
        candidate_origin: 'mixed',
        candidate_sources: ['SCANNER_CHANGE'],
        a_score: null,
        open_score: null,
        open_gate_status: null,
        rank: i + 1,
        rank_prev: null,
        rank_change: null,
        rank_1m_ago: null,
        rank_5m_ago: null,
        rank_velocity: 10,
        last_price: 100,
        change_pct: 2,
        intraday_score: 90,
        raw_intraday_score: 90,
        heat_score: 90,
        state: 'STRONG',
        metrics: {
            return_30s: null,
            return_1m: null,
            return_3m: null,
            return_5m: null,
            momentum_acceleration: 80,
            volume_acceleration: 0.8,
            volume_1m: null,
            volume_3m: null,
            vwap: null,
            vwap_pos_pct: 1,
            vwap_structure_score: null,
            relative_strength_score: null,
            breakout_score: null,
            breakout_type: 'breakout',
            trade_aggression_score: null,
            trade_aggression_available: false,
            pullback_quality_score: null,
            pullback_state: 'none',
            spread_pct: null,
            liquidity_score: null,
        },
        risk: {
            chase_risk: 'low',
            invalid_price: null,
            invalid_reason: null,
        },
        events: ['SURGE'],
        reasons: [],
        risks: [],
        data_health: 'healthy',
        data_blocked: false,
        notification_candidate: false,
        confirmation_count: 1,
        signal_id: null,
        evaluation_id: 't',
        updated_at: new Date().toISOString(),
    }));

    // Temporarily shrink theme membership via compute on only 2 covered
    // Theme heat uses theme.symbols.length as total — covered=2 < 3 → ineligible
    const rows = engine.compute(items);
    const row = rows.find((r) => r.theme_id === theme!.theme_id);
    assert.ok(row);
    assert.equal(row!.eligible_for_ranking, false);
    assert.equal(row!.rank, undefined);
    console.log('PASS Test D (small theme ineligible)');
}

function testHeatDelta(): void {
    const covered = Array.from({ length: 5 }, (_, i) =>
        member({
            symbol: String(1000 + i),
            c_score: 85,
            state: 'STRONG',
            change_pct: 2,
            events: ['BREAKOUT'],
            volume_acceleration: 0.7,
            rank_velocity: 15,
        }),
    );
    const now = Date.now();
    const hist = [{ at: now - 5 * 60_000, heat: 40 }];
    const result = computeGroupHeat({
        id: 'PCB',
        name: 'PCB',
        totalMembers: 10,
        covered,
        weights: DEFAULT_MI_CONFIG.sector_heat,
        cfg: DEFAULT_MI_CONFIG,
        history: hist,
        nowMs: now,
    });
    assert.ok(result.heat_score != null && result.heat_score > 40);
    assert.ok(result.heat_delta_5m != null && result.heat_delta_5m > 0);
    assert.equal(result.eligible_for_ranking, true);
    console.log('PASS Test E (heat delta 5m)');
}

function testSentiment(): void {
    assert.equal(heuristicSentiment('台積電大漲創高'), 'POSITIVE');
    assert.equal(heuristicSentiment('重挫下修虧損'), 'NEGATIVE');
    console.log('PASS sentiment heuristic');
}

function testForbiddenSanitizer(): void {
    const bad = /買進|賣出|必漲|必跌|目標價/;
    assert.equal(bad.test('建議觀察'), false);
    assert.equal(bad.test('買進這檔'), true);
    console.log('PASS Test H pattern (forbidden)');
}

testDedupe();
testSmallThemeIneligible();
testHeatDelta();
testSentiment();
testForbiddenSanitizer();
console.log('\nMI unit tests passed.');
