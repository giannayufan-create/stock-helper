// server/src/lib/today-decision/engine.ts
// Pure merge of existing layer verdicts into one ranked Chinese answer.
// Reads only; never mutates or re-derives A/B/C / BP / Heat / Rank scores.

import {
    TODAY_DECISION_VERSION,
    type TodayAction,
    type TodayBoardInput,
    type TodayDecisionBoard,
    type TodayDecisionItem,
    type TodayInputItem,
    type TodayMode,
} from './types.ts';

const DISCLAIMER =
    '動作標籤為決策支援參考（可進場／只觀察／不要碰），非投資建議。進場與部位由你自行決定。';

const MODE_LABEL: Record<TodayMode, string> = {
    PREOPEN: '盤前準備（08:30–09:00）',
    OPENING: '開盤決策（09:00–09:30）',
    INTRADAY: '盤中追蹤',
    CLOSING: '收盤前',
    AFTER_HOURS: '盤後／休市',
};

const ACTION_ORDER: Record<TodayAction, number> = {
    ACTIONABLE: 0,
    WATCH: 1,
    WAIT: 2,
    AVOID: 3,
};

const ACTION_LABEL: Record<TodayAction, string> = {
    ACTIONABLE: '可進場',
    WATCH: '只觀察',
    WAIT: '還沒成形',
    AVOID: '不要碰',
};

function clamp(n: number, lo = 0, hi = 100): number {
    return Math.max(lo, Math.min(hi, n));
}

function statusPoints(status: string | null): number {
    switch (status) {
        case 'CONFIRMED_STRENGTH':
            return 100;
        case 'WATCH':
            return 60;
        case 'EXTENDED':
            return 35;
        case 'NOT_READY':
            return 25;
        default:
            return 30;
    }
}

function momentumPoints(state: string | null): number {
    switch (state) {
        case 'ACTIVE':
            return 100;
        case 'PULLBACK':
            return 65;
        case 'WATCH':
            return 40;
        case 'INACTIVE':
            return 15;
        case 'INVALID':
            return 0;
        default:
            return 35;
    }
}

function isHighChase(risk: string | null): boolean {
    const v = (risk ?? '').toUpperCase();
    return v === 'HIGH' || v === 'EXTREME';
}

function dedupe(list: Array<string | null | undefined>, max: number): string[] {
    const out: string[] = [];
    for (const raw of list) {
        const s = (raw ?? '').trim();
        if (!s) continue;
        if (out.includes(s)) continue;
        out.push(s);
        if (out.length >= max) break;
    }
    return out;
}

function dataConfidence(it: TodayInputItem): 'HIGH' | 'MEDIUM' | 'LOW' {
    if (it.data_blocked) return 'LOW';
    const cov = it.score_coverage_pct;
    if (it.bp_stale) return 'LOW';
    if (cov == null) return 'MEDIUM';
    if (cov >= 80) return 'HIGH';
    if (cov >= 55) return 'MEDIUM';
    return 'LOW';
}

/**
 * Merge-only verdict. Every branch is derived from another layer's own
 * conclusion — this never re-scores raw market features.
 */
function resolveAction(
    it: TodayInputItem,
    mode: TodayMode,
): { action: TodayAction; hint: string } {
    if (mode === 'PREOPEN' || mode === 'AFTER_HOURS') {
        // Open Gate phase is 'after' before 09:00 — no confirmation exists yet.
        return {
            action: 'WAIT',
            hint:
                mode === 'PREOPEN'
                    ? '盤前名單，09:00 開盤後才會有開盤確認'
                    : '非交易時段，等明天開盤確認',
        };
    }

    if (it.data_blocked) {
        return { action: 'WAIT', hint: '這檔資料不完整，先不要判斷' };
    }
    if (it.c_state === 'INVALID' || it.momentum_state === 'INVALID') {
        return { action: 'AVOID', hint: '結構已破壞，不要進場' };
    }
    if (it.c_risks.includes('處置股')) {
        return { action: 'AVOID', hint: '處置股流動性差，不要當沖' };
    }
    if (
        it.trap_flags.includes('FADE_FROM_HIGH') ||
        it.trap_flags.includes('FAILED_BREAKOUT')
    ) {
        return { action: 'AVOID', hint: '疑似開高走低或假突破，先避開' };
    }
    if ((it.chase_risk ?? '').toUpperCase() === 'EXTREME') {
        return { action: 'AVOID', hint: '追高風險極高，現在進場位置太差' };
    }

    // Rescue EARLY = 剛轉強 → 只觀察（不要求漲幅）
    if (it.rescue_state === 'EARLY') {
        return {
            action: 'WATCH',
            hint: '剛轉強，動能在加速，先觀察確認再進場',
        };
    }

    if (it.decision_status === 'EXTENDED') {
        return { action: 'AVOID', hint: '漲幅已經拉開，等回檔再看' };
    }
    if (it.bp_overheated && it.momentum_state !== 'ACTIVE') {
        return { action: 'AVOID', hint: '買盤過熱但動能沒跟上，容易套在高點' };
    }
    if (it.eligibility === 'BLOCKED') {
        return { action: 'WAIT', hint: '流動性或價差不符合條件' };
    }

    if (mode === 'OPENING') {
        const oc = (it.open_confirm ?? '').toLowerCase();
        if (oc === 'reject' || oc === 'fail') {
            return { action: 'AVOID', hint: '開盤確認未通過，不要追' };
        }
        if (oc === 'provisional') {
            return {
                action: 'WAIT',
                hint: '09:03 前還在試算，先看不要動手',
            };
        }
        if (oc === 'pass' || oc === 'early_pass') {
            if (it.c_risks.includes('注意股')) {
                return {
                    action: 'WATCH',
                    hint: '開盤通過但是注意股，只觀察',
                };
            }
            if (it.trap_flags.length) {
                return {
                    action: 'WATCH',
                    hint: '開盤通過但有騙線疑慮，先等確認',
                };
            }
            if (isHighChase(it.chase_risk)) {
                return {
                    action: 'WATCH',
                    hint: '開盤通過但位置偏高，等回踩再看',
                };
            }
            // Align with Radar: Open Gate pass + tradeable = 可進場
            if (it.tradeable_candidate || oc === 'pass') {
                return {
                    action: 'ACTIONABLE',
                    hint:
                        oc === 'early_pass'
                            ? '提早通過開盤確認，注意進場價與停損'
                            : '開盤確認通過，注意進場價與停損',
                };
            }
            return {
                action: 'WATCH',
                hint: '開盤確認偏弱通過，再等買盤與結構',
            };
        }
        if (oc === 'watch') {
            return { action: 'WATCH', hint: '開盤還在觀察，不要急' };
        }
        return { action: 'WAIT', hint: '開盤確認尚未產出，稍候' };
    }

    // Align with Radar card: Decision Summary CONFIRMED_STRENGTH = 可進場
    // (unless chase/trap/注意股 already handled above / below).
    const radarConfirmed =
        it.decision_status === 'CONFIRMED_STRENGTH' ||
        // Rescue ACTIVE in focus/active lane = Radar「正在發動」可跟
        (it.rescue_state === 'ACTIVE' &&
            (it.focus_rank != null || (it.opportunity_score ?? 0) >= 60));

    if (radarConfirmed && !isHighChase(it.chase_risk)) {
        if (it.c_risks.includes('注意股')) {
            return {
                action: 'WATCH',
                hint: '注意股最多觀察，不要當正式進場',
            };
        }
        if (it.trap_flags.length) {
            return {
                action: 'WATCH',
                hint: '條件有了但有騙線疑慮，先等確認',
            };
        }
        return {
            action: 'ACTIONABLE',
            hint: it.tradeable_candidate
                ? '開盤確認已通過且動能延續，注意進場價與停損'
                : it.decision_status === 'CONFIRMED_STRENGTH'
                  ? '雷達已確認強度，注意進場價與停損'
                  : '動能已發動且追價風險可控，注意進場價與停損',
        };
    }

    if (radarConfirmed && isHighChase(it.chase_risk)) {
        return { action: 'WATCH', hint: '條件有了但位置偏高，等回踩再看' };
    }
    if (it.momentum_state === 'PULLBACK') {
        return { action: 'WATCH', hint: '回踩中，等站回均價再確認' };
    }
    if (it.decision_status === 'WATCH') {
        const miss = it.decision_missing[0];
        return {
            action: 'WATCH',
            hint: miss ? `還缺：${miss}` : '再等一個確認訊號',
        };
    }
    if ((it.c_score ?? 0) >= 70 && (it.bp_score ?? 0) >= 60) {
        return { action: 'WATCH', hint: '強度和買盤都有了，等結構確認' };
    }

    return { action: 'WAIT', hint: '還在累積，先不要動作' };
}

function conviction(it: TodayInputItem, action: TodayAction): number {
    if (action === 'AVOID') {
        return clamp(Math.round(momentumPoints(it.momentum_state) * 0.3));
    }
    // Pre-open has no C score yet; fall back to the prepared A/B strength so
    // the pre-open list still keeps a meaningful order.
    const strength = it.c_score ?? it.open_score ?? it.a_score ?? 0;
    const base =
        0.35 * clamp(strength) +
        0.3 * clamp(it.bp_score ?? 0) +
        0.2 * statusPoints(it.decision_status) +
        0.15 * momentumPoints(it.momentum_state);

    let adj = 0;
    if (it.focus_rank === 1) adj += 6;
    else if (it.focus_rank === 2) adj += 4;
    else if (it.focus_rank === 3) adj += 2;
    if (it.tradeable_candidate) adj += 3;
    const chase = (it.chase_risk ?? '').toUpperCase();
    if (chase === 'HIGH') adj -= 8;
    if (chase === 'EXTREME') adj -= 20;
    if (it.bp_stale) adj -= 5;

    return clamp(Math.round(base + adj));
}

function buildWhy(it: TodayInputItem): string[] {
    const chase = (it.chase_risk ?? '').toUpperCase();
    const extras: string[] = [];
    if (it.c_score == null && it.a_score != null) {
        extras.push(`前一日選股分數 ${Math.round(it.a_score)}`);
    }
    if (it.focus_rank != null) extras.push(`目前雷達焦點第 ${it.focus_rank} 名`);
    if (it.tradeable_candidate) extras.push('開盤確認已通過');
    if (it.rank != null && (it.rank_change ?? 0) > 0) {
        extras.push(`排名上升 ${it.rank_change} 名（現在第 ${it.rank} 名）`);
    }
    if (chase === 'LOW' && (it.bp_score ?? 0) >= 60) {
        extras.push('買盤有力且位置還不算追高');
    }
    return dedupe(
        [...it.decision_confirmed, ...it.rq_reasons, ...extras, ...it.c_reasons],
        3,
    );
}

function buildRisk(it: TodayInputItem, mode: TodayMode): string[] {
    if (mode === 'PREOPEN' || mode === 'AFTER_HOURS') {
        return dedupe(
            it.c_risks.filter((r) => r === '注意股' || r === '處置股'),
            2,
        );
    }
    const chase = (it.chase_risk ?? '').toUpperCase();
    const extras: string[] = [];
    if (chase === 'EXTREME') extras.push('追高風險極高');
    else if (chase === 'HIGH') extras.push('追高風險偏高');
    if (it.bp_overheated) extras.push('買盤過熱');
    if (it.bp_stale) extras.push('買盤資料延遲');
    if (it.data_blocked) extras.push('行情資料不完整');
    return dedupe(
        [...extras, ...it.decision_risks, ...it.c_risks].filter(
            (r) => !r.includes('INSTITUTIONAL_RISK_PROXY'),
        ),
        2,
    );
}

function marketNote(
    regime: string | null,
    advancePct: number | null,
    mode: TodayMode,
): string {
    const breadth =
        advancePct != null ? `，上漲家數約 ${Math.round(advancePct)}%` : '';
    let cash: string;
    switch (regime) {
        case 'RISK_ON_BROAD':
            cash = `大盤偏多且廣度不錯${breadth}`;
            break;
        case 'RISK_ON_NARROW':
            cash = `大盤偏多但只集中在少數股${breadth}`;
            break;
        case 'NEUTRAL':
            cash = `大盤中性，選股比看指數重要${breadth}`;
            break;
        case 'RISK_OFF_NARROW':
            cash = `大盤偏弱，建議減少檔數${breadth}`;
            break;
        case 'RISK_OFF_BROAD':
            cash = `大盤明顯偏空，建議空手或極小部位${breadth}`;
            break;
        default:
            cash = `大盤狀態資料不足${breadth}`;
    }
    if (mode === 'AFTER_HOURS' || mode === 'PREOPEN') {
        return `今日現貨收盤：${cash}（不是夜盤即時）`;
    }
    return cash;
}

function buildHeadline(
    mode: TodayMode,
    items: TodayDecisionItem[],
    overnightHeadline: string | null,
): string {
    if (mode === 'PREOPEN') {
        const top = items[0];
        const base = top
            ? `盤前預備名單 ${items.length} 檔，最前面是 ${top.symbol} ${top.name}`
            : '盤前名單尚未就緒';
        return overnightHeadline ? `${base}。${overnightHeadline}` : base;
    }
    if (mode === 'AFTER_HOURS') {
        return overnightHeadline
            ? `目前非交易時段。${overnightHeadline}`
            : '目前非交易時段，等開盤後才有即時判斷';
    }
    if (mode === 'OPENING') {
        const watch = items.filter((i) => i.action === 'WATCH');
        if (watch.length) {
            const top = watch[0]!;
            return `開盤確認中 ${watch.length} 檔值得看，最前面是 ${top.symbol} ${top.name}`;
        }
        if (items.length) {
            return `開盤前 30 分鐘名單 ${items.length} 檔，先等確認不要急`;
        }
        return '開盤名單尚未就緒，稍候';
    }

    const actionable = items.filter((i) => i.action === 'ACTIONABLE');
    if (actionable.length) {
        const top = actionable[0]!;
        return `現在有 ${actionable.length} 檔條件齊全，最優先是 ${top.symbol} ${top.name}`;
    }
    const watch = items.filter((i) => i.action === 'WATCH');
    if (watch.length) {
        const top = watch[0]!;
        return `目前沒有完全確認的標的，${watch.length} 檔觀察中，最接近的是 ${top.symbol} ${top.name}`;
    }
    return '目前沒有值得進場的標的，建議空手等待';
}

export function buildTodayBoard(input: TodayBoardInput): TodayDecisionBoard {
    const limit = input.limit ?? 12;

    const scored: TodayDecisionItem[] = input.items.map((it) => {
        const { action, hint } = resolveAction(it, input.mode);
        return {
            rank: 0,
            symbol: it.symbol,
            name: it.name,
            last_price: it.last_price,
            change_pct: it.change_pct,
            action,
            action_label:
                input.mode === 'AFTER_HOURS'
                    ? '明日預備'
                    : input.mode === 'PREOPEN'
                      ? '盤前觀察'
                      : ACTION_LABEL[action],
            action_hint: hint,
            conviction: conviction(it, action),
            why: buildWhy(it),
            risk: buildRisk(it, input.mode),
            trap_flags: it.trap_flags,
            trap_penalty: it.trap_penalty,
            next_check:
                it.decision_next[0] ?? it.decision_missing[0] ?? null,
            sources: {
                c_score: it.c_score,
                bp_score: it.bp_score,
                heat_score: it.heat_score,
                rank: it.rank,
                focus_rank: it.focus_rank,
                decision_status: it.decision_status,
                momentum_state: it.momentum_state,
                open_confirm:
                    input.mode === 'PREOPEN' || input.mode === 'AFTER_HOURS'
                        ? null
                        : it.open_confirm,
                a_score: it.a_score,
            },
            data_confidence: dataConfidence(it),
        };
    });

    scored.sort((a, b) => {
        const byAction = ACTION_ORDER[a.action] - ACTION_ORDER[b.action];
        if (byAction !== 0) return byAction;
        if (b.conviction !== a.conviction) return b.conviction - a.conviction;
        return a.symbol.localeCompare(b.symbol);
    });

    const counts = {
        actionable: scored.filter((i) => i.action === 'ACTIONABLE').length,
        watch: scored.filter((i) => i.action === 'WATCH').length,
        wait: scored.filter((i) => i.action === 'WAIT').length,
        avoid: scored.filter((i) => i.action === 'AVOID').length,
    };

    const items = scored.slice(0, limit).map((it, idx) => ({
        ...it,
        rank: idx + 1,
    }));

    const dataReady =
        input.items.length > 0 ||
        Boolean(input.mode === 'AFTER_HOURS' && input.overnight?.available);

    return {
        as_of: input.now.toISOString(),
        version: TODAY_DECISION_VERSION,
        mode: input.mode,
        mode_label: MODE_LABEL[input.mode],
        headline: buildHeadline(
            input.mode,
            items,
            input.overnight?.available ? input.overnight.headline : null,
        ),
        market_note: marketNote(
            input.taiwan_regime,
            input.market_breadth_advance_pct,
            input.mode,
        ),
        items,
        counts,
        overnight: input.overnight,
        data_ready: dataReady,
        not_ready_reason: dataReady
            ? null
            : input.mode === 'AFTER_HOURS'
              ? '盤後先看夜盤；明日名單等盤前預備'
              : input.mode === 'PREOPEN'
                ? '盤前名單尚未產生'
                : input.mode === 'OPENING'
                  ? '開盤確認尚未產出，稍候再看'
                  : '盤中批次尚未就緒，稍候再看',
        mutates_strategy: false,
        disclaimer: DISCLAIMER,
    };
}
