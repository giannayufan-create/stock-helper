// src/components/intraday-rank-panel.tsx — C 盤中強攻雷達

import { useEffect, useMemo, useState } from 'react';
import {
    fetchIntradayEvents,
    fetchIntradayRank,
    type IntradayRankItemDto,
} from '../lib/backend';
import { fmtPrice } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './intraday-rank-panel.css';

type Tab = 'strong' | 'heating' | 'pullback';

function stateColor(state: string): string {
    if (state === 'STRONG') return '#34d399';
    if (state === 'HEATING') return '#fbbf24';
    if (state === 'EMERGING') return '#60a5fa';
    if (state === 'COOLING') return '#a3a3a3';
    if (state === 'INVALID') return '#f87171';
    return '#9ca3af';
}

export function IntradayRankPanel({
    onPickCode,
}: {
    onPickCode: (code: string) => void;
}) {
    const [tab, setTab] = useState<Tab>('strong');
    const [items, setItems] = useState<IntradayRankItemDto[]>([]);
    const [events, setEvents] = useState<string[]>([]);
    const [status, setStatus] = useState('載入中…');
    const [error, setError] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const [rank, ev] = await Promise.all([
                    fetchIntradayRank({ limit: 30, includeWatch: true }),
                    fetchIntradayEvents(20),
                ]);
                if (cancelled) return;
                setItems(rank.items ?? []);
                setEvents(
                    (ev.items ?? []).map(
                        (e) =>
                            `${e.event_type} ${e.symbol} #${e.rank ?? '-'}`,
                    ),
                );
                setStatus(
                    `${rank.as_of ? '更新 ' + new Date(rank.as_of).toLocaleTimeString('zh-TW') : ''}｜STRONG ${rank.strong ?? 0}／HEATING ${rank.heating ?? 0}`,
                );
                setError(false);
            } catch {
                if (!cancelled) {
                    setError(true);
                    setStatus('雷達資料暫時無法取得');
                }
            }
        };
        void load();
        const t = setInterval(() => void load(), 5000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, []);

    const view = useMemo(() => {
        const list = [...items];
        if (tab === 'strong') {
            return list.sort(
                (a, b) => b.intraday_score - a.intraday_score,
            );
        }
        if (tab === 'heating') {
            return list.sort(
                (a, b) =>
                    (b.rank_velocity ?? 0) - (a.rank_velocity ?? 0) ||
                    b.heat_score - a.heat_score,
            );
        }
        return list
            .filter(
                (i) =>
                    i.metrics.pullback_state === 'holding' ||
                    i.metrics.pullback_state === 'reclaiming' ||
                    i.metrics.pullback_state === 'pullback',
            )
            .sort(
                (a, b) =>
                    b.metrics.pullback_quality_score -
                        a.metrics.pullback_quality_score ||
                    b.intraday_score - a.intraday_score,
            );
    }, [items, tab]);

    return (
        <div className={styles.wrap}>
            <div className={styles.tabs}>
                {(
                    [
                        ['strong', '現在最強'],
                        ['heating', '正在升溫'],
                        ['pullback', '回踩機會'],
                    ] as const
                ).map(([k, label]) => (
                    <button
                        key={k}
                        type='button'
                        className={tab === k ? styles.tabOn : styles.tabOff}
                        onClick={() => setTab(k)}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <p className={styles.status}>{status}</p>
            {error && (
                <div className={styles.empty}>排行／事件暫時無法取得</div>
            )}
            {!error && view.length === 0 && (
                <div className={styles.empty}>
                    尚無強攻候選（等待 Scanner／訂閱暖機）
                </div>
            )}
            <div className={panel.panelBody}>
                {view.map((it) => (
                    <button
                        type='button'
                        key={it.symbol}
                        className={styles.row}
                        onClick={() => onPickCode(it.symbol)}
                    >
                        <div className={styles.top}>
                            <span className={styles.rank}>#{it.rank}</span>
                            <span className={styles.code}>
                                {it.symbol} {it.name}
                            </span>
                            <span
                                className={styles.state}
                                style={{ color: stateColor(it.state) }}
                            >
                                {it.state}
                            </span>
                        </div>
                        <div className={styles.meta}>
                            <span>C {it.intraday_score}</span>
                            <span>Heat {it.heat_score}</span>
                            <span>
                                Rank{' '}
                                {it.rank_change != null && it.rank_change > 0
                                    ? `+${it.rank_change}`
                                    : (it.rank_change ?? '—')}
                            </span>
                            <span>
                                1m{' '}
                                {it.metrics.return_1m != null
                                    ? `${it.metrics.return_1m >= 0 ? '+' : ''}${it.metrics.return_1m.toFixed(2)}%`
                                    : '—'}
                            </span>
                            <span>
                                Vol×{' '}
                                {it.metrics.volume_acceleration?.toFixed(1) ??
                                    '—'}
                            </span>
                            <span>
                                VWAP{' '}
                                {it.metrics.vwap_pos_pct != null
                                    ? `${it.metrics.vwap_pos_pct >= 0 ? '+' : ''}${it.metrics.vwap_pos_pct.toFixed(1)}%`
                                    : '—'}
                            </span>
                            <span>RS {it.metrics.relative_strength_score}</span>
                            <span>{it.metrics.breakout_type}</span>
                            <span>Chase {it.risk.chase_risk}</span>
                            <span>{it.candidate_origin}</span>
                        </div>
                        {it.events?.length > 0 && (
                            <div className={styles.events}>
                                {it.events.join(' · ')}
                            </div>
                        )}
                        {it.risk.invalid_price != null && (
                            <div className={styles.hint}>
                                Invalid {fmtPrice(it.risk.invalid_price)}
                                {it.data_blocked ? ' · DATA STALE' : ''}
                            </div>
                        )}
                    </button>
                ))}
            </div>
            {events.length > 0 && (
                <div className={styles.eventBar}>
                    {events.slice(0, 6).map((e) => (
                        <span key={e}>{e}</span>
                    ))}
                </div>
            )}
        </div>
    );
}
