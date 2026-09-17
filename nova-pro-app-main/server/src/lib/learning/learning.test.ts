// server/src/lib/learning/learning.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StrategySignal } from '../strategy-signal/types.ts';
import type { SignalOutcome } from '../signal-outcome/types.ts';
import { buildLearningDataset } from './dataset-builder.ts';
import { computeCohortMetrics, sampleAdequacy } from './evaluator.ts';
import { runFeatureAnalysis } from './feature-analysis.ts';
import { ExperimentRepository } from './experiment-repository.ts';
import {
    DEFAULT_BASELINE,
    filterByThreshold,
    searchCandidates,
} from './parameter-search.ts';
import { buildRecommendation } from './recommendation-engine.ts';
import {
    armShadow,
    shadowReadyForManualReview,
    shadowStateFromScore,
} from './shadow.ts';
import {
    assertNoFutureLeak,
    planWalkForward,
    runWalkForward,
} from './walk-forward.ts';
import { loadLearningConfig } from './config.ts';
import type { LearningDatasetRow } from './types.ts';

function makeSignal(
    partial: Partial<StrategySignal> &
        Pick<StrategySignal, 'signal_id' | 'signal_type' | 'signal_time'>,
): StrategySignal {
    return {
        symbol: partial.symbol ?? '2330',
        reference_price: 100,
        reference_price_source: 'replay_bar_close',
        source: partial.signal_type === 'OPEN_PASS' ? 'B' : 'C',
        strategy_version: 'bc-strategy-v1',
        config_hash: 'cfg_test',
        source_mode: 'replay',
        data_resolution: '1m',
        learning_eligible: true,
        universe_source: 'historical_A',
        score_confidence: 'high',
        market_regime: 'bull',
        ...partial,
        feature_snapshot: {
            final_open_score: 80,
            rvol_same_time: 1.6,
            vwap_pos: 0.4,
            momentum: 70,
            chase_risk: 'low',
            intraday_score: 82,
            heat_score: 75,
            volume_acceleration: 1.2,
            relative_strength: 65,
            rank_velocity: 5,
            ...(partial.feature_snapshot ?? {}),
        },
    };
}

function makeOutcome(
    signal_id: string,
    signal_type: StrategySignal['signal_type'],
    signal_time: string,
    fr15: number,
    mfe: number,
    mae: number,
    invalid = false,
): SignalOutcome {
    return {
        signal_id,
        symbol: '2330',
        signal_type,
        signal_time,
        reference_price: 100,
        status: 'complete',
        forward_return_15m: fr15,
        forward_return_30m: fr15 * 0.8,
        mfe_15m: mfe,
        mae_15m: mae,
        invalid_hit: invalid,
        source_mode: 'replay',
        data_resolution: '1m',
        calculated_at: signal_time,
        event_kind: 'COMPLETE',
    };
}

/** Multi-month synthetic eligible dataset for walk-forward. */
function buildSyntheticCorpus(): {
    signals: StrategySignal[];
    outcomes: SignalOutcome[];
} {
    const signals: StrategySignal[] = [];
    const outcomes: SignalOutcome[] = [];
    const months = [
        '2026-01',
        '2026-02',
        '2026-03',
        '2026-04',
        '2026-05',
        '2026-06',
    ];
    let i = 0;
    for (const ym of months) {
        for (let d = 1; d <= 12; d++) {
            const day = String(d).padStart(2, '0');
            const iso = `${ym}-${day}T01:30:00.000Z`;
            // Higher open_score → slightly better outcomes (for threshold search signal)
            for (const score of [76, 78, 80, 82, 85, 88]) {
                i++;
                const id = `s_${ym}_${d}_${score}_${i}`;
                const boost = (score - 78) * 0.15;
                const fr = 0.3 + boost + (d % 3 === 0 ? -0.4 : 0.2);
                const mfe = 1.0 + boost;
                const mae = -0.6 - (score < 80 ? 0.3 : 0);
                signals.push(
                    makeSignal({
                        signal_id: id,
                        signal_type: 'OPEN_PASS',
                        signal_time: iso,
                        session_minute: 30 + (d % 5) * 20,
                        score,
                        market_regime: d % 4 === 0 ? 'bear' : 'bull',
                        feature_snapshot: {
                            final_open_score: score,
                            rvol_same_time: 0.8 + (score - 76) * 0.15,
                            vwap_pos: (score - 78) * 0.1,
                            momentum: score - 5,
                            chase_risk:
                                score >= 88
                                    ? 'extreme'
                                    : score >= 85
                                      ? 'high'
                                      : 'low',
                        },
                    }),
                );
                outcomes.push(
                    makeOutcome(
                        id,
                        'OPEN_PASS',
                        iso,
                        fr,
                        mfe,
                        mae,
                        score >= 88 && d % 5 === 0,
                    ),
                );
            }
            // Some C signals
            i++;
            const cid = `c_${ym}_${d}_${i}`;
            signals.push(
                makeSignal({
                    signal_id: cid,
                    signal_type: 'SURGE',
                    signal_time: iso,
                    session_minute: 45,
                    score: 84,
                    heat_score: 88,
                    feature_snapshot: {
                        intraday_score: 84,
                        heat_score: 88,
                        momentum: 1.2,
                        volume_acceleration: 2.0,
                        relative_strength: 72,
                        rank_velocity: 12,
                        chase_risk: 'medium',
                    },
                }),
            );
            outcomes.push(
                makeOutcome(cid, 'SURGE', iso, 0.9, 2.1, -0.5, false),
            );
        }
    }
    return { signals, outcomes };
}

function testDatasetEligibility(): void {
    const signals = [
        makeSignal({
            signal_id: 'ok1',
            signal_type: 'OPEN_PASS',
            signal_time: '2026-03-01T01:00:00.000Z',
            learning_eligible: true,
            universe_source: 'historical_A',
        }),
        makeSignal({
            signal_id: 'syn1',
            signal_type: 'OPEN_PASS',
            signal_time: '2026-03-01T01:00:00.000Z',
            learning_eligible: true,
            universe_source: 'synthetic',
        }),
        makeSignal({
            signal_id: 'low1',
            signal_type: 'OPEN_PASS',
            signal_time: '2026-03-01T01:00:00.000Z',
            learning_eligible: true,
            score_confidence: 'low',
            universe_source: 'historical_A',
        }),
    ];
    const outcomes = signals.map((s) =>
        makeOutcome(s.signal_id, s.signal_type, s.signal_time, 1, 2, -0.5),
    );
    const { rows, report } = buildLearningDataset(signals, outcomes);
    assert.equal(rows.length, 1);
    assert.ok(report.excluded_samples >= 2);
    assert.ok(rows[0]!.signal_quality_score != null);
    assert.equal(rows[0]!.positive_15m, true);
    console.log('OK dataset eligibility + quality score');
}

function testFeatureAnalysis(): void {
    const { signals, outcomes } = buildSyntheticCorpus();
    const { rows } = buildLearningDataset(signals, outcomes);
    const analysis = runFeatureAnalysis(rows);
    assert.ok(analysis.rvol.length >= 2);
    assert.ok(analysis.signal_types.some((s) => s.signal_type === 'OPEN_PASS'));
    assert.ok(analysis.findings.length > 0);
    console.log('OK feature analysis buckets');
}

function testWalkForwardNoLeak(): void {
    const { signals, outcomes } = buildSyntheticCorpus();
    const { rows } = buildLearningDataset(signals, outcomes);
    const plan = planWalkForward(rows);
    assert.ok(plan.folds.length >= 1);
    assert.ok(plan.holdout_months.length >= 1);

    for (const f of plan.folds) {
        const trainTo = `${f.train_months[f.train_months.length - 1]}-28`;
        const valFrom = `${f.validate_months[0]}-01`;
        assertNoFutureLeak(trainTo, valFrom);
    }

    const base = (r: LearningDatasetRow[]) =>
        filterByThreshold(r, 'open-gate', 78);
    const cand = (r: LearningDatasetRow[]) =>
        filterByThreshold(r, 'open-gate', 82);
    const wf = runWalkForward(rows, base, cand);
    assert.ok(wf.folds.length >= 1);
    assert.ok(wf.holdout);
    // Holdout months must be after last validate
    const lastVal = wf.folds[wf.folds.length - 1]!.validate_to;
    assert.ok(wf.holdout!.from > lastVal.slice(0, 7) || wf.holdout!.from >= lastVal.slice(0, 8));
    console.log(
        `OK walk-forward folds=${wf.folds.length} holdout=${wf.holdout!.from}..${wf.holdout!.to} stability=${wf.stability_score}`,
    );
}

function testSearchBaselineVsCandidate(): void {
    const { signals, outcomes } = buildSyntheticCorpus();
    const { rows } = buildLearningDataset(signals, outcomes);
    const cands = searchCandidates(rows, DEFAULT_BASELINE);
    assert.ok(cands.length > 0);
    const best = cands[0]!;
    assert.ok(best.config.open_gate?.pass_enter_threshold != null);
    const baseM = computeCohortMetrics(
        filterByThreshold(rows, 'open-gate', 78),
    );
    assert.ok(baseM.count > 0);
    assert.ok(sampleAdequacy(baseM.count) !== 'insufficient');
    console.log(
        `OK search candidates=${cands.length} best_enter=${best.config.open_gate?.pass_enter_threshold} base_n=${baseM.count}`,
    );
}

function testRecommendationAndNoProdWrite(): void {
    const { signals, outcomes } = buildSyntheticCorpus();
    const { rows, report } = buildLearningDataset(signals, outcomes);
    const exp = buildRecommendation(rows, 'open-gate');
    assert.ok(
        ['RECOMMEND', 'REJECT', 'NEEDS_MORE_DATA'].includes(
            exp.recommendation_status,
        ),
    );
    assert.equal(
        loadLearningConfig().promotion.auto_promote,
        false,
    );
    assert.ok(exp.walk_forward.length >= 0);

    const dir = mkdtempSync(join(tmpdir(), 'exp-'));
    const repo = new ExperimentRepository(dir);
    const path = repo.save(exp);
    assert.ok(path.includes(exp.experiment_id));
    const loaded = repo.findById(exp.experiment_id);
    assert.equal(loaded?.experiment_id, exp.experiment_id);
    rmSync(dir, { recursive: true, force: true });

    console.log(
        `OK recommendation status=${exp.recommendation_status} conf=${exp.confidence} eligible=${report.eligible_samples}`,
    );
    console.log(
        `   candidate=${JSON.stringify(exp.candidate.open_gate)} promotion=${exp.promotion_status}`,
    );
}

function testShadowGuards(): void {
    const shadow = armShadow({
        candidate: {
            target: 'open-gate',
            open_gate: { pass_enter_threshold: 82, pass_exit_threshold: 76 },
            complexity: 0,
        },
        experiment_id: 'exp_test',
        enabled: true,
    });
    assert.equal(shadow.production_immutable, true);
    assert.equal(shadowStateFromScore(83, shadow.candidate!), 'PASS');
    assert.equal(shadowStateFromScore(77, shadow.candidate!), 'WATCH');
    const ready = shadowReadyForManualReview({
        ...shadow,
        days_observed: 1,
        signals_observed: 10,
    });
    assert.equal(ready.ready, false);
    const ready2 = shadowReadyForManualReview({
        ...shadow,
        days_observed: 15,
        signals_observed: 10,
    });
    assert.equal(ready2.ready, true);
    console.log('OK shadow guards (no auto promote, min observation)');
}

function testLiveReplaySeparation(): void {
    const signals = [
        makeSignal({
            signal_id: 'live1',
            signal_type: 'OPEN_PASS',
            signal_time: '2026-03-01T01:00:00.000Z',
            source_mode: 'live',
            data_resolution: 'tick',
        }),
        makeSignal({
            signal_id: 'rep1',
            signal_type: 'OPEN_PASS',
            signal_time: '2026-03-01T01:00:00.000Z',
            source_mode: 'replay',
            data_resolution: '1m',
        }),
    ];
    const outcomes = signals.map((s) =>
        makeOutcome(s.signal_id, s.signal_type, s.signal_time, 1, 1.5, -0.4),
    );
    const { rows } = buildLearningDataset(signals, outcomes);
    const live = rows.filter((r) => r.source_mode === 'live');
    const replay = rows.filter((r) => r.source_mode === 'replay');
    assert.equal(live.length, 1);
    assert.equal(replay.length, 1);
    console.log('OK live/replay rows separable');
}

async function main(): Promise<void> {
    loadLearningConfig(true);
    testDatasetEligibility();
    testFeatureAnalysis();
    testWalkForwardNoLeak();
    testSearchBaselineVsCandidate();
    testRecommendationAndNoProdWrite();
    testShadowGuards();
    testLiveReplaySeparation();
    console.log('\nAll learning F1–F2 tests passed.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
